import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  terminalCreateRequestSchema,
  terminalInputRequestSchema,
  terminalRenameRequestSchema,
  terminalResizeRequestSchema
} from './schemas';
import { isValidIdentifier } from '../utils/path-security';
import type { CoreRouteDependencies, TerminalIdParams } from './types';

export async function registerTerminalRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  const parseHistoryLimit = (request: { query?: unknown }) => {
    const query = (request.query || {}) as Record<string, string | undefined>;
    const historyChars = Number.parseInt(String(query.historyChars || ''), 10);
    const historyEvents = Number.parseInt(String(query.historyEvents || ''), 10);
    const beforeTs = Number.parseInt(String(query.beforeTs || ''), 10);

    const hasQueryChars = Number.isFinite(historyChars) && historyChars > 0;
    const hasQueryEvents = Number.isFinite(historyEvents) && historyEvents > 0;
    const hasBeforeTs = Number.isFinite(beforeTs) && beforeTs > 0;
    let maxHistoryChars = hasQueryChars ? historyChars : undefined;
    let maxHistoryEvents = hasQueryEvents ? historyEvents : undefined;

    if (!maxHistoryChars && !maxHistoryEvents) {
      const defaultChars = Number.parseInt(process.env.TERMINAL_HISTORY_CHARS || '5000000', 10);
      const defaultEvents = Number.parseInt(process.env.TERMINAL_HISTORY_EVENTS || '20000', 10);
      if (Number.isFinite(defaultChars) && defaultChars > 0) {
        maxHistoryChars = defaultChars;
      }
      if (Number.isFinite(defaultEvents) && defaultEvents > 0) {
        maxHistoryEvents = defaultEvents;
      }
    }

    return {
      maxHistoryChars,
      maxHistoryEvents,
      beforeTs: hasBeforeTs ? beforeTs : undefined
    };
  };

  const shouldSendHistory = (request: { query?: unknown }) => {
    const query = (request.query || {}) as Record<string, string | undefined>;
    const raw = String(query.history || '').toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'no') {
      return false;
    }
    return true;
  };

  app.get('/api/terminal', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    await deps.terminalManager.loadUserSessions(userId);
    reply.send({ sessions: deps.terminalManager.listSessions(userId) });
  });

  // Consolidated state endpoint - fetches sessions, project info, and Claude sessions in one request
  app.get('/api/state', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const activeSessionId = request.query.sessionId as string | undefined;

    // Fetch all state in parallel for optimal performance
    const [sessions, projectInfo, claudeCodeSessions] = await Promise.all([
      // Load and list terminal sessions
      deps.terminalManager.loadUserSessions(userId).then(() =>
        deps.terminalManager.listSessions(userId)
      ),

      // Get project info only if we have an active session
      activeSessionId
        ? deps.terminalManager.getProjectInfo(userId, activeSessionId).catch(() => null)
        : Promise.resolve(null),

      // List Claude Code sessions
      deps.claudeCodeManager.listSessions(userId)
    ]);

    reply.send({
      sessions: sessions || [],
      projectInfo: projectInfo || null,
      claudeCodeSessions: claudeCodeSessions || []
    });
  });

  app.post('/api/terminal', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalCreateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid terminal request body',
        details: result.error.flatten()
      });
      return;
    }

    const session = deps.terminalManager.createSession(userId, result.data);
    reply.code(201).send({
      session: {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        usesTmux: session.usesTmux
      }
    });
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/history', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const historyLimits = parseHistoryLimit(request);
    const snapshot = deps.terminalManager.getSession(userId, request.params.id, {
      ...historyLimits,
      includeHistory: true
    });
    if (!snapshot) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    reply.send(snapshot);
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/project-info', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const projectInfo = await deps.terminalManager.getProjectInfo(userId, request.params.id);
    if (!projectInfo) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    reply.send(projectInfo);
  });

  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/input', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalInputRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid terminal input body',
        details: result.error.flatten()
      });
      return;
    }

    try {
      deps.terminalManager.write(userId, request.params.id, result.data.command);
    } catch (error) {
      reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    reply.code(204).send();
  });

  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/resize', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalResizeRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid resize body',
        details: result.error.flatten()
      });
      return;
    }

    // Extract optional clientId from body for multi-client dimension tracking
    const body = request.body as { cols: number; rows: number; clientId?: string };
    let clientId = body.clientId;

    // Validate clientId format if provided (defense-in-depth)
    if (clientId && !isValidIdentifier(clientId, 64)) {
      reply.code(400).send({ error: 'Invalid clientId format' });
      return;
    }

    try {
      deps.terminalManager.resize(userId, request.params.id, result.data.cols, result.data.rows, clientId);
    } catch (error) {
      reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    reply.code(204).send();
  });

  app.patch<{ Params: TerminalIdParams }>('/api/terminal/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalRenameRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid terminal update body',
        details: result.error.flatten()
      });
      return;
    }

    try {
      const session = await deps.terminalManager.renameSession(userId, request.params.id, result.data.title);
      if (!session) {
        reply.code(404).send({ error: 'Terminal session not found' });
        return;
      }
      reply.send({ session });
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/stream', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const historyLimits = parseHistoryLimit(request);
    const snapshot = deps.terminalManager.getSession(userId, request.params.id, {
      ...historyLimits,
      includeHistory: true
    });
    if (!snapshot) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }

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
      if (streamClosed) return false;
      try {
        const ok1 = stream.write(`event: ${event}\n`);
        const ok2 = stream.write(`data: ${JSON.stringify(data)}\n\n`);
        return ok1 && ok2;
      } catch {
        streamClosed = true;
        return false;
      }
    };

    // Persisted (inactive) session: send history and immediately end the stream.
    if (!deps.terminalManager.isActive(snapshot.id)) {
      snapshot.history.forEach((entry) => {
        send('data', { text: entry.text, ts: entry.ts });
      });
      send('end', {});
      stream.end();
      return;
    }

    // Buffer events while sending history to prevent race condition
    const bufferedEvents: Array<{ text: string; ts: number } | null> = [];
    let isBuffering = true;

    const unsubscribe = deps.terminalManager.subscribe(userId, snapshot.id, (event) => {
      try {
        if (streamClosed) return;
        if (isBuffering) {
          bufferedEvents.push(event);
          return;
        }
        if (event === null) {
          send('end', {});
          if (!streamClosed) {
            try { stream.end(); } catch { /* ignore */ }
          }
          return;
        }
        send('data', { text: event.text, ts: event.ts });
      } catch {
        streamClosed = true;
      }
    });

    // Send history
    snapshot.history.forEach((entry) => {
      send('data', { text: entry.text, ts: entry.ts });
    });

    // Flush buffered events and switch to live mode
    isBuffering = false;
    for (const event of bufferedEvents) {
      if (event === null) {
        send('end', {});
        stream.end();
        return;
      }
      send('data', { text: event.text, ts: event.ts });
    }

    const keepAlive = setInterval(() => {
      if (streamClosed) {
        clearInterval(keepAlive);
        return;
      }
      send('ping', {});
    }, 15000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      streamClosed = true;
      clearInterval(keepAlive);
      unsubscribe();
    };

    stream.on('close', cleanup);
    stream.on('error', cleanup);
    request.raw.on('close', cleanup);
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/ws', { websocket: true }, (socket, request) => {
    const userId = request.userId;
    if (!userId) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const sendHistory = shouldSendHistory(request);
    const historyLimits = parseHistoryLimit(request);
    const snapshot = deps.terminalManager.getSession(userId, request.params.id, {
      ...historyLimits,
      includeHistory: sendHistory
    });
    if (!snapshot) {
      socket.close(4404, 'Terminal session not found');
      return;
    }

    // Generate unique client ID for this WebSocket connection
    const clientId = randomUUID();

    // Send binary frames for 30-40% bandwidth reduction
    const encoder = new TextEncoder();
    const send = (text: string): boolean => {
      try {
        const buffer = encoder.encode(text);
        socket.send(buffer);
        return true;
      } catch {
        return false;
      }
    };

    // Send clientId to frontend so it can include it in resize requests
    send(JSON.stringify({ type: 'clientId', clientId }));

    if (!deps.terminalManager.isActive(snapshot.id)) {
      if (sendHistory) {
        snapshot.history.forEach((entry) => {
          send(entry.text);
        });
      }
      socket.close(1000, 'Session ended');
      return;
    }

    const heartbeatTimer = setInterval(() => {
      send(JSON.stringify({ type: 'serverPing', ts: Date.now() }));
    }, 15000);

    const bufferedEvents: Array<{ text: string; ts: number } | null> = [];
    let isBuffering = true;

    const unsubscribe = deps.terminalManager.subscribe(userId, snapshot.id, (event) => {
      if (isBuffering) {
        bufferedEvents.push(event);
        return;
      }
      if (event === null) {
        socket.close(1000, 'Session ended');
        return;
      }
      send(event.text);
    });

    if (sendHistory) {
      snapshot.history.forEach((entry) => {
        send(entry.text);
      });
    }

    isBuffering = false;
    for (const event of bufferedEvents) {
      if (event === null) {
        socket.close(1000, 'Session ended');
        return;
      }
      send(event.text);
    }

    const decoder = new TextDecoder();
    socket.on('message', (message) => {
      // Handle both binary and text frames for backward compatibility
      const data = message instanceof Buffer
        ? decoder.decode(message)
        : message.toString();
      if (!data) return;
      if (data.includes('__terminal_ping__')) {
        send('__terminal_pong__');
        return;
      }
      if (data.includes('"type":"ping"') && data.includes('"source":"terminal-client"')) {
        send(JSON.stringify({ type: 'pong', source: 'terminal-client', ts: Date.now() }));
        return;
      }
      try {
        deps.terminalManager.write(userId, request.params.id, data);
      } catch {
        socket.close(1011, 'Write failed');
      }
    });

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      unsubscribe();
      // Remove this client's dimensions when WebSocket disconnects
      deps.terminalManager.removeClient(userId, request.params.id, clientId);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  app.delete<{ Params: TerminalIdParams }>('/api/terminal/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    deps.terminalManager.close(userId, request.params.id);
    reply.code(204).send();
  });

  // Restore a persisted session (creates new PTY, keeps history)
  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/restore', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalResizeRequestSchema.safeParse(request.body);
    const cols = result.success ? result.data.cols : undefined;
    const rows = result.success ? result.data.rows : undefined;

    const session = deps.terminalManager.restoreSession(userId, request.params.id, { cols, rows });
    if (!session) {
      reply.code(404).send({ error: 'Persisted session not found' });
      return;
    }

    reply.send({
      session: {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  });
}
