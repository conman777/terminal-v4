import type { FastifyInstance } from 'fastify';

// Script to inject into HTML pages for URL rewriting and console capture
// PORT_PLACEHOLDER will be replaced with the actual port number
const DEV_PROXY_SCRIPT = `
<script>
(function() {
  if (window.__devProxyInjected) return;
  window.__devProxyInjected = true;

  // Proxy base path - PORT_PLACEHOLDER gets replaced server-side
  const proxyBase = '/api/dev-proxy/PORT_PLACEHOLDER';
  const tokenParam = 'TOKEN_PLACEHOLDER';

  // URL rewriting function
  function rewriteUrl(url) {
    if (!url) return url;
    const urlStr = String(url);
    // Already proxied
    if (urlStr.startsWith(proxyBase)) return urlStr;
    // Absolute URLs to other origins - leave alone
    if (urlStr.match(/^https?:\\/\\//) && !urlStr.includes('localhost:PORT_PLACEHOLDER')) return urlStr;
    // Localhost URLs for this port - rewrite
    if (urlStr.includes('localhost:PORT_PLACEHOLDER')) {
      return urlStr.replace(/https?:\\/\\/localhost:PORT_PLACEHOLDER/, proxyBase);
    }
    // Relative URLs starting with / - prepend proxy base
    if (urlStr.startsWith('/') && !urlStr.startsWith('/api/dev-proxy')) {
      return proxyBase + urlStr;
    }
    return urlStr;
  }

  // 1. Intercept history.pushState and replaceState
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function(state, title, url) {
    return originalPushState(state, title, rewriteUrl(url));
  };

  history.replaceState = function(state, title, url) {
    return originalReplaceState(state, title, rewriteUrl(url));
  };

  // 2. Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = rewriteUrl(input);
    } else if (input instanceof Request) {
      const rewritten = rewriteUrl(input.url);
      if (rewritten !== input.url) {
        input = new Request(rewritten, input);
      }
    }
    return originalFetch(input, init);
  };

  // 3. Intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalXHROpen.call(this, method, rewriteUrl(url), ...rest);
  };

  // 4. FORCE FULL PAGE RELOADS for all internal navigation
  // SPA client-side routing doesn't work through proxies because frameworks
  // read window.location.pathname which shows the proxied path, not the app path.
  // The only reliable solution is to force full page reloads.
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) return;

    // Skip hash-only links (same page anchors)
    if (href.startsWith('#')) return;

    // Skip external links (http://, https://, //)
    if (href.match(/^(https?:)?\\/\\//)) return;

    // Skip javascript: links
    if (href.startsWith('javascript:')) return;

    // Skip already-proxied links
    if (href.startsWith(proxyBase) || href.startsWith('/api/dev-proxy')) return;

    // For all other internal links, force a full page reload through the proxy
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let newUrl = href;
    if (href.startsWith('/')) {
      newUrl = proxyBase + href;
    } else {
      // Relative URL - resolve against current location
      newUrl = proxyBase + '/' + href;
    }

    if (link.target === '_blank') {
      window.open(newUrl, '_blank');
    } else {
      window.location.href = newUrl;
    }
  }, true);  // CAPTURE PHASE - runs before any framework handlers

  // 5. Set base href for relative resource loading (only if not already set)
  if (!document.querySelector('base')) {
    const base = document.createElement('base');
    base.href = proxyBase + '/';
    if (document.head) {
      document.head.prepend(base);
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        if (!document.querySelector('base')) {
          document.head.prepend(base);
        }
      });
    }
  }

  // 6. Console capture - forward logs to parent window
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
      // Note: Fastify parses JSON bodies into objects, so we need to re-stringify them.
      // However, if the body is already a string (e.g., form data), don't double-stringify.
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' && request.body
          ? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body))
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

      // Prevent caching to ensure refresh always fetches fresh content
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');

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

          // Inject dev proxy script (URL rewriting + console capture)
          // Must inject at START of <head> to run before framework code
          const script = DEV_PROXY_SCRIPT
            .replace(/PORT_PLACEHOLDER/g, String(port))
            .replace(/TOKEN_PLACEHOLDER/g, token || '');

          if (content.includes('<head>')) {
            content = content.replace('<head>', '<head>' + script);
          } else if (content.includes('<html>')) {
            content = content.replace('<html>', '<html><head>' + script + '</head>');
          } else {
            // Fallback: prepend to content
            content = script + content;
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

    // Buffer messages until connection opens (fixes resource leak)
    const messageBuffer: Buffer[] = [];
    let isOpen = false;

    // Connection timeout to prevent hanging connections
    const connectionTimeout = setTimeout(() => {
      if (!isOpen) {
        console.error(`Dev proxy WS timeout for port ${port}`);
        socket.close(4504, 'Connection timeout');
        targetWs.close();
      }
    }, 10000);

    // Forward messages from client to dev server (attach immediately, not in 'open')
    socket.on('message', (data: Buffer) => {
      if (isOpen && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data);
      } else if (!isOpen) {
        // Buffer messages until connection opens
        messageBuffer.push(data);
      }
    });

    targetWs.on('open', () => {
      isOpen = true;
      clearTimeout(connectionTimeout);

      // Flush buffered messages
      while (messageBuffer.length > 0) {
        const data = messageBuffer.shift();
        if (data && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(data);
        }
      }

      // Forward messages from dev server to client
      targetWs.on('message', (data: Buffer) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      });
    });

    targetWs.on('error', (error: Error) => {
      clearTimeout(connectionTimeout);
      console.error(`Dev proxy WS error for port ${port}:`, error.message);
      socket.close(4502, 'Dev server connection failed');
    });

    targetWs.on('close', () => {
      clearTimeout(connectionTimeout);
      socket.close(1000, 'Dev server closed connection');
    });

    socket.on('close', () => {
      clearTimeout(connectionTimeout);
      targetWs.close();
    });

    socket.on('error', () => {
      clearTimeout(connectionTimeout);
      targetWs.close();
    });
  });
}
