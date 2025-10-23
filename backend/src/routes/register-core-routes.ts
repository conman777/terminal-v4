import type { FastifyInstance } from 'fastify';
import type { SessionStore } from '../session/types';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnClaudeOptions } from '../claude/cli';
import { chatRequestSchema, terminalCreateRequestSchema, terminalInputRequestSchema } from './schemas';
import { detectClaudeSessionId, extractTextFragment } from '../chat/parsers';
import type { TerminalManager } from '../terminal/terminal-manager';

type ClaudeSpawner = (options: SpawnClaudeOptions) => ChildProcessWithoutNullStreams;

export interface CoreRouteDependencies {
  sessionStore: SessionStore;
  spawnClaude: ClaudeSpawner;
  terminalManager: TerminalManager;
}

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/sessions', async () => ({
    sessions: deps.sessionStore.listSessions()
  }));

  app.post('/api/chat', async (request, reply) => {
    const result = chatRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid chat request body',
        details: result.error.flatten()
      });
      return;
    }

    const { message, sessionId: requestedSessionId, allowedTools } = result.data;

    let session =
      requestedSessionId !== undefined
        ? deps.sessionStore.touch(requestedSessionId)
        : deps.sessionStore.createSession({ firstMessage: message });

    if (!session) {
      reply.code(404).send({ error: `Session ${requestedSessionId} not found` });
      return;
    }

    const sessionId = session.id;
    deps.sessionStore.appendMessage(sessionId, { role: 'user', content: message });
    const assistantMessageId = deps.sessionStore.appendMessage(sessionId, {
      role: 'assistant',
      content: '',
      meta: { streaming: true }
    });

    let process: ChildProcessWithoutNullStreams;
    try {
      process = deps.spawnClaude({
        message,
        sessionId: session.claudeSessionId ?? undefined,
        allowedTools
      });
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to start Claude process',
        detail: error instanceof Error ? error.message : String(error)
      });
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
    let assistantBuffer = '';
    let currentClaudeSessionId = session.claudeSessionId ?? null;
    let stdoutBuffer = '';

    const sendEvent = (event: string, data: unknown = {}): void => {
      if (streamClosed) {
        return;
      }
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const closeStream = () => {
      if (streamClosed) {
        return;
      }
      streamClosed = true;
      clearInterval(keepAlive);
    };

    sendEvent('started', { sessionId, claudeSessionId: session.claudeSessionId });

    const keepAlive = setInterval(() => {
      sendEvent('ping', {});
    }, 15000);

    process.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          sendEvent('chunk', parsed);

          const fragment = extractTextFragment(parsed);
          if (fragment) {
            assistantBuffer += fragment;
            deps.sessionStore.updateMessage(sessionId, assistantMessageId, { content: assistantBuffer });
          }

          const cliSessionId = detectClaudeSessionId(parsed);
          if (cliSessionId && cliSessionId !== currentClaudeSessionId) {
            currentClaudeSessionId = cliSessionId;
            deps.sessionStore.setClaudeSessionId(sessionId, cliSessionId);
            sendEvent('session', { claudeSessionId: cliSessionId });
          }
        } catch (error) {
          sendEvent('raw', { line: trimmed, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });

    process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      sendEvent('stderr', { text });
    });

    let finished = false;

    const finishStream = (meta: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
      if (finished) {
        return;
      }
      finished = true;
      deps.sessionStore.updateMessage(sessionId, assistantMessageId, {
        content: assistantBuffer,
        meta: {
          streaming: false,
          exitCode: meta.exitCode,
          signal: meta.signal
        }
      });
      sendEvent('complete', { code: meta.exitCode, signal: meta.signal, sessionId });
      closeStream();
      stream.end();
    };

    const handleProcessEnd = (code: number | null | undefined, signal: NodeJS.Signals | null | undefined) => {
      finishStream({ exitCode: code ?? null, signal: signal ?? null });
    };

    process.once('exit', (code, signal) => handleProcessEnd(code, signal));
    process.once('close', (code, signal) => handleProcessEnd(code, signal));

    process.once('error', (error) => {
      sendEvent('error', { message: error instanceof Error ? error.message : String(error) });
      finishStream({ exitCode: null, signal: null });
    });

    request.raw.on('close', () => {
      if (streamClosed) {
        return;
      }
      process.kill();
      assistantBuffer += '\n[Request aborted by client]';
      deps.sessionStore.updateMessage(sessionId, assistantMessageId, {
        content: assistantBuffer,
        meta: { streaming: false, aborted: true }
      });
      finished = true;
      closeStream();
    });
  });

  app.get('/api/terminal', async () => ({
    sessions: deps.terminalManager.listSessions()
  }));

  app.post('/api/terminal', async (request, reply) => {
    const result = terminalCreateRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid terminal request body',
        details: result.error.flatten()
      });
      return;
    }

    const session = deps.terminalManager.createSession(result.data);
    reply.code(201).send({
      session: {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      }
    });
  });

  app.get('/api/terminal/:id/history', async (request, reply) => {
    const snapshot = deps.terminalManager.getSession(request.params.id);
    if (!snapshot) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    reply.send(snapshot);
  });

  app.post('/api/terminal/:id/input', async (request, reply) => {
    const result = terminalInputRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid terminal input body',
        details: result.error.flatten()
      });
      return;
    }

    try {
      deps.terminalManager.write(request.params.id, result.data.command);
    } catch (error) {
      reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    reply.code(204).send();
  });

  app.get('/api/terminal/:id/stream', async (request, reply) => {
    const snapshot = deps.terminalManager.getSession(request.params.id);
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

    const send = (event: string, data: unknown) => {
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    snapshot.history.forEach((entry) => {
      send('data', { text: entry.text, ts: entry.ts });
    });

    const unsubscribe = deps.terminalManager.subscribe(snapshot.id, (event) => {
      if (event === null) {
        send('end', {});
        stream.end();
        return;
      }
      send('data', { text: event.text, ts: event.ts });
    });

    const keepAlive = setInterval(() => {
      send('ping', {});
    }, 15000);

    stream.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
}
