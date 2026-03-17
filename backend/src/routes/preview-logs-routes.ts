/**
 * Preview Logs API Routes
 *
 * Endpoints for storing and retrieving debug logs from preview apps.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  addLogs,
  getLogs,
  clearLogs,
  getLogStats,
  getActivePorts,
  startCleanupInterval,
  stopCleanupInterval,
  type PreviewLogEntry,
  type GetLogsOptions
} from '../preview/preview-logs-service.js';
import { getPreviewScopeIdOrAnonymous, resolvePreviewScopeId } from '../preview/preview-scope.js';

const PREVIEW_SUBDOMAIN_BASES = (process.env.PREVIEW_SUBDOMAIN_BASES || process.env.PREVIEW_SUBDOMAIN_BASE || 'conordart.com,localhost')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PREVIEW_SUBDOMAIN_PATTERN = new RegExp(
  `^preview-\\d+\\.(?:${PREVIEW_SUBDOMAIN_BASES.map(escapeRegExp).join('|')})$`,
  'i'
);

// Validate port number
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function normalizeHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return new URL(`http://${host}`).host.toLowerCase();
  } catch {
    return host.toLowerCase();
  }
}

export function isAllowedPreviewLogOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    const normalizedRequestHost = normalizeHostHeader(requestHost);
    if (normalizedRequestHost && parsed.host.toLowerCase() === normalizedRequestHost) {
      return true;
    }

    return PREVIEW_SUBDOMAIN_PATTERN.test(parsed.hostname);
  } catch {
    return false;
  }
}

function applyPreviewLogCors(reply: FastifyReply, origin: string): void {
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Credentials', 'true');
  reply.header('Vary', 'Origin');
}

export async function registerPreviewLogsRoutes(app: FastifyInstance): Promise<void> {
  const previewLogIngestKey = (process.env.PREVIEW_LOG_INGEST_KEY || '').trim();
  const allowUnauthPreviewLogRead = process.env.ALLOW_UNAUTH_PREVIEW_LOG_READ === 'true';

  // Start cleanup interval when routes are registered
  startCleanupInterval();
  app.addHook('onClose', async () => {
    stopCleanupInterval();
  });

  /**
   * OPTIONS /api/preview/:port/logs - CORS preflight
   */
  app.options('/api/preview/:port/logs', {
    config: { skipAuth: true }
  }, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && isAllowedPreviewLogOrigin(origin, request.headers.host)) {
      applyPreviewLogCors(reply, origin);
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Preview-Log-Key, Authorization');
    }
    return reply.code(204).send();
  });

  /**
   * POST /api/preview/:port/logs
   * Receive logs from injected debug script.
   * Auth is bypassed for iframe compatibility, but an optional shared key can be required.
   */
  app.post('/api/preview/:port/logs', {
    config: { skipAuth: true },
    preHandler: async (request, reply) => {
      // Add CORS headers for cross-origin requests from preview subdomains
      const origin = request.headers.origin;
      if (origin && isAllowedPreviewLogOrigin(origin, request.headers.host)) {
        applyPreviewLogCors(reply, origin);
      }

      if (previewLogIngestKey) {
        const providedKey = Array.isArray(request.headers['x-preview-log-key'])
          ? request.headers['x-preview-log-key'][0]
          : request.headers['x-preview-log-key'];
        if (!providedKey || providedKey !== previewLogIngestKey) {
          reply.code(401).send({ error: 'Unauthorized preview log ingest' });
          return;
        }
      }
    }
  }, async (request: FastifyRequest<{
    Params: { port: string };
    Body: { logs: Omit<PreviewLogEntry, 'id'>[] } | Omit<PreviewLogEntry, 'id'>;
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 1-65535.' });
    }

    const body = request.body;

    // Handle single log or array of logs
    const entries = Array.isArray(body) ? body : (body.logs ? body.logs : [body]);

    if (!entries.length) {
      return reply.code(400).send({ error: 'No log entries provided' });
    }

    // Validate entries have required fields
    for (const entry of entries) {
      if (!entry.type || !entry.timestamp) {
        return reply.code(400).send({ error: 'Each log entry must have type and timestamp' });
      }
    }

    const scopeId = getPreviewScopeIdOrAnonymous(request);
    const added = addLogs(scopeId, port, entries);

    return reply.send({ success: true, count: added.length });
  });

  /**
   * GET /api/preview/:port/logs
   * Get logs for Claude Code to read.
   */
  app.get('/api/preview/:port/logs', {
    ...(allowUnauthPreviewLogRead ? { config: { skipAuth: true } } : {})
  }, async (request: FastifyRequest<{
    Params: { port: string };
    Querystring: {
      type?: 'console' | 'error' | 'network' | 'dom' | 'storage';
      level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
      since?: string;
      limit?: string;
    };
  }>, reply: FastifyReply) => {
    if (!allowUnauthPreviewLogRead && !request.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const scopeId = allowUnauthPreviewLogRead
      ? getPreviewScopeIdOrAnonymous(request)
      : (request.userId ?? resolvePreviewScopeId(request));
    if (!scopeId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 1-65535.' });
    }

    const options: GetLogsOptions = {};

    if (request.query.type) {
      options.type = request.query.type;
    }

    if (request.query.level) {
      options.level = request.query.level;
    }

    if (request.query.since) {
      const since = parseInt(request.query.since, 10);
      if (!isNaN(since)) {
        options.since = since;
      }
    }

    if (request.query.limit) {
      const limit = parseInt(request.query.limit, 10);
      if (!isNaN(limit) && limit > 0 && limit <= 500) {
        options.limit = limit;
      }
    }

    const logs = getLogs(scopeId, port, options);
    const stats = getLogStats(scopeId, port);

    return reply.send({
      port,
      count: logs.length,
      total: stats?.total ?? 0,
      logs
    });
  });

  /**
   * DELETE /api/preview/:port/logs
   * Clear logs for a port (with auth)
   */
  app.delete('/api/preview/:port/logs', async (request: FastifyRequest<{
    Params: { port: string };
  }>, reply: FastifyReply) => {
    if (!request.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 1-65535.' });
    }

    const cleared = clearLogs(request.userId, port);

    return reply.send({ success: true, cleared });
  });

  /**
   * GET /api/preview/logs
   * List all active ports with log counts
   */
  app.get('/api/preview/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const ports = getActivePorts(request.userId);

    return reply.send({
      ports,
      total: ports.reduce((sum, p) => sum + p.count, 0)
    });
  });
}
