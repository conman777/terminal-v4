import type { FastifyInstance } from 'fastify';
import type { ClaudeCodeManager } from './claude-code-manager';

interface ClaudeCodeIdParams {
  id: string;
}

interface StartClaudeCodeBody {
  cwd?: string;
}

interface SendInputBody {
  text: string;
}

interface UpdateCwdBody {
  cwd: string;
}

export async function registerClaudeCodeRoutes(
  app: FastifyInstance,
  manager: ClaudeCodeManager
): Promise<void> {
  // List all Claude Code sessions
  app.get('/api/claude-code', async () => {
    const sessions = manager.getAllSessions();
    return { sessions };
  });

  // Start new Claude Code session
  app.post<{ Body: StartClaudeCodeBody }>('/api/claude-code/start', async (request, reply) => {
    try {
      const { cwd } = request.body || {};
      const session = manager.createSession(cwd || process.cwd());
      return session;
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Get specific session
  app.get<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id', async (request, reply) => {
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return session;
  });

  // Stream session events (SSE)
  app.get<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/stream', async (request, reply) => {
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    // Hijack the response for SSE
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

    const send = (event: string, data: unknown) => {
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send existing events as history
    for (const event of session.events) {
      send('event', event);
    }
    send('history-complete', {});

    // Subscribe to new events
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = manager.subscribe(request.params.id, (event) => {
        send('event', event);
      });
    } catch (error) {
      // Session might not exist anymore
      stream.end();
      return;
    }

    // Ping to keep connection alive
    const pingInterval = setInterval(() => {
      send('ping', {});
    }, 15000);

    // Cleanup on close
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(pingInterval);
      if (unsubscribe) unsubscribe();
    };

    stream.on('close', cleanup);
    request.raw.on('close', cleanup);
  });

  // Send input to session
  app.post<{ Params: ClaudeCodeIdParams; Body: SendInputBody }>(
    '/api/claude-code/:id/input',
    async (request, reply) => {
      try {
        const { text } = request.body || {};
        if (!text) {
          return reply.code(400).send({ error: 'Text is required' });
        }
        manager.sendInput(request.params.id, text);
        return { success: true };
      } catch (error) {
        reply.code(500).send({ error: String(error) });
      }
    }
  );

  // Restore inactive session
  app.post<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/restore', async (request, reply) => {
    try {
      const session = manager.restoreSession(request.params.id);
      return session;
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Stop session (keep history)
  app.post<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/stop', async (request, reply) => {
    try {
      manager.stopSession(request.params.id);
      return { success: true };
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Delete session
  app.delete<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id', async (request, reply) => {
    try {
      manager.deleteSession(request.params.id);
      return { success: true };
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Update session cwd
  app.patch<{ Params: ClaudeCodeIdParams; Body: UpdateCwdBody }>(
    '/api/claude-code/:id/cwd',
    async (request, reply) => {
      try {
        const { cwd } = request.body || {};
        if (!cwd) {
          return reply.code(400).send({ error: 'cwd is required' });
        }
        const session = manager.updateCwd(request.params.id, cwd);
        return session;
      } catch (error) {
        reply.code(500).send({ error: String(error) });
      }
    }
  );
}

