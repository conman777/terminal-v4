import type { FastifyInstance } from 'fastify';
import type { StructuredSessionManager } from './session-manager';

export async function registerStructuredRoutes(
  app: FastifyInstance,
  manager: StructuredSessionManager
): Promise<void> {
  // ── POST /api/structured/sessions — Create session ──────────────
  app.post('/api/structured/sessions', async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { cwd, provider, model } = request.body as {
      cwd: string;
      provider?: string;
      model?: string;
    };

    if (!cwd || typeof cwd !== 'string') {
      return reply.code(400).send({ error: 'cwd is required' });
    }

    try {
      const session = await manager.createSession(userId, cwd, provider, model);
      return reply.code(201).send(session);
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to create session',
      });
    }
  });

  // ── GET /api/structured/sessions — List sessions ────────────────
  app.get('/api/structured/sessions', async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const sessions = await manager.listSessions(userId);
    return reply.send(sessions);
  });

  // ── GET /api/structured/sessions/:id — Get session ──────────────
  app.get<{ Params: { id: string } }>(
    '/api/structured/sessions/:id',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const session = manager.getSession(userId, request.params.id);
      if (!session) return reply.code(404).send({ error: 'Session not found' });

      return reply.send(session);
    }
  );

  // ── POST /api/structured/sessions/:id/message — Send message ───
  app.post<{ Params: { id: string } }>(
    '/api/structured/sessions/:id/message',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { text } = request.body as { text: string };
      if (!text || typeof text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      // Start sending in background — events flow via WebSocket
      manager.sendMessage(userId, request.params.id, text).catch((err) => {
        console.error(`[structured-routes] sendMessage error:`, err);
      });

      return reply.code(202).send({ status: 'accepted' });
    }
  );

  // ── POST /api/structured/sessions/:id/interrupt ─────────────────
  app.post<{ Params: { id: string } }>(
    '/api/structured/sessions/:id/interrupt',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      manager.interrupt(userId, request.params.id);
      return reply.send({ status: 'ok' });
    }
  );

  // ── POST /api/structured/sessions/:id/approve ───────────────────
  app.post<{ Params: { id: string } }>(
    '/api/structured/sessions/:id/approve',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { approved } = request.body as { approved: boolean };
      manager.approve(userId, request.params.id, Boolean(approved));
      return reply.send({ status: 'ok' });
    }
  );

  // ── DELETE /api/structured/sessions/:id ─────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/api/structured/sessions/:id',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      await manager.deleteSession(userId, request.params.id);
      return reply.send({ status: 'deleted' });
    }
  );

  // ── WebSocket /api/structured/sessions/:id/ws ───────────────────
  app.get<{ Params: { id: string } }>(
    '/api/structured/sessions/:id/ws',
    { websocket: true },
    (socket, request) => {
      const userId = request.userId;
      if (!userId) {
        socket.close(4401, 'Unauthorized');
        return;
      }

      const sessionId = request.params.id;
      const session = manager.getSession(userId, sessionId);
      if (!session) {
        socket.close(4404, 'Session not found');
        return;
      }

      // Send full event history
      for (const event of session.events) {
        if (socket.readyState !== 1) break;
        socket.send(
          JSON.stringify({
            __terminal_meta: true,
            type: 'structured_event',
            event,
          })
        );
      }

      // Subscribe to live events
      const unsubscribe = manager.subscribe(userId, sessionId, (event) => {
        if (socket.readyState !== 1) return;
        socket.send(
          JSON.stringify({
            __terminal_meta: true,
            type: 'structured_event',
            event,
          })
        );
      });

      // Handle incoming messages (text input, approval responses)
      socket.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'message' && typeof data.text === 'string') {
            manager.sendMessage(userId, sessionId, data.text).catch((err) => {
              console.error('[structured ws] message error:', err);
            });
          } else if (data.type === 'interrupt') {
            manager.interrupt(userId, sessionId);
          } else if (data.type === 'approve') {
            manager.approve(userId, sessionId, Boolean(data.approved));
          }
        } catch {
          // Invalid JSON — ignore
        }
      });

      socket.on('close', () => {
        unsubscribe();
      });
    }
  );
}
