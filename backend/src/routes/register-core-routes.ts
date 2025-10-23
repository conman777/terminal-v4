import type { FastifyInstance } from 'fastify';
import { terminalCreateRequestSchema, terminalInputRequestSchema } from './schemas';
import type { TerminalManager } from '../terminal/terminal-manager';

export interface CoreRouteDependencies {
  terminalManager: TerminalManager;
}

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok' }));

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

  app.delete('/api/terminal/:id', async (request, reply) => {
    deps.terminalManager.close(request.params.id);
    reply.code(204).send();
  });
}
