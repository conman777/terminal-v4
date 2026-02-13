import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Only forward a strict set of safe request headers to external targets.
const ALLOWED_FORWARD_HEADERS = new Set([
  'accept',
  'accept-language',
  'accept-encoding',
  'cache-control',
  'pragma',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'range'
]);

// Max response size: 10MB
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Request timeout: 30 seconds
const REQUEST_TIMEOUT = 30000;
const PREVIEW_LOCAL_ONLY = process.env.PREVIEW_LOCAL_ONLY === 'true';

// Debug script for external sites - sends logs to /api/preview/external/logs
const EXTERNAL_DEBUG_SCRIPT = `
<script>
(function() {
  if (window.__previewDebugInjected) return;
  window.__previewDebugInjected = true;

  // Get the session ID from the URL if present
  const urlParams = new URLSearchParams(window.location.search);
  const SESSION = urlParams.get('_session') || 'default';
  const TOKEN = urlParams.get('token');

  // Send logs to main API endpoint
  const API_URL = TOKEN
    ? '/api/preview/external/logs?token=' + encodeURIComponent(TOKEN)
    : '/api/preview/external/logs';
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

function isPrivateIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
      return true;
    }

    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase().split('%')[0];
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(normalized)) return true; // Link-local fe80::/10

    // IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1)
    const mappedMatch = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedMatch && mappedMatch[1]) {
      return isPrivateIpAddress(mappedMatch[1]);
    }
    return false;
  }

  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '0.0.0.0' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

async function isValidExternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }

    // Block localhost and private/reserved IPs (those should use preview routes)
    const hostname = parsed.hostname;
    if (isBlockedHostname(hostname)) {
      return false;
    }

    if (isIP(hostname) && isPrivateIpAddress(hostname)) {
      return false;
    }

    // Resolve hostnames and reject if they resolve to private/reserved ranges.
    const records = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (records.some((record) => isPrivateIpAddress(record.address))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getRequestToken(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown>;
  if (typeof query.token === 'string' && query.token.length > 0) {
    return query.token;
  }
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

function buildProxyExternalUrl(targetUrl: string, token: string | null): string {
  const params = new URLSearchParams({ url: targetUrl });
  if (token) {
    params.set('token', token);
  }
  return `/api/proxy-external?${params.toString()}`;
}

export async function registerExternalProxyRoutes(app: FastifyInstance): Promise<void> {
  // Store logs from external sites
  const externalLogs: Array<{ userId: string; session: string; log: any }> = [];
  const MAX_LOGS = 500;

  // Receive logs from external sites
  app.post('/api/preview/external/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const body = request.body as { logs?: any[]; session?: string };
    const session = body.session || 'default';
    const logs = Array.isArray(body.logs) ? body.logs : (body.logs ? [body.logs] : []);

    for (const log of logs) {
      externalLogs.push({ userId, session, log });
      if (externalLogs.length > MAX_LOGS) {
        externalLogs.shift();
      }
    }

    return { success: true, count: logs.length };
  });

  // Get logs from external sites
  app.get('/api/preview/external/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const query = request.query as { session?: string; limit?: string; since?: string };
    const session = query.session;
    const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
    const since = parseInt(query.since || '0', 10) || 0;

    let logs = externalLogs.filter((entry) => entry.userId === userId);
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
    const userId = request.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const kept: Array<{ userId: string; session: string; log: any }> = [];
    let cleared = 0;
    for (const entry of externalLogs) {
      if (entry.userId === userId) {
        cleared += 1;
      } else {
        kept.push(entry);
      }
    }
    externalLogs.length = 0;
    externalLogs.push(...kept);
    return { success: true, cleared };
  });

  // Proxy external websites
  app.get('/api/proxy-external', async (request: FastifyRequest, reply: FastifyReply) => {
    if (PREVIEW_LOCAL_ONLY) {
      return reply.code(403).send({
        error: 'External proxy disabled',
        message: 'External website proxying is disabled in local-only preview mode.'
      });
    }

    const query = request.query as { url?: string; token?: string };
    const targetUrl = query.url;
    const requestToken = getRequestToken(request);

    if (!targetUrl) {
      return reply.code(400).send({
        error: 'Missing URL',
        message: 'Please provide a URL via the ?url= parameter'
      });
    }

    if (!(await isValidExternalUrl(targetUrl))) {
      return reply.code(400).send({
        error: 'Invalid URL',
        message: 'URL must be a valid public http:// or https:// URL. For local/private network URLs, use the preview route.'
      });
    }

    try {
      const parsedUrl = new URL(targetUrl);

      // Build headers to forward
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        const headerName = key.toLowerCase();
        if (ALLOWED_FORWARD_HEADERS.has(headerName) && typeof value === 'string') {
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
          const proxyRedirect = buildProxyExternalUrl(redirectUrl, requestToken);
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
                return `${prefix}href=${quote}${buildProxyExternalUrl(fullUrl, requestToken)}${quote}`;
              }
            );

            // Rewrite form actions
            html = html.replace(
              /(<form[^>]*\s)action=(["'])(\/[^"']*)\2/gi,
              (match, prefix, quote, path) => {
                const fullUrl = `${baseOrigin}${path}`;
                return `${prefix}action=${quote}${buildProxyExternalUrl(fullUrl, requestToken)}${quote}`;
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
