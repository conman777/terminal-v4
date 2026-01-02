import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Pattern to match preview subdomains: preview-{port}.conordart.com
const PREVIEW_SUBDOMAIN_PATTERN = /^preview-(\d+)\.conordart\.com$/i;

// Headers to skip when forwarding
const SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'http2-settings'
]);

// Debug script injected into HTML pages
// Captures console logs, errors, and network requests
// Sends to both postMessage (browser UI) and backend API (for Claude Code)
const PREVIEW_DEBUG_SCRIPT = `
<script>
(function() {
  if (window.__previewDebugInjected) return;
  window.__previewDebugInjected = true;

  // Extract port and main domain from hostname (preview-{port}.conordart.com)
  const portMatch = location.hostname.match(/^preview-(\\d+)\\.(.+)$/i);
  if (!portMatch) return;
  const PORT = portMatch[1];
  const MAIN_DOMAIN = portMatch[2];

  // Send logs to main domain, not preview subdomain (which proxies to localhost)
  const API_URL = location.protocol + '//' + MAIN_DOMAIN + '/api/preview/' + PORT + '/logs';
  const pendingLogs = [];
  let flushTimeout = null;

  // Send logs to backend (batched)
  function flushLogs() {
    if (pendingLogs.length === 0) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    try {
      navigator.sendBeacon(API_URL, JSON.stringify({ logs: batch }));
    } catch (e) {
      // Fallback to fetch
      fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: batch }),
        keepalive: true
      }).catch(() => {});
    }
  }

  function queueLog(entry) {
    pendingLogs.push(entry);
    // Also send to parent via postMessage for browser UI
    try {
      window.parent.postMessage({ type: 'preview-' + entry.type, ...entry }, '*');
    } catch {}
    // Debounce flush
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

  // Network capture - fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input.url || String(input));
    var method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    var startTime = Date.now();

    return origFetch.apply(this, arguments).then(function(response) {
      var duration = Date.now() - startTime;
      var entry = {
        type: 'network',
        method: method,
        url: url,
        status: response.status,
        statusText: response.statusText,
        duration: duration,
        timestamp: startTime
      };

      // Try to get response preview for errors or JSON
      if (response.status >= 400 || (response.headers.get('content-type') || '').includes('json')) {
        response.clone().text().then(function(text) {
          entry.responsePreview = text.slice(0, 500);
          queueLog(entry);
        }).catch(function() {
          queueLog(entry);
        });
      } else {
        queueLog(entry);
      }

      return response;
    }).catch(function(err) {
      queueLog({
        type: 'network',
        method: method,
        url: url,
        error: err.message,
        duration: Date.now() - startTime,
        timestamp: startTime
      });
      throw err;
    });
  };

  // Network capture - XMLHttpRequest
  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._debugMethod = method;
    this._debugUrl = url;
    return XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var xhr = this;
    var startTime = Date.now();

    xhr.addEventListener('loadend', function() {
      var entry = {
        type: 'network',
        method: xhr._debugMethod || 'GET',
        url: xhr._debugUrl || '',
        status: xhr.status,
        statusText: xhr.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime
      };

      // Get response preview for errors or JSON
      var contentType = xhr.getResponseHeader('content-type') || '';
      if (xhr.status >= 400 || contentType.includes('json')) {
        try {
          entry.responsePreview = (xhr.responseText || '').slice(0, 500);
        } catch (e) {}
      }

      queueLog(entry);
    });

    return XHRSend.apply(this, arguments);
  };

  // Flush on page unload
  window.addEventListener('beforeunload', flushLogs);
  window.addEventListener('pagehide', flushLogs);
})();
</script>
`;

function getPreviewPort(host: string | undefined): number | null {
  if (!host) return null;
  const match = host.match(PREVIEW_SUBDOMAIN_PATTERN);
  if (!match) return null;

  const port = parseInt(match[1], 10);
  // Validate port range
  if (port < 3000 || port > 9999) return null;
  return port;
}

export async function registerPreviewSubdomainRoutes(app: FastifyInstance): Promise<void> {
  // Handle all HTTP requests on preview subdomains
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = getPreviewPort(request.headers.host);
    if (!port) return; // Not a preview subdomain, continue to other routes

    // Store port for WebSocket handler
    (request as any).previewPort = port;

    const targetUrl = `http://localhost:${port}${request.url}`;

    try {
      // Build headers to forward
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (!SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }
      // Set correct host for the target server
      forwardHeaders['host'] = `localhost:${port}`;

      // Set X-Forwarded headers for apps that need to know the original request details
      const originalHost = request.headers.host || `preview-${port}.conordart.com`;
      forwardHeaders['x-forwarded-host'] = originalHost;
      forwardHeaders['x-forwarded-proto'] = 'https';
      forwardHeaders['x-forwarded-port'] = '443';
      forwardHeaders['x-forwarded-for'] = request.ip || '127.0.0.1';

      // Buffer request body for non-GET requests (onRequest runs before body parsing)
      let body: Buffer | undefined = undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of request.raw) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
          forwardHeaders['content-length'] = String(body.length);
        } else {
          delete forwardHeaders['content-length'];
        }
      } else {
        delete forwardHeaders['content-length'];
      }

      // Make proxied request
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual'
      });

      // Set response status
      reply.code(response.status);

      // Forward response headers
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'transfer-encoding' || lowerKey === 'connection') continue;

        // Remove X-Frame-Options to allow iframe embedding
        if (lowerKey === 'x-frame-options') continue;

        // Skip Set-Cookie here - handle separately below
        if (lowerKey === 'set-cookie') continue;

        reply.header(key, value);
      }

      // Handle Set-Cookie headers specially - entries() doesn't handle multiple cookies correctly
      const setCookieHeaders =
        typeof (response.headers as any).getSetCookie === 'function'
          ? (response.headers as any).getSetCookie()
          : (response.headers as any).raw?.()['set-cookie'] ??
            (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
      if (setCookieHeaders.length > 0) {
        reply.header('set-cookie', setCookieHeaders);
      }

      // Allow iframe embedding
      reply.header('X-Frame-Options', 'ALLOWALL');

      // Prevent caching to ensure refresh always fetches fresh content
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');

      // Handle redirects - rewrite Location header
      const location = response.headers.get('location');
      if (location) {
        // Rewrite localhost URLs to preview subdomain
        if (location.startsWith(`http://localhost:${port}`)) {
          const newLocation = location.replace(
            `http://localhost:${port}`,
            `https://preview-${port}.conordart.com`
          );
          reply.header('location', newLocation);
        } else if (location.startsWith('/')) {
          // Relative redirect - keep as is
          reply.header('location', location);
        }
      }

      // Stream response body
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        const body = Buffer.concat(chunks);

        // Extract cache-buster from request URL, or generate one
        const url = new URL(request.url, `http://localhost:${port}`);
        const cacheBuster = url.searchParams.get('_cb') || Date.now().toString();

        // For HTML responses, add cache-busters to all resource URLs
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          let html = body.toString('utf-8');

          // Add cache-buster to src attributes (scripts, images, etc.)
          html = html.replace(
            /(<(?:script|img|source|video|audio|embed|track)[^>]*\s)src=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcUrl) => {
              // Skip external URLs and data URIs
              if (srcUrl.startsWith('http://') || srcUrl.startsWith('https://') ||
                  srcUrl.startsWith('//') || srcUrl.startsWith('data:')) {
                return match;
              }
              const separator = srcUrl.includes('?') ? '&' : '?';
              return `${prefix}src=${quote}${srcUrl}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          // Add cache-buster to href attributes (stylesheets, etc.)
          html = html.replace(
            /(<link[^>]*\s)href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, hrefUrl) => {
              // Skip external URLs and data URIs
              if (hrefUrl.startsWith('http://') || hrefUrl.startsWith('https://') ||
                  hrefUrl.startsWith('//') || hrefUrl.startsWith('data:')) {
                return match;
              }
              const separator = hrefUrl.includes('?') ? '&' : '?';
              return `${prefix}href=${quote}${hrefUrl}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          // Inject debug script at start of <head> to run before app code
          if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + PREVIEW_DEBUG_SCRIPT);
          } else if (html.includes('<html>')) {
            html = html.replace('<html>', '<html><head>' + PREVIEW_DEBUG_SCRIPT + '</head>');
          } else {
            html = PREVIEW_DEBUG_SCRIPT + html;
          }

          reply.send(html);
        } else if (contentType.includes('text/css') || request.url.endsWith('.css') || request.url.includes('.css?')) {
          // For CSS files, rewrite url() references
          let css = body.toString('utf-8');

          // Rewrite url() references
          css = css.replace(
            /url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi,
            (match, quote, urlValue) => {
              // Skip external URLs, data URIs, and already cache-busted URLs
              if (urlValue.startsWith('http://') || urlValue.startsWith('https://') ||
                  urlValue.startsWith('//') || urlValue.startsWith('data:') ||
                  urlValue.includes('_cb=')) {
                return match;
              }
              const separator = urlValue.includes('?') ? '&' : '?';
              return `url(${quote}${urlValue}${separator}_cb=${cacheBuster}${quote})`;
            }
          );

          // Rewrite @import statements
          css = css.replace(
            /@import\s+(["'])([^"']+)\1/gi,
            (match, quote, importUrl) => {
              if (importUrl.startsWith('http://') || importUrl.startsWith('https://') ||
                  importUrl.startsWith('//') || importUrl.includes('_cb=')) {
                return match;
              }
              const separator = importUrl.includes('?') ? '&' : '?';
              return `@import ${quote}${importUrl}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          reply.send(css);
        } else {
          reply.send(body);
        }
      } else {
        reply.send();
      }

      // Return to prevent further processing
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        reply.code(502).send({
          error: 'Dev server not running',
          message: `Cannot connect to localhost:${port}. Make sure your dev server is running.`,
          hint: `Start your dev server on port ${port} and try again.`
        });
        return reply;
      }

      reply.code(500).send({
        error: 'Proxy error',
        message
      });
      return reply;
    }
  });

  // Note: WebSocket proxy for HMR is handled separately via websocket upgrade detection
  // The onRequest hook above handles HTTP requests, but WebSocket upgrades need special handling
}
