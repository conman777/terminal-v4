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

      // Get request body for non-GET requests
      let body: any = undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        body = request.body;
        if (body && typeof body === 'object') {
          body = JSON.stringify(body);
        }
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

        reply.header(key, value);
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

          reply.send(html);
        } else if (contentType.includes('javascript') || contentType.includes('application/javascript') ||
                   request.url.endsWith('.js') || request.url.includes('.js?')) {
          // For JavaScript files, rewrite ES module imports to include cache-buster
          let js = body.toString('utf-8');

          // Rewrite static imports: import { x } from './module.js' or import './module.js'
          js = js.replace(
            /(import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?)(["'])(\.[^"']+)\2/g,
            (match, prefix, quote, specifier) => {
              // Skip if already has _cb parameter
              if (specifier.includes('_cb=')) return match;
              const separator = specifier.includes('?') ? '&' : '?';
              return `${prefix}${quote}${specifier}${separator}_cb=${cacheBuster}${quote}`;
            }
          );

          // Rewrite dynamic imports: import('./module.js')
          js = js.replace(
            /import\s*\(\s*(["'])(\.[^"']+)\1\s*\)/g,
            (match, quote, specifier) => {
              if (specifier.includes('_cb=')) return match;
              const separator = specifier.includes('?') ? '&' : '?';
              return `import(${quote}${specifier}${separator}_cb=${cacheBuster}${quote})`;
            }
          );

          reply.send(js);
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
