import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import WebSocket from 'ws';
import { Readable } from 'node:stream';
import { INSPECTOR_SCRIPT } from '../inspector/inspector-script.js';
import { storeCookies, getCookieHeader, clearCookies, listCookies, hasCookies } from '../preview/cookie-store.js';
import { rewriteSetCookieHeaders } from '../preview/cookie-rewrite.js';
import { addProxyLog, filterHeaders, truncateBody } from '../preview/request-log-store.js';

// Pattern to match preview subdomains: preview-{port}.conordart.com
const PREVIEW_SUBDOMAIN_PATTERN = /^preview-(\d+)\.conordart\.com$/i;
const UNRESTRICTED_PREVIEW = process.env.UNRESTRICTED_PREVIEW === 'true';
const PREVIEW_PORT_RANGE = UNRESTRICTED_PREVIEW ? { min: 1, max: 65535 } : { min: 3000, max: 9999 };

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
  const PREVIEW_ORIGIN = location.origin;

  function isLocalHost(hostname) {
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return true;
    return /^(192\\.168\\.|10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)/.test(hostname);
  }

  function rewritePreviewUrl(rawUrl) {
    try {
      var parsed = new URL(rawUrl, PREVIEW_ORIGIN);
      var hostname = parsed.hostname.toLowerCase();
      if (!isLocalHost(hostname)) return rawUrl;
      if (parsed.port && parsed.port !== String(PORT)) return rawUrl;
      return PREVIEW_ORIGIN + parsed.pathname + parsed.search + parsed.hash;
    } catch (e) {
      return rawUrl;
    }
  }

  function rewriteWebSocketUrl(rawUrl) {
    try {
      var rewritten = rewritePreviewUrl(rawUrl);
      var parsed = new URL(rewritten, PREVIEW_ORIGIN);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      return parsed.toString();
    } catch (e) {
      return rawUrl;
    }
  }

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
    var rewrittenUrl = rewritePreviewUrl(url);
    if (rewrittenUrl !== url) {
      url = rewrittenUrl;
      if (typeof input === 'string') {
        input = rewrittenUrl;
      } else if (input && input instanceof Request) {
        input = new Request(rewrittenUrl, input);
      }
    }

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

    return origFetch.call(this, input, init).then(function(response) {
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

  // WebSocket rewrite for local dev URLs (HMR, live reload, etc.)
  var OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    window.WebSocket = function(url, protocols) {
      var rewrittenUrl = rewriteWebSocketUrl(url);
      if (protocols !== undefined) {
        return new OrigWebSocket(rewrittenUrl, protocols);
      }
      return new OrigWebSocket(rewrittenUrl);
    };
    for (var key in OrigWebSocket) {
      window.WebSocket[key] = OrigWebSocket[key];
    }
    window.WebSocket.prototype = OrigWebSocket.prototype;
  }

  // Network capture - XMLHttpRequest
  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;
  var XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._debugMethod = method;
    var rewrittenUrl = rewritePreviewUrl(url);
    this._debugUrl = rewrittenUrl;
    this._debugHeaders = {};
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrittenUrl;
    return XHROpen.apply(this, args);
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
  if (Number.isNaN(port) || port < PREVIEW_PORT_RANGE.min || port > PREVIEW_PORT_RANGE.max) return null;
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

function shouldSkipRewrite(urlValue: string): boolean {
  return (
    urlValue.startsWith('http://') ||
    urlValue.startsWith('https://') ||
    urlValue.startsWith('//') ||
    urlValue.startsWith('data:') ||
    urlValue.startsWith('/_next/') ||
    urlValue.includes('_cb=')
  );
}

function addCacheBuster(urlValue: string, cacheBuster: string): string {
  const separator = urlValue.includes('?') ? '&' : '?';
  return `${urlValue}${separator}_cb=${cacheBuster}`;
}

function rewriteCssText(
  css: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean }
): string {
  let rewritten = css;
  rewritten = rewritten.replace(
    /url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (match, quote, urlValue) => {
      const normalized = rewriteUrlValue ? rewriteUrlValue(urlValue) : { url: urlValue, skip: shouldSkipRewrite(urlValue) };
      if (normalized.skip) {
        return match;
      }
      return `url(${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote})`;
    }
  );

  rewritten = rewritten.replace(
    /@import\s+(["'])([^"']+)\1/gi,
    (match, quote, importUrl) => {
      const normalized = rewriteUrlValue ? rewriteUrlValue(importUrl) : { url: importUrl, skip: shouldSkipRewrite(importUrl) };
      if (normalized.skip) {
        return match;
      }
      return `@import ${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
    }
  );
  return rewritten;
}

function rewriteSrcset(
  srcset: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean }
): string {
  return srcset
    .split(',')
    .map((segment) => {
      const trimmed = segment.trim();
      if (!trimmed) return '';
      const parts = trimmed.split(/\s+/);
      const urlPart = parts.shift();
      if (!urlPart) {
        return trimmed;
      }
      const normalized = rewriteUrlValue ? rewriteUrlValue(urlPart) : { url: urlPart, skip: shouldSkipRewrite(urlPart) };
      if (normalized.skip) {
        return trimmed;
      }
      return [addCacheBuster(normalized.url, cacheBuster), ...parts].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

function rewriteJsImports(
  js: string,
  cacheBuster: string,
  rewriteUrlValue?: (urlValue: string) => { url: string; skip: boolean }
): string {
  const rewriteSpecifier = (specifier: string) => {
    const normalized = rewriteUrlValue ? rewriteUrlValue(specifier) : { url: specifier, skip: shouldSkipRewrite(specifier) };
    if (normalized.skip) return specifier;
    return addCacheBuster(normalized.url, cacheBuster);
  };

  let rewritten = js.replace(
    /\b(import|export)\s+[^'"]*?from\s+(["'])([^"']+)\2/gi,
    (match, keyword, quote, specifier) => {
      return match.replace(specifier, rewriteSpecifier(specifier));
    }
  );

  rewritten = rewritten.replace(
    /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/gi,
    (match, quote, specifier) => {
      return `import(${quote}${rewriteSpecifier(specifier)}${quote})`;
    }
  );

  return rewritten;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0') {
    return true;
  }
  return /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lower);
}

function rewriteLocalAbsoluteUrl(urlValue: string, port: number, previewHost: string): string {
  try {
    const parsed = new URL(urlValue);
    if (!isPrivateHostname(parsed.hostname)) {
      return urlValue;
    }
    const targetPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    if (Number.isNaN(targetPort) || targetPort !== port) {
      return urlValue;
    }
    return `https://${previewHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return urlValue;
  }
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
        if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') continue;

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
            defaultSameSite: 'none'
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
        const previewHostForRedirect = previewHost || `preview-${port}.conordart.com`;
        const rewrittenLocation = rewriteLocalAbsoluteUrl(location, port, previewHostForRedirect);
        if (rewrittenLocation !== location) {
          reply.header('location', rewrittenLocation);
        } else if (location.startsWith('/')) {
          // Relative redirect - keep as is
          reply.header('location', location);
        }
      }

      // Stream response body
      let responseBodyBuffer: Buffer | null = null;
      if (response.body) {
        // Extract cache-buster from request URL, or generate one
        const url = new URL(request.url, `http://localhost:${port}`);
        const cacheBuster = url.searchParams.get('_cb') || Date.now().toString();
        const contentType = response.headers.get('content-type') || '';
        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css') || request.url.endsWith('.css') || request.url.includes('.css?');
        const isJs = contentType.includes('javascript') || request.url.endsWith('.js') || request.url.endsWith('.mjs');
        const shouldRewrite = isHtml || isCss || (UNRESTRICTED_PREVIEW && isJs);
        const rewriteUrlValue = (value: string) => {
          const normalized = rewriteLocalAbsoluteUrl(value, port, previewHost);
          const isPreviewHost =
            normalized.startsWith(`https://${previewHost}`) ||
            normalized.startsWith(`http://${previewHost}`);
          if (!isPreviewHost && shouldSkipRewrite(normalized)) {
            return { url: normalized, skip: true };
          }
          return { url: normalized, skip: false };
        };

        if (!shouldRewrite) {
          const nodeStream = Readable.fromWeb(response.body);
          nodeStream.pipe(reply.raw);
          await new Promise<void>((resolve, reject) => {
            nodeStream.on('end', resolve);
            nodeStream.on('error', reject);
            reply.raw.on('close', resolve);
          });
          responseSize = responseSize || 0;
          responseBodyBuffer = null;
          // Continue to logging after streaming completes.
        } else {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }

          responseBodyBuffer = Buffer.concat(chunks);
          const body = responseBodyBuffer;

          if (isHtml) {
            let html = body.toString('utf-8');

          // Add cache-buster to src attributes (scripts, images, etc.)
          html = html.replace(
            /(<(?:script|img|source|video|audio|embed|track|iframe)[^>]*\s)src=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcUrl) => {
              const normalized = rewriteUrlValue(srcUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}src=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );

          // Add cache-buster to srcset attributes
          html = html.replace(
            /(<(?:img|source)[^>]*\s)srcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}srcset=${quote}${rewritten}${quote}`;
            }
          );

          // Add cache-buster to imagesrcset attributes (e.g., link rel=preload)
          html = html.replace(
            /(<link[^>]*\s)imagesrcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}imagesrcset=${quote}${rewritten}${quote}`;
            }
          );

          // Add cache-buster to poster attributes
          html = html.replace(
            /(<video[^>]*\s)poster=(["'])([^"']+)\2/gi,
            (match, prefix, quote, posterUrl) => {
              const normalized = rewriteUrlValue(posterUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}poster=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );

          // Add cache-buster to href attributes (stylesheets, etc.)
          html = html.replace(
            /(<link[^>]*\s)href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, hrefUrl) => {
              const normalized = rewriteUrlValue(hrefUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}href=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );

          // Rewrite navigation links to stay within preview origin
          html = html.replace(
            /(<a[^>]*\s)href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, hrefUrl) => {
              const normalized = rewriteUrlValue(hrefUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}href=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite form actions to stay within preview origin
          html = html.replace(
            /(<form[^>]*\s)action=(["'])([^"']+)\2/gi,
            (match, prefix, quote, actionUrl) => {
              const normalized = rewriteUrlValue(actionUrl);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}action=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite meta refresh URLs
          html = html.replace(
            /<meta[^>]*http-equiv=(["'])refresh\1[^>]*>/gi,
            (match) => {
              const contentMatch = match.match(/content=(["'])([^"']+)\1/i);
              if (!contentMatch) return match;
              const quote = contentMatch[1];
              const contentValue = contentMatch[2];
              const urlMatch = contentValue.match(/url=([^;]+)$/i);
              if (!urlMatch) return match;
              const rawUrl = urlMatch[1].trim();
              const normalized = rewriteUrlValue(rawUrl);
              if (normalized.skip) return match;
              const updatedContent = contentValue.replace(urlMatch[1], normalized.url);
              return match.replace(contentMatch[0], `content=${quote}${updatedContent}${quote}`);
            }
          );

          // Rewrite common data-* URL attributes used by lazy loaders
          html = html.replace(
            /(\s)data-src=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataSrc) => {
              const normalized = rewriteUrlValue(dataSrc);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-src=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-poster=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataPoster) => {
              const normalized = rewriteUrlValue(dataPoster);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-poster=${quote}${addCacheBuster(normalized.url, cacheBuster)}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-srcset=(["'])([^"']+)\2/gi,
            (match, prefix, quote, srcset) => {
              const rewritten = rewriteSrcset(srcset, cacheBuster, rewriteUrlValue);
              return `${prefix}data-srcset=${quote}${rewritten}${quote}`;
            }
          );
          html = html.replace(
            /(\s)data-href=(["'])([^"']+)\2/gi,
            (match, prefix, quote, dataHref) => {
              const normalized = rewriteUrlValue(dataHref);
              if (normalized.skip) {
                return match;
              }
              return `${prefix}data-href=${quote}${normalized.url}${quote}`;
            }
          );

          // Rewrite inline style attributes with url() references
          html = html.replace(
            /style=(["'])([^"']+)\1/gi,
            (match, quote, styleValue) => {
              if (!styleValue.includes('url(') && !styleValue.includes('@import')) {
                return match;
              }
              return `style=${quote}${rewriteCssText(styleValue, cacheBuster, rewriteUrlValue)}${quote}`;
            }
          );

          // Rewrite <style> blocks
          html = html.replace(
            /<style([^>]*)>([\s\S]*?)<\/style>/gi,
            (match, attrs, cssText) => {
              const rewritten = rewriteCssText(cssText, cacheBuster, rewriteUrlValue);
              return `<style${attrs}>${rewritten}</style>`;
            }
          );

          // Inject debug script and inspector script at start of <head> to run before app code
          // CSS fix for backdrop-filter in iframes - forces proper stacking context
          const backdropFixCSS = `<style>
/* Force stacking context on root elements */
html, body { isolation: isolate; }
/* Ensure elements with backdrop-filter have proper rendering context */
[style*="backdrop-filter"],
[style*="-webkit-backdrop-filter"],
[class*="backdrop"],
[class*="glass"],
[class*="blur"] {
  isolation: isolate !important;
  transform: translateZ(0) !important;
  -webkit-transform: translateZ(0) !important;
  backface-visibility: hidden !important;
  -webkit-backface-visibility: hidden !important;
  will-change: backdrop-filter, transform !important;
}
/* Force GPU layer for elements with blur in Tailwind */
.backdrop-blur, .backdrop-blur-sm, .backdrop-blur-md, .backdrop-blur-lg, .backdrop-blur-xl, .backdrop-blur-2xl, .backdrop-blur-3xl {
  isolation: isolate !important;
  transform: translateZ(0) !important;
  will-change: backdrop-filter !important;
}
</style>`;
          const injectedScripts = backdropFixCSS + PREVIEW_DEBUG_SCRIPT + '<script>' + INSPECTOR_SCRIPT + '</script>';
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
        } else if (isCss) {
          const css = rewriteCssText(body.toString('utf-8'), cacheBuster, rewriteUrlValue);
          reply.header('content-length', String(Buffer.byteLength(css)));
          reply.raw.removeHeader('content-encoding');
          reply.send(css);
        } else if (UNRESTRICTED_PREVIEW && isJs) {
          const js = rewriteJsImports(body.toString('utf-8'), cacheBuster, rewriteUrlValue);
          reply.header('content-length', String(Buffer.byteLength(js)));
          reply.raw.removeHeader('content-encoding');
          reply.send(js);
        } else {
            reply.header('content-length', String(body.byteLength));
            reply.send(body);
          }
          responseSize = body.byteLength;
        }
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
