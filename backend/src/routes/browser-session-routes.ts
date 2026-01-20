/**
 * Browser Session Management Routes
 *
 * API endpoints for creating, managing, and switching between browser sessions.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionManager } from '../browser/session-manager.js';
import { DEFAULT_SESSION_CONFIG } from '../browser/session-types.js';

// Singleton session manager instance
let sessionManager: SessionManager | null = null;

/**
 * Get or create session manager
 */
function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(DEFAULT_SESSION_CONFIG);
    sessionManager.start();
  }
  return sessionManager;
}

/**
 * Stop session manager (for cleanup)
 */
export async function stopSessionManager(): Promise<void> {
  if (sessionManager) {
    await sessionManager.stop();
    sessionManager = null;
  }
}

export async function registerBrowserSessionRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /api/browser/sessions
   * Create a new browser session
   */
  app.post('/api/browser/sessions', async (request: FastifyRequest<{
    Body: { name?: string }
  }>, reply: FastifyReply) => {
    try {
      const manager = getSessionManager();
      const session = await manager.createSession(request.body.name);

      return reply.send({
        success: true,
        session
      });
    } catch (err: any) {
      return reply.code(500).send({
        success: false,
        error: err.message
      });
    }
  });

  /**
   * GET /api/browser/sessions
   * List all browser sessions
   */
  app.get('/api/browser/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getSessionManager();
    const sessions = manager.getSessions();

    return reply.send({
      success: true,
      sessions,
      stats: manager.getStats()
    });
  });

  /**
   * GET /api/browser/sessions/:id
   * Get session details
   */
  app.get('/api/browser/sessions/:id', async (request: FastifyRequest<{
    Params: { id: string }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const session = manager.getSession(request.params.id);

    if (!session) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    return reply.send({
      success: true,
      session
    });
  });

  /**
   * PUT /api/browser/sessions/:id
   * Update session metadata
   */
  app.put('/api/browser/sessions/:id', async (request: FastifyRequest<{
    Params: { id: string };
    Body: { name?: string; currentUrl?: string }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const success = manager.updateSession(request.params.id, request.body);

    if (!success) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    const session = manager.getSession(request.params.id);
    return reply.send({
      success: true,
      session
    });
  });

  /**
   * PUT /api/browser/sessions/:id/activate
   * Set session as active (switches to this session)
   */
  app.put('/api/browser/sessions/:id/activate', async (request: FastifyRequest<{
    Params: { id: string }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const success = manager.setActiveSession(request.params.id);

    if (!success) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    const session = manager.getSession(request.params.id);
    return reply.send({
      success: true,
      session
    });
  });

  /**
   * DELETE /api/browser/sessions/:id
   * Close and delete a session
   */
  app.delete('/api/browser/sessions/:id', async (request: FastifyRequest<{
    Params: { id: string }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const success = await manager.closeSession(request.params.id);

    if (!success) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    return reply.send({
      success: true,
      message: 'Session closed'
    });
  });

  /**
   * GET /api/browser/sessions/:id/logs
   * Get logs for a session
   */
  app.get('/api/browser/sessions/:id/logs', async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: {
      type?: 'console' | 'error' | 'network';
      since?: string;
      limit?: string;
    }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const session = manager.getSession(request.params.id);

    if (!session) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    const options = {
      type: request.query.type,
      since: request.query.since ? parseInt(request.query.since, 10) : undefined,
      limit: request.query.limit ? parseInt(request.query.limit, 10) : undefined
    };

    const logs = manager.getLogs(request.params.id, options);

    return reply.send({
      success: true,
      logs,
      count: logs.length
    });
  });

  /**
   * DELETE /api/browser/sessions/:id/logs
   * Clear logs for a session
   */
  app.delete('/api/browser/sessions/:id/logs', async (request: FastifyRequest<{
    Params: { id: string }
  }>, reply: FastifyReply) => {
    const manager = getSessionManager();
    const session = manager.getSession(request.params.id);

    if (!session) {
      return reply.code(404).send({
        success: false,
        error: 'Session not found'
      });
    }

    manager.clearLogs(request.params.id);

    return reply.send({
      success: true,
      message: 'Logs cleared'
    });
  });

  /**
   * GET /api/browser/stats
   * Get browser system stats
   */
  app.get('/api/browser/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    const manager = getSessionManager();
    const stats = manager.getStats();

    return reply.send({
      success: true,
      stats
    });
  });
}

// Export session manager accessor for other modules
export function getSessionManagerInstance(): SessionManager | null {
  return sessionManager;
}
