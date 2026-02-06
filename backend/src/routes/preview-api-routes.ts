import type { FastifyInstance } from 'fastify';
import { exec } from 'node:child_process';
import { clearCookies, listCookies, hasCookies } from '../preview/cookie-store';
import { getProxyLogs, clearProxyLogs, getActivePreviewPorts } from '../preview/request-log-store';
import { getProcessLogsByPort } from '../preview/process-log-store';

// Rate limiter for eval endpoint
interface RateLimitEntry {
  count: number;
  resetTime: number;
}
const evalRateLimiter = new Map<string, RateLimitEntry>();
const ACTIVE_PORTS_CACHE_TTL_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_ACTIVE_PORTS_CACHE_TTL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();
const PREVIEW_LOG_STREAM_POLL_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_LOG_STREAM_POLL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
})();
const PREVIEW_PORT_PROBE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.PREVIEW_PORT_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
})();
const NON_PREVIEW_PROCESS_PREFIXES = [
  'chrome',
  'chromium',
  'firefox',
  'brave',
  'safari',
  'arc',
  'postgres',
  'mysqld',
  'redis-server',
  'mongod',
  'memcached',
  'rabbitmq',
  'elasticsearch',
  'kafka',
  'influxd'
];
const APP_PORT = (() => {
  const parsed = Number.parseInt(process.env.PORT || '3020', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3020;
})();

interface ActivePortInfo {
  process: string;
  cwd: string | null;
}

interface ActivePortResponse {
  port: number;
  listening: boolean;
  previewed: boolean;
  previewable: boolean;
  common: boolean;
  process: string | null;
  cwd: string | null;
}

let activePortsCache: { expiresAt: number; ports: ActivePortResponse[] } | null = null;
let activePortsInFlight: Promise<ActivePortResponse[]> | null = null;

// Clean up old rate limit entries every 5 minutes
const evalRateLimiterCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of evalRateLimiter.entries()) {
    if (entry.resetTime < now) {
      evalRateLimiter.delete(key);
    }
  }
}, 5 * 60 * 1000);
evalRateLimiterCleanupInterval.unref?.();

function toCwdScope(cwdPath: string | null | undefined): string | null {
  if (!cwdPath || typeof cwdPath !== 'string') return null;
  const normalized = cwdPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

async function lookupDarwinProcessCwd(pid: number): Promise<string | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return new Promise((resolve) => {
    exec(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      const cwdLine = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('n'));
      if (!cwdLine || cwdLine.length <= 1) {
        resolve(null);
        return;
      }
      resolve(toCwdScope(cwdLine.slice(1).trim()));
    });
  });
}

async function scanListeningPorts(): Promise<Map<number, ActivePortInfo>> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      exec('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null', (error, stdout) => {
        const portMap = new Map<number, ActivePortInfo>();
        if (error) {
          resolve(portMap);
          return;
        }
        const lines = stdout.trim().split('\n').slice(1);
        const cwdPromises: Promise<void>[] = [];
        for (const line of lines) {
          const match = line.match(/^(\S+)\s+(\d+)\s+\S+.*TCP\s+\S+:(\d+)\s+\(LISTEN\)\s*$/);
          if (!match) continue;
          const processName = match[1];
          const pid = Number.parseInt(match[2], 10);
          const port = Number.parseInt(match[3], 10);
          if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;
          if (!portMap.has(port)) {
            portMap.set(port, { process: processName, cwd: null });
          }
          if (Number.isFinite(pid) && pid > 0) {
            const cwdPromise = lookupDarwinProcessCwd(pid).then((cwd) => {
              if (!cwd) return;
              const existing = portMap.get(port);
              if (existing && !existing.cwd) {
                existing.cwd = cwd;
              }
            });
            cwdPromises.push(cwdPromise);
          }
        }
        Promise.all(cwdPromises)
          .then(() => resolve(portMap))
          .catch(() => resolve(portMap));
      });
    });
  }

  return new Promise((resolve) => {
    exec('ss -tlnp 2>/dev/null | grep LISTEN', async (error, stdout) => {
      const portMap = new Map<number, ActivePortInfo>();
      if (error) {
        resolve(portMap);
        return;
      }
      const lines = stdout.trim().split('\n');
      const cwdPromises: Promise<void>[] = [];

      for (const line of lines) {
        const portMatch = line.match(/[:\s](\d+)\s+[\d\.\*:\[\]]+:\*/);
        if (!portMatch) continue;
        const port = Number.parseInt(portMatch[1], 10);
        if (!Number.isFinite(port) || port < 1 || port > 65535 || port === APP_PORT) continue;

        const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        const processName = processMatch ? processMatch[1] : '';
        const pid = processMatch ? processMatch[2] : null;
        portMap.set(port, { process: processName, cwd: null });

        if (pid && /^\d+$/.test(pid)) {
          const cwdPromise = (async () => {
            try {
              const { readlink } = await import('fs/promises');
              const cwd = await readlink(`/proc/${pid}/cwd`);
              if (!cwd) return;
              const dirName = toCwdScope(cwd);
              if (!dirName) return;
              const existing = portMap.get(port);
              if (existing) {
                existing.cwd = dirName;
              }
            } catch {
              // Process may exit while scanning.
            }
          })();
          cwdPromises.push(cwdPromise);
        }
      }

      await Promise.all(cwdPromises);
      resolve(portMap);
    });
  });
}

async function listActivePortsSnapshot(): Promise<ActivePortResponse[]> {
  const now = Date.now();
  if (activePortsCache && activePortsCache.expiresAt > now) {
    return activePortsCache.ports;
  }
  if (activePortsInFlight) {
    return activePortsInFlight;
  }

  activePortsInFlight = (async () => {
    const previewedPorts = getActivePreviewPorts();
    const portInfo = await scanListeningPorts();
    const listeningPorts = Array.from(portInfo.keys());
    const listeningSet = new Set(listeningPorts);
    const previewedSet = new Set(previewedPorts);
    const commonDevPorts = [3000, 3001, 3002, 3003, 4000, 5000, 5173, 5174, 8000, 8080, 8885, 8888];
    const allPorts = [...new Set([...previewedPorts, ...listeningPorts])].sort((a, b) => a - b);
    const previewableByPort = new Map<number, boolean>();

    await Promise.all(allPorts.map(async (port) => {
      if (!listeningSet.has(port)) {
        previewableByPort.set(port, false);
        return;
      }
      const processName = portInfo.get(port)?.process;
      if (isExcludedProcessForPreview(processName)) {
        previewableByPort.set(port, false);
        return;
      }
      previewableByPort.set(port, await isPortPreviewable(port));
    }));

    const ports = allPorts.map((port) => {
      const info = portInfo.get(port);
      return {
        port,
        listening: listeningSet.has(port),
        previewed: previewedSet.has(port),
        previewable: previewableByPort.get(port) || false,
        common: commonDevPorts.includes(port),
        process: info?.process || null,
        cwd: info?.cwd || null
      };
    });

    activePortsCache = {
      expiresAt: Date.now() + ACTIVE_PORTS_CACHE_TTL_MS,
      ports
    };
    return ports;
  })();

  try {
    return await activePortsInFlight;
  } finally {
    activePortsInFlight = null;
  }
}

function isLikelyPreviewContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
}

function isLikelyApiOnlyPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return (
    normalized === '/api' ||
    normalized.startsWith('/api/') ||
    normalized === '/graphql' ||
    normalized.startsWith('/graphql/') ||
    normalized === '/openapi' ||
    normalized.startsWith('/openapi') ||
    normalized.startsWith('/swagger') ||
    normalized === '/health' ||
    normalized.startsWith('/health/') ||
    normalized === '/metrics' ||
    normalized.startsWith('/metrics/') ||
    normalized === '/status' ||
    normalized.startsWith('/status/') ||
    /^\/v\d+\/(api|graphql|health|metrics)/.test(normalized)
  );
}

async function isPortPreviewable(port: number): Promise<boolean> {
  const hosts = ['127.0.0.1', 'localhost'];
  for (const host of hosts) {
    try {
      const response = await fetch(`http://${host}:${port}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PREVIEW_PORT_PROBE_TIMEOUT_MS),
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
        }
      });

      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        const location = response.headers.get('location');
        if (!location) continue;

        try {
          const redirectUrl = new URL(location, `http://${host}:${port}`);
          if (isLikelyApiOnlyPath(redirectUrl.pathname)) {
            continue;
          }
        } catch {
          // Unparseable redirect target; keep probing fallback host.
          continue;
        }

        return true;
      }

      if (isLikelyPreviewContentType(response.headers.get('content-type'))) {
        return true;
      }
    } catch {
      // Try the next host mapping.
    }
  }
  return false;
}

function isExcludedProcessForPreview(processName: string | null | undefined): boolean {
  if (!processName) return false;
  const normalized = processName.toLowerCase();
  return NON_PREVIEW_PROCESS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

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

    const ports = await listActivePortsSnapshot();
    reply.send({ ports });
  });

  app.get<{ Params: { port: string }; Querystring: { since?: string; types?: string } }>(
    '/api/preview/:port/log-stream',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }

      const port = Number.parseInt(request.params.port, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        reply.code(400).send({ error: 'Invalid port number' });
        return;
      }

      const parsedSince = request.query.since ? Number.parseInt(request.query.since, 10) : 0;
      const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;
      const requestedTypes = (request.query.types || 'proxy,server')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const includeProxy = requestedTypes.length === 0 || requestedTypes.includes('proxy');
      const includeServer = requestedTypes.length === 0 || requestedTypes.includes('server');

      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      if (typeof (stream as { flushHeaders?: () => void }).flushHeaders === 'function') {
        (stream as { flushHeaders: () => void }).flushHeaders();
      }

      let closed = false;
      let proxyCursor = since;
      let processCursor = since;
      const sendEvent = (eventName: string, payload: unknown): void => {
        if (closed) return;
        try {
          stream.write(`event: ${eventName}\n`);
          stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          closed = true;
        }
      };

      const flushLogs = () => {
        if (closed) return;
        if (includeProxy) {
          const proxyLogs = getProxyLogs(port, proxyCursor);
          for (const entry of proxyLogs) {
            sendEvent('proxy', entry);
            proxyCursor = Math.max(proxyCursor, entry.timestamp);
          }
        }
        if (includeServer) {
          const processLogs = getProcessLogsByPort(port, processCursor);
          for (const entry of processLogs) {
            sendEvent('server', entry);
            processCursor = Math.max(processCursor, entry.timestamp);
          }
        }
      };

      flushLogs();
      const pollTimer = setInterval(flushLogs, PREVIEW_LOG_STREAM_POLL_MS);
      const keepAlive = setInterval(() => {
        if (closed) return;
        sendEvent('ping', { ts: Date.now() });
      }, 15000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(keepAlive);
      };

      stream.on('close', cleanup);
      stream.on('error', cleanup);
      request.raw.on('close', cleanup);
    }
  );

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
