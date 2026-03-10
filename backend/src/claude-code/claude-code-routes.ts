import type { FastifyInstance } from 'fastify';
import type { ClaudeCodeManager } from './claude-code-manager';

interface ClaudeCodeIdParams {
  id: string;
}

interface StartClaudeCodeBody {
  cwd?: string;
  model?: 'sonnet' | 'opus' | 'haiku';
}

interface SendInputBody {
  text: string;
}

interface UpdateCwdBody {
  cwd: string;
}

interface UpdateModelBody {
  model: 'sonnet' | 'opus' | 'haiku';
}

export async function registerClaudeCodeRoutes(
  app: FastifyInstance,
  manager: ClaudeCodeManager
): Promise<void> {
  // List all Claude Code sessions
  app.get('/api/claude-code', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    await manager.loadUserSessions(userId);
    const sessions = manager.getAllSessions(userId);
    return { sessions };
  });

  // Start new Claude Code session
  app.post<{ Body: StartClaudeCodeBody }>('/api/claude-code/start', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const { cwd, model } = request.body || {};
      const session = await manager.createSession(userId, cwd || process.cwd(), model || 'sonnet');
      return session;
    } catch (error) {
      // Return 403 for path security errors, 500 for other errors
      const errorMsg = String(error);
      if (errorMsg.includes('Access denied')) {
        reply.code(403).send({ error: errorMsg });
      } else {
        reply.code(500).send({ error: errorMsg });
      }
    }
  });

  // Get specific session
  app.get<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const session = manager.getSession(userId, request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return session;
  });

  // Stream session events (SSE)
  app.get<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/stream', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const session = manager.getSession(userId, request.params.id);
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

    let streamClosed = false;
    const send = (event: string, data: unknown): boolean => {
      if (streamClosed || stream.destroyed || !stream.writable) {
        return false;
      }

      try {
        stream.write(`event: ${event}\n`);
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        streamClosed = true;
        return false;
      }
    };

    // Send existing events as history
    for (const event of session.events) {
      if (!send('event', event)) {
        return;
      }
    }
    if (!send('history-complete', {})) {
      return;
    }

    // Subscribe to new events
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = manager.subscribe(userId, request.params.id, (event) => {
        if (!send('event', event)) {
          cleanup();
        }
      });
    } catch (error) {
      // Session might not exist anymore
      streamClosed = true;
      stream.end();
      return;
    }

    let pingInterval: ReturnType<typeof setInterval> | null = null;

    // Cleanup on close
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      streamClosed = true;
      if (pingInterval) {
        clearInterval(pingInterval);
      }
      if (unsubscribe) unsubscribe();
      if (!stream.destroyed && stream.writableEnded === false) {
        stream.end();
      }
    };

    // Ping to keep connection alive
    pingInterval = setInterval(() => {
      if (!send('ping', {})) {
        cleanup();
      }
    }, 15000);

    stream.on('close', cleanup);
    stream.on('error', cleanup);
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  // Maximum input size for Claude Code prompts (100KB - prompts can be longer than terminal commands)
  const MAX_CLAUDE_INPUT_SIZE = 100 * 1024;

  // Send input to session
  app.post<{ Params: ClaudeCodeIdParams; Body: SendInputBody }>(
    '/api/claude-code/:id/input',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      try {
        const { text } = request.body || {};
        if (!text) {
          return reply.code(400).send({ error: 'Text is required' });
        }
        // Validate input length
        if (text.length > MAX_CLAUDE_INPUT_SIZE) {
          return reply.code(400).send({ error: 'Text exceeds maximum allowed size (100KB)' });
        }
        await manager.sendInput(userId, request.params.id, text);
        return { success: true };
      } catch (error) {
        reply.code(500).send({ error: String(error) });
      }
    }
  );

  // Restore inactive session
  app.post<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/restore', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      const session = manager.restoreSession(userId, request.params.id);
      return session;
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Stop session (keep history)
  app.post<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id/stop', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      manager.stopSession(userId, request.params.id);
      return { success: true };
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Delete session
  app.delete<{ Params: ClaudeCodeIdParams }>('/api/claude-code/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    try {
      await manager.deleteSession(userId, request.params.id);
      return { success: true };
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  // Update session cwd
  app.patch<{ Params: ClaudeCodeIdParams; Body: UpdateCwdBody }>(
    '/api/claude-code/:id/cwd',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      try {
        const { cwd } = request.body || {};
        if (!cwd) {
          return reply.code(400).send({ error: 'cwd is required' });
        }
        const session = await manager.updateCwd(userId, request.params.id, cwd);
        return session;
      } catch (error) {
        // Return 403 for path security errors, 500 for other errors
        const errorMsg = String(error);
        if (errorMsg.includes('Access denied')) {
          reply.code(403).send({ error: errorMsg });
        } else {
          reply.code(500).send({ error: errorMsg });
        }
      }
    }
  );

  // Update session model
  app.patch<{ Params: ClaudeCodeIdParams; Body: UpdateModelBody }>(
    '/api/claude-code/:id/model',
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) {
        reply.code(401).send({ error: 'Unauthorized' });
        return;
      }
      try {
        const { model } = request.body || {};
        if (!model) {
          return reply.code(400).send({ error: 'model is required' });
        }
        const session = manager.updateModel(userId, request.params.id, model);
        return session;
      } catch (error) {
        reply.code(500).send({ error: String(error) });
      }
    }
  );
}
