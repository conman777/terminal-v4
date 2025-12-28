import type { FastifyInstance } from 'fastify';
import { pipeline } from 'node:stream/promises';

// Script to inject into HTML pages to capture console logs and errors
const CONSOLE_CAPTURE_SCRIPT = `
<script>
(function() {
  if (window.__devProxyConsoleInjected) return;
  window.__devProxyConsoleInjected = true;

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };

  function serialize(args) {
    return args.map(arg => {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    });
  }

  function sendLog(level, args) {
    try {
      window.parent.postMessage({
        type: 'preview-console',
        level: level,
        message: serialize(args).join(' '),
        timestamp: Date.now()
      }, '*');
    } catch {}
  }

  console.log = function(...args) {
    sendLog('log', args);
    originalConsole.log(...args);
  };
  console.warn = function(...args) {
    sendLog('warn', args);
    originalConsole.warn(...args);
  };
  console.error = function(...args) {
    sendLog('error', args);
    originalConsole.error(...args);
  };
  console.info = function(...args) {
    sendLog('info', args);
    originalConsole.info(...args);
  };
  console.debug = function(...args) {
    sendLog('debug', args);
    originalConsole.debug(...args);
  };

  window.addEventListener('error', function(event) {
    sendLog('error', [event.message + ' at ' + event.filename + ':' + event.lineno + ':' + event.colno]);
  });

  window.addEventListener('unhandledrejection', function(event) {
    const reason = event.reason;
    const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    sendLog('error', ['Unhandled Promise Rejection: ' + message]);
  });
})();
</script>
`;

// Allowed ports for dev server proxy (security: prevent arbitrary port access)
const ALLOWED_PORTS = new Set([
  3000, 3001, 3002, 3003,  // Common React/Next.js ports
  4000, 4200,              // Angular
  5000, 5001, 5173, 5174,  // Vite, Flask
  8000, 8080, 8081, 8888,  // General dev servers
  9000, 9090               // Various
]);

function isPortAllowed(port: number): boolean {
  // Allow any port between 3000-9999 for flexibility
  return port >= 3000 && port <= 9999;
}

export async function registerDevProxyRoutes(app: FastifyInstance): Promise<void> {
  // Proxy HTTP requests to local dev servers
  // Usage: /api/dev-proxy/5173/path/to/resource
  app.all('/api/dev-proxy/:port/*', async (request, reply) => {
    const port = parseInt(request.params.port, 10);
    const path = (request.params as Record<string, string>)['*'] || '';

    if (isNaN(port) || !isPortAllowed(port)) {
      reply.code(400).send({ error: `Port ${port} is not allowed. Use ports 3000-9999.` });
      return;
    }

    const targetUrl = `http://localhost:${port}/${path}`;

    try {
      // Build headers to forward (exclude host-specific headers)
      const forwardHeaders: Record<string, string> = {};
      const skipHeaders = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

      for (const [key, value] of Object.entries(request.headers)) {
        if (!skipHeaders.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }

      // Make the proxied request
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD'
          ? JSON.stringify(request.body)
          : undefined,
        redirect: 'manual'
      });

      // Forward response status
      reply.code(response.status);

      // Forward response headers (with some adjustments)
      const responseHeaders = Object.fromEntries(response.headers.entries());

      // Remove headers that Fastify handles or that would cause issues
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders['connection'];
      delete responseHeaders['keep-alive'];

      // Get auth token from request to preserve in redirects
      const query = request.query as Record<string, string>;
      const token = query.token || '';
      const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';

      // Rewrite Location header for redirects
      if (responseHeaders['location']) {
        const location = responseHeaders['location'];
        // Rewrite localhost URLs in redirects to go through proxy
        if (location.startsWith(`http://localhost:${port}`)) {
          const newPath = location.replace(`http://localhost:${port}`, `/api/dev-proxy/${port}`);
          responseHeaders['location'] = newPath + (newPath.includes('?') ? '&' : '') + (token ? `token=${encodeURIComponent(token)}` : '');
        } else if (location.startsWith('/')) {
          responseHeaders['location'] = `/api/dev-proxy/${port}${location}${tokenSuffix}`;
        }
      }

      // Set response headers
      for (const [key, value] of Object.entries(responseHeaders)) {
        reply.header(key, value);
      }

      // Stream the response body
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const body = Buffer.concat(chunks);

        // Rewrite URLs in HTML/JS content to go through proxy
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          let content = body.toString('utf-8');

          // Get auth token from request to append to rewritten URLs
          const query = request.query as Record<string, string>;
          const token = query.token || '';
          const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';

          // Rewrite absolute localhost URLs
          content = content.replace(
            new RegExp(`(["'])(http://localhost:${port})(/[^"']*)?\\1`, 'g'),
            `$1/api/dev-proxy/${port}$3${tokenSuffix}$1`
          );

          // Rewrite HMR WebSocket URLs for Vite
          content = content.replace(
            new RegExp(`(["'])ws://localhost:${port}(/[^"']*)?\\1`, 'g'),
            `$1wss://${request.headers.host}/api/dev-proxy-ws/${port}$2$1`
          );

          // Rewrite absolute paths (src="/...", href="/...") to go through proxy
          // This handles Vite's asset paths like /assets/index.js
          content = content.replace(
            /(src|href|action)=(["'])\/([^"']*)/g,
            (match, attr, quote, path) => {
              // Don't double-rewrite already proxied paths
              if (path.startsWith('api/dev-proxy')) return match;
              return `${attr}=${quote}/api/dev-proxy/${port}/${path}${tokenSuffix}`;
            }
          );

          // Also handle srcset attributes
          content = content.replace(
            /srcset=(["'])([^"']+)\1/g,
            (match, quote, srcset) => {
              const rewritten = srcset.replace(/\/([^\s,]+)/g, `/api/dev-proxy/${port}/$1${tokenSuffix}`);
              return `srcset=${quote}${rewritten}${quote}`;
            }
          );

          // Inject console capture script to forward logs to parent window
          if (content.includes('</head>')) {
            content = content.replace('</head>', CONSOLE_CAPTURE_SCRIPT + '</head>');
          } else if (content.includes('</body>')) {
            content = content.replace('</body>', CONSOLE_CAPTURE_SCRIPT + '</body>');
          } else {
            // Fallback: prepend to content
            content = CONSOLE_CAPTURE_SCRIPT + content;
          }

          reply.send(content);
        } else {
          reply.send(body);
        }
      } else {
        reply.send();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Check if it's a connection refused error
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        reply.code(502).send({
          error: 'Dev server not running',
          message: `Cannot connect to localhost:${port}. Make sure your dev server is running.`
        });
        return;
      }

      reply.code(500).send({
        error: 'Proxy error',
        message
      });
    }
  });

  // Root path for dev proxy (when accessing /api/dev-proxy/5173 without trailing path)
  app.all('/api/dev-proxy/:port', async (request, reply) => {
    const port = parseInt(request.params.port, 10);

    if (isNaN(port) || !isPortAllowed(port)) {
      reply.code(400).send({ error: `Port ${port} is not allowed. Use ports 3000-9999.` });
      return;
    }

    // Preserve auth token in redirect
    const query = request.query as Record<string, string>;
    const token = query.token || '';
    const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';

    // Redirect to include trailing slash for proper relative URL resolution
    reply.redirect(`/api/dev-proxy/${port}/${tokenSuffix}`);
  });

  // WebSocket proxy for HMR (Hot Module Replacement)
  app.get('/api/dev-proxy-ws/:port', { websocket: true }, (socket, request) => {
    const port = parseInt(request.params.port, 10);

    if (isNaN(port) || !isPortAllowed(port)) {
      socket.close(4400, `Port ${port} is not allowed`);
      return;
    }

    // Connect to the local dev server's WebSocket
    const WebSocket = require('ws');
    const targetWs = new WebSocket(`ws://localhost:${port}`);

    targetWs.on('open', () => {
      // Forward messages from client to dev server
      socket.on('message', (data: Buffer) => {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(data);
        }
      });

      // Forward messages from dev server to client
      targetWs.on('message', (data: Buffer) => {
        if (socket.readyState === 1) { // WebSocket.OPEN
          socket.send(data);
        }
      });
    });

    targetWs.on('error', (error: Error) => {
      console.error(`Dev proxy WS error for port ${port}:`, error.message);
      socket.close(4502, 'Dev server connection failed');
    });

    targetWs.on('close', () => {
      socket.close(1000, 'Dev server closed connection');
    });

    socket.on('close', () => {
      targetWs.close();
    });

    socket.on('error', () => {
      targetWs.close();
    });
  });
}
