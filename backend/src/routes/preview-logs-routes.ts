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
  type PreviewLogEntry,
  type GetLogsOptions
} from '../preview/preview-logs-service.js';

// Validate port number
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 3000 && port <= 9999;
}

export async function registerPreviewLogsRoutes(app: FastifyInstance): Promise<void> {
  // Start cleanup interval when routes are registered
  startCleanupInterval();

  /**
   * POST /api/preview/:port/logs
   * Receive logs from injected debug script (no auth - called from iframe)
   */
  app.post('/api/preview/:port/logs', {
    config: { skipAuth: true } // No auth required - called from iframe
  }, async (request: FastifyRequest<{
    Params: { port: string };
    Body: { logs: Omit<PreviewLogEntry, 'id'>[] } | Omit<PreviewLogEntry, 'id'>;
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 3000-9999.' });
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

    const added = addLogs(port, entries);

    return reply.send({ success: true, count: added.length });
  });

  /**
   * GET /api/preview/:port/logs
   * Get logs for Claude Code to read (with auth)
   */
  app.get('/api/preview/:port/logs', {
    config: { skipAuth: true } // Allow CLI/unauthenticated access for debugging
  }, async (request: FastifyRequest<{
    Params: { port: string };
    Querystring: {
      type?: 'console' | 'error' | 'network' | 'dom' | 'storage';
      level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
      since?: string;
      limit?: string;
    };
  }>, reply: FastifyReply) => {
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 3000-9999.' });
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

    const logs = getLogs(port, options);
    const stats = getLogStats(port);

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
    const port = parseInt(request.params.port, 10);

    if (!isValidPort(port)) {
      return reply.code(400).send({ error: 'Invalid port. Must be 3000-9999.' });
    }

    const cleared = clearLogs(port);

    return reply.send({ success: true, cleared });
  });

  /**
   * GET /api/preview/logs
   * List all active ports with log counts
   */
  app.get('/api/preview/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const ports = getActivePorts();

    return reply.send({
      ports,
      total: ports.reduce((sum, p) => sum + p.count, 0)
    });
  });
}
