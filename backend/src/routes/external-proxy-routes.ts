import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Headers to skip when forwarding
const SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'http2-settings'
]);

// Max response size: 10MB
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Request timeout: 30 seconds
const REQUEST_TIMEOUT = 30000;

// Debug script for external sites - sends logs to /api/preview/external/logs
const EXTERNAL_DEBUG_SCRIPT = `
<script>
(function() {
  if (window.__previewDebugInjected) return;
  window.__previewDebugInjected = true;

  // Get the session ID from the URL if present
  const urlParams = new URLSearchParams(window.location.search);
  const SESSION = urlParams.get('_session') || 'default';

  // Send logs to main API endpoint
  const API_URL = '/api/preview/external/logs';
  const pendingLogs = [];
  let flushTimeout = null;

  // Send logs to backend (batched)
  function flushLogs() {
    if (pendingLogs.length === 0) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    try {
      navigator.sendBeacon(API_URL, JSON.stringify({ logs: batch, session: SESSION }));
    } catch (e) {
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch, session: SESSION }),
        keepalive: true
      }).catch(() => {});
    }
  }

  function queueLog(entry) {
    entry.session = SESSION;
    pendingLogs.push(entry);
    try {
      window.parent.postMessage({ type: 'preview-' + entry.type, ...entry }, '*');
    } catch {}
    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(flushLogs, 100);
  }

  // Serialize console arguments
  function serialize(args) {
    return args.map(function(arg) {
      if (arg === null) return 'null';
      if (arg === undefined) return 'undefined';
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
      if (arg instanceof Error) return arg.stack || arg.message;
      try { return JSON.stringify(arg, null, 2); }
      catch (e) { return String(arg); }
    }).join(' ');
  }

  // Console capture
  var origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };

  ['log', 'warn', 'error', 'info', 'debug'].forEach(function(level) {
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      queueLog({
        type: 'console',
        level: level,
        message: serialize(args),
        timestamp: Date.now()
      });
      origConsole[level].apply(console, args);
    };
  });

  // Error capture
  window.addEventListener('error', function(event) {
    queueLog({
      type: 'error',
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error ? event.error.stack : null,
      timestamp: Date.now()
    });
  });

  window.addEventListener('unhandledrejection', function(event) {
    var reason = event.reason;
    var message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    queueLog({
      type: 'error',
      message: 'Unhandled Promise Rejection: ' + message,
      stack: reason && reason.stack ? reason.stack : null,
      timestamp: Date.now()
    });
  });

  // Flush on page unload
  window.addEventListener('beforeunload', flushLogs);
  window.addEventListener('pagehide', flushLogs);
})();
</script>
`;

function isValidExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    // Block localhost and private IPs (those should use the preview subdomain)
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      return false;
    }
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function registerExternalProxyRoutes(app: FastifyInstance): Promise<void> {
  // Store logs from external sites
  const externalLogs: Array<{ session: string; log: any }> = [];
  const MAX_LOGS = 500;

  // Receive logs from external sites
  app.post('/api/preview/external/logs', {
    config: { skipAuth: true }
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { logs?: any[]; session?: string };
    const session = body.session || 'default';
    const logs = Array.isArray(body.logs) ? body.logs : (body.logs ? [body.logs] : []);

    for (const log of logs) {
      externalLogs.push({ session, log });
      if (externalLogs.length > MAX_LOGS) {
        externalLogs.shift();
      }
    }

    return { success: true, count: logs.length };
  });

  // Get logs from external sites
  app.get('/api/preview/external/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { session?: string; limit?: string; since?: string };
    const session = query.session;
    const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
    const since = parseInt(query.since || '0', 10) || 0;

    let logs = externalLogs;
    if (session) {
      logs = logs.filter(l => l.session === session);
    }
    if (since > 0) {
      logs = logs.filter(l => l.log.timestamp > since);
    }
    logs = logs.slice(-limit);

    return {
      count: logs.length,
      logs: logs.map(l => l.log)
    };
  });

  // Clear logs
  app.delete('/api/preview/external/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const cleared = externalLogs.length;
    externalLogs.length = 0;
    return { success: true, cleared };
  });

  // Proxy external websites
  app.get('/api/proxy-external', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { url?: string };
    const targetUrl = query.url;

    if (!targetUrl) {
      return reply.code(400).send({
        error: 'Missing URL',
        message: 'Please provide a URL via the ?url= parameter'
      });
    }

    if (!isValidExternalUrl(targetUrl)) {
      return reply.code(400).send({
        error: 'Invalid URL',
        message: 'URL must be a valid http:// or https:// URL. For localhost URLs, use the preview subdomain.'
      });
    }

    try {
      const parsedUrl = new URL(targetUrl);

      // Build headers to forward
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (!SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }
      // Set correct host for target server
      forwardHeaders['host'] = parsedUrl.host;

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const response = await fetch(targetUrl, {
          method: 'GET',
          headers: forwardHeaders,
          redirect: 'manual',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Set response status
        reply.code(response.status);

        // Forward response headers, stripping security headers that block iframes
        for (const [key, value] of response.headers.entries()) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'transfer-encoding' || lowerKey === 'connection') continue;
          // Remove headers that block iframe embedding
          if (lowerKey === 'x-frame-options') continue;
          if (lowerKey === 'content-security-policy') continue;
          if (lowerKey === 'content-security-policy-report-only') continue;
          // Skip Set-Cookie - handle separately
          if (lowerKey === 'set-cookie') continue;
          reply.header(key, value);
        }

        // Allow iframe embedding
        reply.header('X-Frame-Options', 'ALLOWALL');

        // Set CORS headers
        const origin = request.headers.origin;
        if (origin) {
          reply.header('Access-Control-Allow-Origin', origin);
          reply.header('Access-Control-Allow-Credentials', 'true');
          reply.header('Vary', 'Origin');
        }

        // Prevent caching
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        reply.header('Pragma', 'no-cache');
        reply.header('Expires', '0');

        // Handle redirects - rewrite to go through proxy
        const location = response.headers.get('location');
        if (location && (response.status >= 300 && response.status < 400)) {
          let redirectUrl = location;
          // Convert relative redirects to absolute
          if (location.startsWith('/')) {
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${location}`;
          } else if (!location.startsWith('http://') && !location.startsWith('https://')) {
            // Relative path
            const basePath = parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1);
            redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${basePath}${location}`;
          }
          // Redirect through our proxy
          const proxyRedirect = `/api/proxy-external?url=${encodeURIComponent(redirectUrl)}`;
          reply.header('location', proxyRedirect);
          return reply.send();
        }

        // Read response body with size limit
        if (response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalSize = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalSize += value.length;
            if (totalSize > MAX_RESPONSE_SIZE) {
              return reply.code(413).send({
                error: 'Response too large',
                message: `Response exceeds maximum size of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`
              });
            }
            chunks.push(value);
          }

          const body = Buffer.concat(chunks);
          const contentType = response.headers.get('content-type') || '';

          // For HTML responses, inject debug script and base tag
          if (contentType.includes('text/html')) {
            let html = body.toString('utf-8');

            // Inject base tag for relative URL resolution
            const baseTag = `<base href="${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1)}">`;

            // Inject debug script and base tag into <head>
            if (html.includes('<head>')) {
              html = html.replace('<head>', '<head>' + baseTag + EXTERNAL_DEBUG_SCRIPT);
            } else if (html.includes('<html>')) {
              html = html.replace('<html>', '<html><head>' + baseTag + EXTERNAL_DEBUG_SCRIPT + '</head>');
            } else {
              html = baseTag + EXTERNAL_DEBUG_SCRIPT + html;
            }

            // Rewrite absolute URLs to the same domain to go through proxy
            // This handles links like href="/about" becoming href="/api/proxy-external?url=..."
            const baseOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;

            // Rewrite href attributes for links
            html = html.replace(
              /(<a[^>]*\s)href=(["'])(\/[^"']*)\2/gi,
              (match, prefix, quote, path) => {
                const fullUrl = `${baseOrigin}${path}`;
                return `${prefix}href=${quote}/api/proxy-external?url=${encodeURIComponent(fullUrl)}${quote}`;
              }
            );

            // Rewrite form actions
            html = html.replace(
              /(<form[^>]*\s)action=(["'])(\/[^"']*)\2/gi,
              (match, prefix, quote, path) => {
                const fullUrl = `${baseOrigin}${path}`;
                return `${prefix}action=${quote}/api/proxy-external?url=${encodeURIComponent(fullUrl)}${quote}`;
              }
            );

            reply.send(html);
          } else {
            reply.send(body);
          }
        } else {
          reply.send();
        }

        return reply;
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('aborted') || message.includes('timeout')) {
        return reply.code(504).send({
          error: 'Request timeout',
          message: `Request to ${targetUrl} timed out after ${REQUEST_TIMEOUT / 1000} seconds`
        });
      }

      if (message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('ENOTFOUND')) {
        return reply.code(502).send({
          error: 'Cannot connect',
          message: `Cannot connect to ${targetUrl}. The site may be down or unreachable.`
        });
      }

      return reply.code(500).send({
        error: 'Proxy error',
        message
      });
    }
  });
}
