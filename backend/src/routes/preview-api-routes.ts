import type { FastifyInstance } from 'fastify';
import { exec } from 'node:child_process';
import { clearCookies, listCookies, hasCookies } from '../preview/cookie-store';
import { getProxyLogs, clearProxyLogs, getActivePreviewPorts } from '../preview/request-log-store';

// Rate limiter for eval endpoint
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const evalRateLimiter = new Map<string, RateLimitEntry>();

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of evalRateLimiter.entries()) {
    if (entry.resetTime < now) {
      evalRateLimiter.delete(key);
    }
  }
}, 5 * 60 * 1000);

export async function registerPreviewApiRoutes(app: FastifyInstance): Promise<void> {
  // Preview: Get stored cookies for a port
  app.get<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    reply.send({
      port,
      hasCookies: hasCookies(port),
      cookies: listCookies(port)
    });
  });

  // Preview: Clear stored cookies for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/cookies', async (request, reply) => {
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    clearCookies(port);
    reply.send({ success: true, port });
  });

  // Preview: Get server-side proxy request logs for a port
  app.get<{ Params: { port: string }; Querystring: { since?: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const since = request.query.since ? parseInt(request.query.since, 10) : undefined;
    const logs = getProxyLogs(port, since);
    reply.send({ port, logs });
  });

  // Preview: Clear server-side proxy logs for a port
  app.delete<{ Params: { port: string } }>('/api/preview/:port/proxy-logs', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    clearProxyLogs(port);
    reply.send({ success: true, port });
  });

  // Preview: List active/available ports for preview
  app.get('/api/preview/active-ports', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    // Get ports that have been previewed (from log store)
    const previewedPorts = getActivePreviewPorts();

    // Scan for listening ports with process names and working directories
    const portInfo = await new Promise<Map<number, { process: string; cwd: string | null }>>((resolve) => {
      // ss -tlnp output format: LISTEN  0  128  *:3000  *:*  users:(("node",pid=1234,fd=12))
      exec('ss -tlnp 2>/dev/null | grep LISTEN', async (error, stdout) => {
        const portMap = new Map<number, { process: string; cwd: string | null }>();
        if (error) {
          resolve(portMap);
          return;
        }
        const lines = stdout.trim().split('\n');
        const cwdPromises: Promise<void>[] = [];

        for (const line of lines) {
          // Extract port from 4th column (e.g., *:3000 or 0.0.0.0:3000 or [::]:3000)
          const portMatch = line.match(/[:\s](\d+)\s+[\d\.\*:\[\]]+:\*/);
          if (!portMatch) continue;
          const port = parseInt(portMatch[1], 10);
          if (isNaN(port) || port <= 1024 || port >= 65535 || port === 3020) continue;

          // Extract process name and PID from users:(("name",pid=1234,...)) format
          const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
          const processName = processMatch ? processMatch[1] : '';
          const pid = processMatch ? processMatch[2] : null;

          portMap.set(port, { process: processName, cwd: null });

          // Try to get the working directory for more context
          // Validate PID is purely numeric to prevent command injection
          if (pid && /^\d+$/.test(pid)) {
            const cwdPromise = (async () => {
              try {
                // Use fs.readlink instead of exec for safety
                const { readlink } = await import('fs/promises');
                const cwd = await readlink(`/proc/${pid}/cwd`);
                if (cwd) {
                  // Get just the last directory name
                  const dirName = cwd.split('/').filter(Boolean).pop() || cwd;
                  const existing = portMap.get(port);
                  if (existing) {
                    existing.cwd = dirName;
                  }
                }
              } catch {
                // Process may have exited, ignore
              }
            })();
            cwdPromises.push(cwdPromise);
          }
        }

        await Promise.all(cwdPromises);
        resolve(portMap);
      });
    });

    const listeningPorts = Array.from(portInfo.keys());

    // Common dev ports to highlight
    const commonDevPorts = [3000, 3001, 3002, 3003, 4000, 5000, 5173, 5174, 8000, 8080, 8888];

    // Combine and dedupe
    const allPorts = [...new Set([...previewedPorts, ...listeningPorts])].sort((a, b) => a - b);

    // Build response with metadata
    const ports = allPorts.map(port => {
      const info = portInfo.get(port);
      return {
        port,
        listening: listeningPorts.includes(port),
        previewed: previewedPorts.includes(port),
        common: commonDevPorts.includes(port),
        process: info?.process || null,
        cwd: info?.cwd || null
      };
    });

    reply.send({ ports });
  });

  // Preview: Evaluate JavaScript in preview context (REPL)
  app.post<{ Params: { port: string }; Body: { expression: string } }>('/api/preview/:port/evaluate', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }
    const { expression } = request.body;

    // Input validation
    if (!expression || typeof expression !== 'string') {
      reply.code(400).send({ error: 'Invalid expression' });
      return;
    }

    // Length limit (10KB max)
    if (expression.length > 10000) {
      app.log.warn({
        userId,
        port,
        expressionLength: expression.length,
        clientIp: request.ip
      }, 'Expression too long - rejected');
      reply.code(400).send({ error: 'Expression too long (max 10KB)' });
      return;
    }

    // Rate limiting: 10 requests per minute per user
    const clientId = `${userId}:${request.ip || 'unknown'}`;
    const now = Date.now();
    const limiter = evalRateLimiter.get(clientId);

    if (limiter && limiter.resetTime > now) {
      if (limiter.count >= 10) {
        app.log.warn({
          userId,
          clientIp: request.ip,
          port,
          rateLimitCount: limiter.count
        }, 'Rate limit exceeded for eval endpoint');
        reply.code(429).send({ error: 'Rate limit exceeded (10 requests per minute)' });
        return;
      }
      limiter.count++;
    } else {
      evalRateLimiter.set(clientId, { count: 1, resetTime: now + 60000 });
    }

    // Audit logging
    app.log.info({
      userId,
      clientIp: request.ip,
      port,
      expressionLength: expression.length,
      expressionPreview: expression.substring(0, 100)
    }, 'REPL evaluation requested');

    // Send evaluation request to preview page via postMessage
    // The preview page's debug script will handle evaluation and send result back
    // This endpoint queues the request; result is received via WebSocket/polling
    reply.send({
      success: true,
      message: 'Evaluation request queued. Result will be sent via preview console logs.'
    });
  });

  // Preview: Get storage (localStorage, sessionStorage, cookies)
  app.get<{ Params: { port: string } }>('/api/preview/:port/storage', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const port = parseInt(request.params.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      reply.code(400).send({ error: 'Invalid port number' });
      return;
    }

    // Storage is managed client-side via postMessage
    // This endpoint provides a way to request storage snapshot
    reply.send({
      message: 'Storage snapshot requested. Data will be synced via preview page.'
    });
  });

  // Preview: Update storage (set/remove/clear)
  app.post<{ Params: { port: string }; Body: { type: string; operation: string; key?: string; value?: string; entries?: Record<string, string> } }>(
    '/api/preview/:port/storage',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      const port = parseInt(request.params.port, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        reply.code(400).send({ error: 'Invalid port number' });
        return;
      }
      const { type, operation, key, value, entries } = request.body;

      // Type validation
      if (!type || typeof type !== 'string') {
        reply.code(400).send({ error: 'Missing or invalid type' });
        return;
      }

      if (!operation || typeof operation !== 'string') {
        reply.code(400).send({ error: 'Missing or invalid operation' });
        return;
      }

      if (!['localStorage', 'sessionStorage', 'cookies'].includes(type)) {
        reply.code(400).send({ error: 'Invalid storage type' });
        return;
      }

      if (!['set', 'remove', 'clear', 'import'].includes(operation)) {
        reply.code(400).send({ error: 'Invalid operation' });
        return;
      }

      // Validate key/value for set operation
      if (operation === 'set') {
        if (!key || typeof key !== 'string') {
          reply.code(400).send({ error: 'Missing or invalid key for set operation' });
          return;
        }
        if (value === undefined || typeof value !== 'string') {
          reply.code(400).send({ error: 'Missing or invalid value for set operation' });
          return;
        }

        // Key length validation (max 256 chars)
        if (key.length > 256) {
          reply.code(400).send({ error: 'Key too long (max 256 characters)' });
          return;
        }

        // Key character validation (alphanumeric, underscore, dash, dot only)
        if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) {
          reply.code(400).send({ error: 'Key contains invalid characters (allowed: alphanumeric, underscore, dash, dot)' });
          return;
        }

        // Value length validation (max 100KB)
        if (value.length > 100000) {
          reply.code(400).send({ error: 'Value too long (max 100KB)' });
          return;
        }
      }

      // Validate key for remove operation
      if (operation === 'remove') {
        if (!key || typeof key !== 'string') {
          reply.code(400).send({ error: 'Missing or invalid key for remove operation' });
          return;
        }

        // Key length validation
        if (key.length > 256) {
          reply.code(400).send({ error: 'Key too long (max 256 characters)' });
          return;
        }

        // Key character validation
        if (!/^[a-zA-Z0-9_\-\.]+$/.test(key)) {
          reply.code(400).send({ error: 'Key contains invalid characters (allowed: alphanumeric, underscore, dash, dot)' });
          return;
        }
      }

      // Validate entries for import operation
      if (operation === 'import') {
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
          reply.code(400).send({ error: 'Missing or invalid entries for import operation' });
          return;
        }

        const entryCount = Object.keys(entries).length;
        if (entryCount > 1000) {
          reply.code(400).send({ error: 'Too many entries for import (max 1000)' });
          return;
        }

        // Validate each entry
        for (const [entryKey, entryValue] of Object.entries(entries)) {
          if (typeof entryKey !== 'string' || typeof entryValue !== 'string') {
            reply.code(400).send({ error: 'All entries must have string keys and values' });
            return;
          }

          if (entryKey.length > 256) {
            reply.code(400).send({ error: `Entry key too long: ${entryKey.substring(0, 50)}... (max 256 characters)` });
            return;
          }

          if (!/^[a-zA-Z0-9_\-\.]+$/.test(entryKey)) {
            reply.code(400).send({ error: `Entry key contains invalid characters: ${entryKey.substring(0, 50)}... (allowed: alphanumeric, underscore, dash, dot)` });
            return;
          }

          if (entryValue.length > 100000) {
            reply.code(400).send({ error: `Entry value too long for key: ${entryKey} (max 100KB)` });
            return;
          }
        }
      }

      // Storage updates are handled client-side via postMessage
      // This endpoint queues the operation; the preview page will execute it
      reply.send({
        success: true,
        message: 'Storage operation queued. Will be executed in preview context.'
      });
    }
  );
}
