import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  terminalCreateRequestSchema,
  terminalGitCheckoutRequestSchema,
  terminalInputRequestSchema,
  terminalRenameRequestSchema,
  terminalResizeRequestSchema
} from './schemas';
import { isValidIdentifier } from '../utils/path-security';
import type { CoreRouteDependencies, TerminalIdParams } from './types';
import { verifyAccessToken, isAllowedUsername } from '../auth/auth-service';
import { getUserSandboxDefaultMode } from './settings-routes';

const TERMINAL_WS_MAX_BUFFERED_BYTES = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_WS_MAX_BUFFERED_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
})();

export async function registerTerminalRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  const parseHistoryLimit = (request: { query?: unknown }) => {
    const query = (request.query || {}) as Record<string, string | undefined>;
    const historyChars = Number.parseInt(String(query.historyChars || ''), 10);
    const historyEvents = Number.parseInt(String(query.historyEvents || ''), 10);
    const beforeTs = Number.parseInt(String(query.beforeTs || ''), 10);
    const afterTs = Number.parseInt(String(query.afterTs || ''), 10);
    const beforeSeq = Number.parseInt(String(query.beforeSeq || ''), 10);
    const afterSeq = Number.parseInt(String(query.afterSeq || ''), 10);

    const hasQueryChars = Number.isFinite(historyChars) && historyChars > 0;
    const hasQueryEvents = Number.isFinite(historyEvents) && historyEvents > 0;
    const hasBeforeTs = Number.isFinite(beforeTs) && beforeTs > 0;
    const hasAfterTs = Number.isFinite(afterTs) && afterTs > 0;
    const hasBeforeSeq = Number.isFinite(beforeSeq) && beforeSeq > 0;
    const hasAfterSeq = Number.isFinite(afterSeq) && afterSeq >= 0;
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
      beforeSeq: hasBeforeSeq ? beforeSeq : undefined,
      afterSeq: hasAfterSeq ? afterSeq : undefined,
      beforeTs: hasBeforeTs ? beforeTs : undefined,
      afterTs: hasAfterTs ? afterTs : undefined
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

    const session = (() => {
      try {
        return deps.terminalManager.createSession(userId, {
          ...result.data,
          sandboxMode: result.data.sandboxMode ?? getUserSandboxDefaultMode(userId)
        });
      } catch (error) {
        reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    })();
    if (!session) return;
    reply.code(201).send({
      session: {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        usesTmux: session.usesTmux,
        sandbox: session.sandbox
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
    const history = snapshot.history || [];
    const lastEntry = history.length > 0 ? history[history.length - 1] : null;
    const nextCursor = lastEntry?.ts ?? null;
    const nextSeq = Number.isFinite(lastEntry?.seq) ? Number(lastEntry.seq) : null;
    reply.send({ ...snapshot, nextCursor, nextSeq });
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/turns', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const snapshot = deps.terminalManager.getSession(userId, request.params.id, {
      historyChars: 5_000_000,
      historyEvents: 20_000,
      includeHistory: true
    });
    if (!snapshot) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    const { buildTurnsFromHistory } = await import('../terminal/turn-detector.js');
    const turns = buildTurnsFromHistory(snapshot.history || []);
    reply.send({ turns });
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

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/git-branches', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const branchInfo = await deps.terminalManager.listGitBranches(userId, request.params.id);
    if (!branchInfo) {
      reply.code(404).send({ error: 'Git branches not available for this terminal' });
      return;
    }

    reply.send(branchInfo);
  });

  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/git-checkout', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const result = terminalGitCheckoutRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid git checkout body',
        details: result.error.flatten()
      });
      return;
    }

    try {
      const branchInfo = await deps.terminalManager.checkoutGitBranch(userId, request.params.id, result.data.branch);
      if (!branchInfo) {
        reply.code(404).send({ error: 'Git branches not available for this terminal' });
        return;
      }
      reply.send(branchInfo);
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
    const body = request.body as { cols: number; rows: number; clientId?: string; priority?: boolean };
    let clientId = body.clientId;
    const priority = body.priority === true;

    // Validate clientId format if provided (defense-in-depth)
    if (clientId && !isValidIdentifier(clientId, 64)) {
      reply.code(400).send({ error: 'Invalid clientId format' });
      return;
    }

    try {
      const resizeResult = deps.terminalManager.resize(
        userId,
        request.params.id,
        result.data.cols,
        result.data.rows,
        clientId,
        { priority }
      );
      reply.send({
        appliedCols: resizeResult.currentCols,
        appliedRows: resizeResult.currentRows,
        ownerClientId: resizeResult.ownerClientId,
        isOwner: clientId ? resizeResult.ownerClientId === clientId : undefined
      });
    } catch (error) {
      reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
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

  app.get<{ Params: TerminalIdParams }>(
    '/api/terminal/:id/ws',
    { websocket: true, config: { skipAuth: true } },
    (socket, request) => {
    // Phase 1: wait for auth message before setting up session
    const AUTH_TIMEOUT_MS = 5000;
    const authTimeout = setTimeout(() => {
      socket.close(4401, 'Authentication timeout');
    }, AUTH_TIMEOUT_MS);

    const setupSession = (userId: string) => {
    const sendHistory = shouldSendHistory(request);
    const useFramedProtocol = (() => {
      const query = (request.query || {}) as Record<string, string | undefined>;
      const raw = String(query.framed || '').toLowerCase();
      return raw === '1' || raw === 'true' || raw === 'yes';
    })();
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

    const bufferedEvents: Array<{ text: string; ts: number } | null> = [];
    let isBuffering = true;
    let cleaned = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let resyncSuggestedPending = false;
    let resyncSuggestedSinceTs = 0;
    let resyncSuggestedDrops = 0;
    let lastSendBlockedByBackpressure = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // Remove this client's dimensions when WebSocket disconnects
      deps.terminalManager.removeClient(userId, request.params.id, clientId);
    };

    const closeSocket = (code: number, reason: string) => {
      cleanup();
      try {
        socket.close(code, reason);
      } catch {
        // Ignore close race errors.
      }
    };

    const encoder = new TextEncoder();
    const canSend = (): boolean => {
      if (socket.readyState !== 1) {
        lastSendBlockedByBackpressure = false;
        return false;
      }
      if (socket.bufferedAmount > TERMINAL_WS_MAX_BUFFERED_BYTES) {
        // Client is slow — skip this message, stay connected.
        // Tell the client to do an incremental history resync once the socket drains.
        resyncSuggestedPending = true;
        resyncSuggestedDrops += 1;
        if (!resyncSuggestedSinceTs) {
          resyncSuggestedSinceTs = Date.now();
        }
        lastSendBlockedByBackpressure = true;
        return false;
      }
      lastSendBlockedByBackpressure = false;
      return true;
    };
    const sendBinaryRaw = (text: string): boolean => {
      if (!canSend()) {
        return false;
      }
      try {
        const buffer = encoder.encode(text);
        socket.send(buffer);
        return true;
      } catch {
        return false;
      }
    };
    const sendFrameRaw = (frameType: number, payload: string): boolean => {
      if (!canSend()) {
        return false;
      }
      try {
        const body = encoder.encode(payload);
        const framed = new Uint8Array(body.length + 1);
        framed[0] = frameType;
        framed.set(body, 1);
        socket.send(framed);
        return true;
      } catch {
        return false;
      }
    };
    const sendResyncSuggestionIfNeeded = (): boolean => {
      if (!resyncSuggestedPending) {
        return true;
      }
      const payload = {
        __terminal_meta: true,
        type: 'resyncSuggested',
        reason: 'slow-client-drop',
        ts: Date.now(),
        droppedSends: resyncSuggestedDrops,
        firstDroppedAt: resyncSuggestedSinceTs || undefined
      };
      const ok = useFramedProtocol
        ? sendFrameRaw(2, JSON.stringify(payload))
        : sendBinaryRaw(JSON.stringify(payload));
      if (ok) {
        resyncSuggestedPending = false;
        resyncSuggestedSinceTs = 0;
        resyncSuggestedDrops = 0;
      }
      return ok;
    };
    const sendBinary = (text: string): boolean => {
      if (!sendResyncSuggestionIfNeeded()) {
        return false;
      }
      return sendBinaryRaw(text);
    };
    const sendFrame = (frameType: number, payload: string): boolean => {
      if (!sendResyncSuggestionIfNeeded()) {
        return false;
      }
      return sendFrameRaw(frameType, payload);
    };
    const sendOutput = (text: string): boolean => (
      useFramedProtocol ? sendFrame(1, text) : sendBinary(text)
    );
    const sendMeta = (data: Record<string, unknown>): boolean => (
      useFramedProtocol ? sendFrame(2, JSON.stringify(data)) : sendBinary(JSON.stringify(data))
    );
    const sendServerCursor = (seq: unknown): boolean => {
      if (!Number.isFinite(seq)) return true;
      return sendMeta({ type: 'serverCursor', seq: Number(seq) });
    };

    // Send clientId to frontend so it can include it in resize requests
    if (!sendMeta({ type: 'clientId', clientId })) {
      if (!lastSendBlockedByBackpressure) {
        closeSocket(1011, 'Failed to send client metadata');
      }
      return;
    }

    if (!deps.terminalManager.isActive(snapshot.id)) {
      if (sendHistory) {
        for (const entry of snapshot.history) {
          if (!sendServerCursor(entry.seq)) {
            if (!lastSendBlockedByBackpressure) {
              closeSocket(1011, 'Failed to send terminal cursor metadata');
              return;
            }
          }
          if (!sendOutput(entry.text)) {
            if (!lastSendBlockedByBackpressure) {
              closeSocket(1011, 'Failed to send terminal history');
              return;
            }
          }
        }
      }
      socket.close(1000, 'Session ended');
      return;
    }

    heartbeatTimer = setInterval(() => {
      sendMeta({ type: 'serverPing', ts: Date.now() });
    }, 15000);

    unsubscribe = deps.terminalManager.subscribe(userId, snapshot.id, (event) => {
      if (isBuffering) {
        bufferedEvents.push(event);
        return;
      }
      if (event === null) {
        closeSocket(1000, 'Session ended');
        return;
      }
      if (useFramedProtocol && event.text.startsWith('{')) {
        try {
          const parsed = JSON.parse(event.text);
          if (parsed && parsed.__terminal_meta) {
            if (!sendMeta(parsed)) {
              if (!lastSendBlockedByBackpressure) {
                closeSocket(1011, 'Failed to send terminal metadata');
              }
            }
            return;
          }
        } catch {
          // Treat as output
        }
      }
      if (!sendServerCursor(event.seq)) {
        if (!lastSendBlockedByBackpressure) {
          closeSocket(1011, 'Failed to send terminal cursor metadata');
        }
        return;
      }
      if (!sendOutput(event.text)) {
        if (!lastSendBlockedByBackpressure) {
          closeSocket(1011, 'Failed to send terminal output');
        }
      }
    });

    if (sendHistory) {
      for (const entry of snapshot.history) {
        if (!sendServerCursor(entry.seq)) {
          if (!lastSendBlockedByBackpressure) {
            closeSocket(1011, 'Failed to send terminal cursor metadata');
            return;
          }
        }
        if (!sendOutput(entry.text)) {
          if (!lastSendBlockedByBackpressure) {
            closeSocket(1011, 'Failed to send terminal history');
            return;
          }
        }
      }
    }

    isBuffering = false;
    for (const event of bufferedEvents) {
      if (event === null) {
        closeSocket(1000, 'Session ended');
        return;
      }
      if (useFramedProtocol && event.text.startsWith('{')) {
        try {
          const parsed = JSON.parse(event.text);
          if (parsed && parsed.__terminal_meta) {
            if (!sendMeta(parsed)) {
              if (!lastSendBlockedByBackpressure) {
                closeSocket(1011, 'Failed to send terminal metadata');
                return;
              }
            }
            continue;
          }
        } catch {
          // Treat as output
        }
      }
      if (!sendServerCursor(event.seq)) {
        if (!lastSendBlockedByBackpressure) {
          closeSocket(1011, 'Failed to send terminal cursor metadata');
          return;
        }
      }
      if (!sendOutput(event.text)) {
        if (!lastSendBlockedByBackpressure) {
          closeSocket(1011, 'Failed to send terminal output');
          return;
        }
      }
    }

    const decoder = new TextDecoder();
    socket.on('message', (message) => {
      // Handle both binary and text frames for backward compatibility
      const data = message instanceof Buffer
        ? decoder.decode(message)
        : message.toString();
      if (!data) return;
      if (data.includes('__terminal_ping__')) {
        sendOutput('__terminal_pong__');
        return;
      }
      if (data.includes('"type":"ping"') && data.includes('"source":"terminal-client"')) {
        sendMeta({ type: 'pong', source: 'terminal-client', ts: Date.now() });
        return;
      }
      try {
        deps.terminalManager.write(userId, request.params.id, data);
      } catch {
        closeSocket(1011, 'Write failed');
      }
    });

    socket.on('close', cleanup);
    socket.on('error', cleanup);
    }; // end setupSession

    const handleAuth = (raw: Buffer | string) => {
      const text = raw instanceof Buffer ? raw.toString() : raw.toString();
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      try {
        const msg = JSON.parse(text);
        if (msg?.type !== 'auth' || typeof msg.token !== 'string') {
          socket.close(4401, 'Expected auth message');
          return;
        }
        const payload = verifyAccessToken(msg.token);
        if (!payload || !isAllowedUsername(payload.username)) {
          socket.close(4401, 'Invalid token');
          return;
        }
        clearTimeout(authTimeout);
        socket.off('message', handleAuth);
        setupSession(payload.sub);
      } catch {
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          socket.close(4401, 'Invalid auth message');
        }
      }
    };

    socket.on('message', handleAuth);
  });

  app.delete<{ Params: TerminalIdParams }>('/api/terminal/:id', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const closed = deps.terminalManager.close(userId, request.params.id);
    if (!closed) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
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
        updatedAt: session.updatedAt,
        sandbox: session.sandbox
      }
    });
  });
}
