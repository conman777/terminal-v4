import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import WebSocket from 'ws';
import { INSPECTOR_SCRIPT } from '../inspector/inspector-script.js';
import { storeCookies, getCookieHeader, clearCookies, listCookies, hasCookies } from '../preview/cookie-store.js';
import { rewriteSetCookieHeaders } from '../preview/cookie-rewrite.js';
import { addProxyLog, filterHeaders, truncateBody } from '../preview/request-log-store.js';

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

const WS_SKIP_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol'
]);

function getPreviewHostConstraint(): RegExp {
  return PREVIEW_SUBDOMAIN_PATTERN;
}

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

  // Send logs to code.{domain}, not preview subdomain (which proxies to localhost)
  const API_URL = location.protocol + '//code.' + MAIN_DOMAIN + '/api/preview/' + PORT + '/logs';
  const pendingLogs = [];
  let flushTimeout = null;

  // Send logs to backend (batched)
  function flushLogs() {
    if (pendingLogs.length === 0) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    try {
      navigator.sendBeacon(API_URL, new Blob([JSON.stringify({ logs: batch })], { type: 'application/json' }));
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

  // Max body size for logging (50KB)
  var MAX_BODY_SIZE = 50 * 1024;

  function truncateBody(body) {
    if (!body || body.length <= MAX_BODY_SIZE) return body;
    return body.slice(0, MAX_BODY_SIZE) + '\\n... [truncated at 50KB]';
  }

  function headersToObject(headers) {
    var obj = {};
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach(function(value, key) { obj[key] = value; });
    } else if (headers && typeof headers === 'object') {
      Object.keys(headers).forEach(function(key) { obj[key] = headers[key]; });
    }
    return obj;
  }

  // Network capture - fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input.url || String(input));
    var method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    var startTime = Date.now();

    // Capture request headers
    var requestHeaders = {};
    if (init && init.headers) {
      requestHeaders = headersToObject(init.headers);
    } else if (typeof input === 'object' && input.headers) {
      requestHeaders = headersToObject(input.headers);
    }

    // Capture request body
    var requestBody = null;
    if (init && init.body) {
      if (typeof init.body === 'string') {
        requestBody = truncateBody(init.body);
      } else if (init.body instanceof FormData) {
        requestBody = '[FormData]';
      } else if (init.body instanceof Blob) {
        requestBody = '[Blob: ' + init.body.size + ' bytes]';
      }
    }

    return origFetch.apply(this, arguments).then(function(response) {
      var duration = Date.now() - startTime;

      // Capture response headers
      var responseHeaders = headersToObject(response.headers);
      var contentType = response.headers.get('content-type') || '';

      var entry = {
        type: 'network',
        method: method,
        url: url,
        status: response.status,
        statusText: response.statusText,
        duration: duration,
        timestamp: startTime,
        requestHeaders: requestHeaders,
        responseHeaders: responseHeaders,
        requestBody: requestBody
      };

      // Capture response body for text-based responses
      if (contentType.includes('json') || contentType.includes('text') ||
          contentType.includes('xml') || contentType.includes('javascript')) {
        response.clone().text().then(function(text) {
          entry.responseBody = truncateBody(text);
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
        timestamp: startTime,
        requestHeaders: requestHeaders,
        requestBody: requestBody
      });
      throw err;
    });
  };

  // Network capture - XMLHttpRequest
  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;
  var XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._debugMethod = method;
    this._debugUrl = url;
    this._debugHeaders = {};
    return XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._debugHeaders) {
      this._debugHeaders[name] = value;
    }
    return XHRSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    var startTime = Date.now();
    var requestBody = null;

    if (body) {
      if (typeof body === 'string') {
        requestBody = truncateBody(body);
      } else if (body instanceof FormData) {
        requestBody = '[FormData]';
      } else if (body instanceof Blob) {
        requestBody = '[Blob: ' + body.size + ' bytes]';
      }
    }

    xhr.addEventListener('loadend', function() {
      var responseHeaders = {};
      try {
        var headerStr = xhr.getAllResponseHeaders();
        if (headerStr) {
          headerStr.split('\\r\\n').forEach(function(line) {
            var parts = line.split(': ');
            if (parts.length === 2) {
              responseHeaders[parts[0].toLowerCase()] = parts[1];
            }
          });
        }
      } catch (e) {}

      var contentType = xhr.getResponseHeader('content-type') || '';
      var entry = {
        type: 'network',
        method: xhr._debugMethod || 'GET',
        url: xhr._debugUrl || '',
        status: xhr.status,
        statusText: xhr.statusText,
        duration: Date.now() - startTime,
        timestamp: startTime,
        requestHeaders: xhr._debugHeaders || {},
        responseHeaders: responseHeaders,
        requestBody: requestBody
      };

      // Capture response body for text-based responses
      if (contentType.includes('json') || contentType.includes('text') ||
          contentType.includes('xml') || contentType.includes('javascript')) {
        try {
          entry.responseBody = truncateBody(xhr.responseText || '');
        } catch (e) {}
      }

      queueLog(entry);
    });

    return XHRSend.apply(this, arguments);
  };

  // DOM Snapshot capture
  window.__captureDOM = function() {
    var html = document.documentElement.outerHTML;
    queueLog({
      type: 'dom',
      html: truncateBody(html),
      url: location.href,
      timestamp: Date.now()
    });
    return html.length;
  };

  // Storage Inspector
  function captureStorage() {
    var localStorage_data = {};
    var sessionStorage_data = {};

    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        localStorage_data[key] = truncateBody(localStorage.getItem(key) || '');
      }
    } catch (e) {}

    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var key = sessionStorage.key(i);
        sessionStorage_data[key] = truncateBody(sessionStorage.getItem(key) || '');
      }
    } catch (e) {}

    queueLog({
      type: 'storage',
      localStorage: localStorage_data,
      sessionStorage: sessionStorage_data,
      timestamp: Date.now()
    });
  }

  window.__captureStorage = captureStorage;

  // Capture storage on load and changes
  window.addEventListener('load', function() {
    setTimeout(captureStorage, 1000);
  });

  window.addEventListener('storage', captureStorage);

  // Listen for commands from parent
  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'preview-capture-dom') {
      window.__captureDOM();
    }
    if (event.data && event.data.type === 'preview-capture-storage') {
      window.__captureStorage();
    }
  });

  // Flush on page unload
  window.addEventListener('beforeunload', flushLogs);
  window.addEventListener('pagehide', flushLogs);
})();
</script>
`;

function getPreviewPort(host: string | undefined): number | null {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const match = hostname.match(PREVIEW_SUBDOMAIN_PATTERN);
  if (!match) return null;

  const port = parseInt(match[1], 10);
  // Validate port range
  if (port < 3000 || port > 9999) return null;
  return port;
}

function getPreviewHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.split(':')[0];
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const proto = forwardedProto.split(',')[0]?.trim();
    if (proto === 'https') return true;
  }
  const cfVisitor = request.headers['cf-visitor'];
  if (typeof cfVisitor === 'string' && cfVisitor.includes('"scheme":"https"')) {
    return true;
  }
  return false;
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  const upgradeHeader = request.headers.upgrade;
  if (typeof upgradeHeader === 'string' && upgradeHeader.toLowerCase() === 'websocket') {
    return true;
  }
  const connectionHeader = request.headers.connection;
  if (typeof connectionHeader === 'string' && connectionHeader.toLowerCase().includes('upgrade')) {
    return true;
  }
  return false;
}

function mergeCookieHeaders(requestCookies: string, storedCookies: string): string {
  const merged = new Map<string, string>();

  for (const cookiePart of requestCookies.split(';')) {
    const trimmed = cookiePart.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!merged.has(name)) {
      merged.set(name, value);
    }
  }

  for (const cookiePart of storedCookies.split(';')) {
    const trimmed = cookiePart.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    if (merged.has(name)) continue;
    const value = trimmed.slice(eqIndex + 1).trim();
    merged.set(name, value);
  }

  return Array.from(merged.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function getWebSocketProtocols(request: FastifyRequest): string[] | undefined {
  const protocolHeader = request.headers['sec-websocket-protocol'];
  if (typeof protocolHeader !== 'string') return undefined;
  const protocols = protocolHeader
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return protocols.length > 0 ? protocols : undefined;
}

function buildWebSocketForwardHeaders(request: FastifyRequest, port: number, previewHost: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!WS_SKIP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      headers[key] = value;
    }
  }

  headers['host'] = `localhost:${port}`;
  headers['x-forwarded-host'] = previewHost;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-port'] = '443';
  headers['x-forwarded-for'] = request.ip || '127.0.0.1';

  return headers;
}

function openWebSocket(targetUrl: string, request: FastifyRequest, forwardHeaders: Record<string, string>): WebSocket {
  const protocols = getWebSocketProtocols(request);
  if (protocols) {
    return new WebSocket(targetUrl, protocols, { headers: forwardHeaders });
  }
  return new WebSocket(targetUrl, { headers: forwardHeaders });
}

export async function registerPreviewSubdomainRoutes(app: FastifyInstance): Promise<void> {
  // WebSocket proxy for preview subdomains (HMR, dev tooling, etc.)
  app.get('/*', { websocket: true, constraints: { host: getPreviewHostConstraint() } }, (socket, request) => {
    const port = getPreviewPort(request.headers.host);
    if (!port) {
      socket.close(1008, 'Preview port not found');
      return;
    }

    const previewHost = getPreviewHost(request.headers.host) || `preview-${port}.conordart.com`;
    const targetUrl = `ws://localhost:${port}${request.url}`;
    const forwardHeaders = buildWebSocketForwardHeaders(request, port, previewHost);
    const targetWs = openWebSocket(targetUrl, request, forwardHeaders);

    const closeBoth = (code: number, reason: string) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
      if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
        targetWs.close();
      }
    };

    socket.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary });
      }
    });

    targetWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data, { binary: isBinary });
      }
    });

    targetWs.on('open', () => {
      // no-op, allows queued messages to flush
    });

    targetWs.on('error', (error: Error) => {
      console.error(`Preview WS proxy error for port ${port}:`, error.message);
      closeBoth(1011, 'Preview WebSocket upstream error');
    });

    targetWs.on('close', () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Preview WebSocket upstream closed');
      }
    });

    socket.on('close', () => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close();
      }
    });

    socket.on('error', () => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.close();
      }
    });
  });

  // Handle all HTTP requests on preview subdomains
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const forwardedHost = request.headers['x-forwarded-host'];
    const forwardedHostValue = Array.isArray(forwardedHost)
      ? forwardedHost[0]
      : forwardedHost;
    const rawHost =
      (typeof forwardedHostValue === 'string' ? forwardedHostValue.split(',')[0].trim() : undefined) ||
      (typeof request.headers[':authority'] === 'string' ? request.headers[':authority'] : undefined) ||
      request.headers.host;
    let port = getPreviewPort(rawHost);
    let previewHost = port ? getPreviewHost(rawHost) : null;
    let originHost: string | undefined;
    const origin = request.headers.origin;
    if (!port && typeof origin === 'string') {
      try {
        originHost = new URL(origin).host;
        port = getPreviewPort(originHost);
        if (port) {
          previewHost = getPreviewHost(originHost);
        }
      } catch {
        // Ignore invalid Origin values
      }
    }
    if (!port) return; // Not a preview subdomain, continue to other routes
    if (!previewHost) {
      previewHost = getPreviewHost(rawHost) || getPreviewHost(originHost) || request.headers.host?.split(':')[0] || null;
    }

    if (isWebSocketUpgrade(request)) {
      return;
    }

    // Store port for WebSocket handler
    (request as any).previewPort = port;

    // Handle CORS preflight without proxying upstream
    if (request.method === 'OPTIONS') {
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
      }
      reply.header('Access-Control-Allow-Credentials', 'true');
      const reqMethods = request.headers['access-control-request-method'];
      reply.header(
        'Access-Control-Allow-Methods',
        typeof reqMethods === 'string'
          ? reqMethods
          : 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
      );
      const reqHeaders = request.headers['access-control-request-headers'];
      reply.header(
        'Access-Control-Allow-Headers',
        typeof reqHeaders === 'string'
          ? reqHeaders
          : 'authorization, content-type, x-csrftoken, x-csrf-token'
      );
      reply.code(204).send();
      return reply;
    }

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
      const originalHost = rawHost || originHost || request.headers.host || `preview-${port}.conordart.com`;
      forwardHeaders['x-forwarded-host'] = originalHost;
      forwardHeaders['x-forwarded-proto'] = 'https';
      forwardHeaders['x-forwarded-port'] = '443';
      forwardHeaders['x-forwarded-for'] = request.ip || '127.0.0.1';

      // Inject server-side stored cookies (browser-like cookie jar)
      const requestPath = new URL(request.url, `http://localhost:${port}`).pathname;
      const storedCookies = getCookieHeader(port, requestPath);
      if (storedCookies) {
        // Merge with any cookies from the request (prefer browser cookies)
        const existingCookies = forwardHeaders['cookie'] || '';
        forwardHeaders['cookie'] = existingCookies
          ? mergeCookieHeaders(existingCookies, storedCookies)
          : storedCookies;
      }

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

      // Make proxied request with timing
      const startTime = Date.now();
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual'
      });
      const duration = Date.now() - startTime;

      // Set response status
      reply.code(response.status);

      // Get response info for logging
      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      let responseSize: number = contentLength ? parseInt(contentLength, 10) : 0;
      const requestBodySize = body ? body.byteLength : null;

      // Forward response headers
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'transfer-encoding' || lowerKey === 'connection') continue;
        if (lowerKey === 'content-length') continue;

        // Remove X-Frame-Options to allow iframe embedding
        if (lowerKey === 'x-frame-options') continue;

        // Skip Set-Cookie here - handle separately below
        if (lowerKey === 'set-cookie') continue;

        reply.header(key, value);
      }

      // Allow cross-origin access when preview is embedded elsewhere
      const origin = request.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Vary', 'Origin');
      }

      // Handle Set-Cookie headers specially - entries() doesn't handle multiple cookies correctly
      const setCookieHeaders =
        typeof (response.headers as any).getSetCookie === 'function'
          ? (response.headers as any).getSetCookie()
          : (response.headers as any).raw?.()['set-cookie'] ??
            (response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : []);
      if (setCookieHeaders.length > 0) {
        const rewrittenCookies = previewHost
          ? rewriteSetCookieHeaders(setCookieHeaders, {
            previewHost,
            isSecureRequest: isSecureRequest(request),
            defaultSameSite: 'lax'
          })
          : setCookieHeaders;
        // Store cookies server-side for browser-like behavior in iframe
        storeCookies(port, rewrittenCookies);
        // Forward rewritten cookies to browser for client-side access
        reply.header('set-cookie', rewrittenCookies);
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
      let responseBodyBuffer: Buffer | null = null;
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        responseBodyBuffer = Buffer.concat(chunks);
        const body = responseBodyBuffer;

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
                  srcUrl.startsWith('//') || srcUrl.startsWith('data:') ||
                  srcUrl.startsWith('/_next/')) {
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
                  hrefUrl.startsWith('//') || hrefUrl.startsWith('data:') ||
                  hrefUrl.startsWith('/_next/')) {
                return match;
              }
              const separator = hrefUrl.includes('?') ? '&' : '?';
              return `${prefix}href=${quote}${hrefUrl}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          // Inject debug script and inspector script at start of <head> to run before app code
          const injectedScripts = PREVIEW_DEBUG_SCRIPT + '<script>' + INSPECTOR_SCRIPT + '</script>';
          if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + injectedScripts);
          } else if (html.includes('<html>')) {
            html = html.replace('<html>', '<html><head>' + injectedScripts + '</head>');
          } else {
            html = injectedScripts + html;
          }

          reply.header('content-length', String(Buffer.byteLength(html)));
          reply.raw.removeHeader('content-encoding');
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
                  urlValue.startsWith('/_next/') || urlValue.includes('_cb=')) {
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
                  importUrl.startsWith('//') || importUrl.startsWith('/_next/') ||
                  importUrl.includes('_cb=')) {
                return match;
              }
              const separator = importUrl.includes('?') ? '&' : '?';
              return `@import ${quote}${importUrl}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          reply.header('content-length', String(Buffer.byteLength(css)));
          reply.raw.removeHeader('content-encoding');
          reply.send(css);
        } else {
          reply.header('content-length', String(body.byteLength));
          reply.send(body);
        }
        responseSize = body.byteLength;
      } else {
        reply.send();
        responseSize = 0;
      }

      // Prepare headers for logging (filter sensitive data)
      const requestHeadersForLog = filterHeaders(forwardHeaders);
      const responseHeadersForLog: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeadersForLog[key] = value;
      }
      const filteredResponseHeaders = filterHeaders(responseHeadersForLog);

      // Capture request body for logging (text-based only)
      let requestBodyForLog: string | undefined;
      let requestBodyTruncated = false;
      if (body && requestBodySize && requestBodySize < 100 * 1024) {
        const reqContentType = forwardHeaders['content-type'] || '';
        if (reqContentType.includes('json') || reqContentType.includes('text') ||
            reqContentType.includes('xml') || reqContentType.includes('form-urlencoded')) {
          const { body: truncBody, truncated } = truncateBody(body.toString('utf-8'));
          requestBodyForLog = truncBody;
          requestBodyTruncated = truncated;
        }
      }

      // Capture response body for logging (text-based only)
      let responseBodyForLog: string | undefined;
      let responseBodyTruncated = false;
      const respContentType = response.headers.get('content-type') || '';
      if (respContentType.includes('json') || respContentType.includes('text') ||
          respContentType.includes('xml') || respContentType.includes('javascript')) {
        if (responseBodyBuffer && responseSize && responseSize < 100 * 1024) {
          try {
            const responseBodyText = responseBodyBuffer.toString('utf-8');
            const { body: truncBody, truncated } = truncateBody(responseBodyText);
            responseBodyForLog = truncBody;
            responseBodyTruncated = truncated;
          } catch {
            // Binary or encoding issue, skip
          }
        }
      }

      // Log the successful request with full details
      addProxyLog(port, {
        timestamp: startTime,
        method: request.method,
        url: request.url,
        status: response.status,
        statusText: response.statusText,
        duration,
        requestSize: requestBodySize,
        responseSize,
        contentType,
        error: null,
        requestHeaders: requestHeadersForLog,
        responseHeaders: filteredResponseHeaders,
        requestBody: requestBodyForLog,
        responseBody: responseBodyForLog,
        requestBodyTruncated,
        responseBodyTruncated
      });

      // Return to prevent further processing
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Log the failed request
      addProxyLog(port, {
        timestamp: Date.now(),
        method: request.method,
        url: request.url,
        status: null,
        statusText: null,
        duration: 0,
        requestSize: null,
        responseSize: null,
        contentType: null,
        error: message
      });

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
