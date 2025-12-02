import type { FastifyInstance } from 'fastify';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, parse, resolve, basename } from 'node:path';
import archiver from 'archiver';
import { terminalCreateRequestSchema, terminalInputRequestSchema, terminalResizeRequestSchema } from './schemas';
import type { TerminalManager } from '../terminal/terminal-manager';

export interface CoreRouteDependencies {
  terminalManager: TerminalManager;
}

interface TerminalIdParams {
  id: string;
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

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/history', async (request, reply) => {
    const snapshot = deps.terminalManager.getSession(request.params.id);
    if (!snapshot) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    reply.send(snapshot);
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/project-info', async (request, reply) => {
    const projectInfo = await deps.terminalManager.getProjectInfo(request.params.id);
    if (!projectInfo) {
      reply.code(404).send({ error: 'Terminal session not found' });
      return;
    }
    reply.send(projectInfo);
  });

  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/input', async (request, reply) => {
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

  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/resize', async (request, reply) => {
    const result = terminalResizeRequestSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'Invalid resize body',
        details: result.error.flatten()
      });
      return;
    }

    try {
      deps.terminalManager.resize(request.params.id, result.data.cols, result.data.rows);
    } catch (error) {
      reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    reply.code(204).send();
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/stream', async (request, reply) => {
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

    // Buffer events while sending history to prevent race condition
    const bufferedEvents: Array<{ text: string; ts: number } | null> = [];
    let isBuffering = true;

    const unsubscribe = deps.terminalManager.subscribe(snapshot.id, (event) => {
      if (isBuffering) {
        bufferedEvents.push(event);
        return;
      }
      if (event === null) {
        send('end', {});
        stream.end();
        return;
      }
      send('data', { text: event.text, ts: event.ts });
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
      send('ping', {});
    }, 15000);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(keepAlive);
      unsubscribe();
    };

    stream.on('close', cleanup);
    request.raw.on('close', cleanup);
  });

  app.delete<{ Params: TerminalIdParams }>('/api/terminal/:id', async (request, reply) => {
    deps.terminalManager.close(request.params.id);
    reply.code(204).send();
  });

  // Restore a persisted session (creates new PTY, keeps history)
  app.post<{ Params: TerminalIdParams }>('/api/terminal/:id/restore', async (request, reply) => {
    const result = terminalResizeRequestSchema.safeParse(request.body);
    const cols = result.success ? result.data.cols : undefined;
    const rows = result.success ? result.data.rows : undefined;

    const session = deps.terminalManager.restoreSession(request.params.id, { cols, rows });
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

  // Filesystem: List directories
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (request, reply) => {
    // Resolve to absolute path
    const requestedPath = resolve(request.query.path || process.cwd());

    try {
      const stats = await stat(requestedPath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is not a directory' });
        return;
      }

      const entries = await readdir(requestedPath, { withFileTypes: true });
      const folders = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Get parent directory (null if at root)
      const parsed = parse(requestedPath);
      const parent = parsed.root === requestedPath ? null : dirname(requestedPath);

      reply.send({
        path: requestedPath,
        folders,
        parent
      });
    } catch (error) {
      reply.code(400).send({
        error: 'Cannot access directory',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  // Filesystem: Download directory as zip
  app.get<{ Querystring: { path?: string } }>('/api/fs/download', async (request, reply) => {
    const requestedPath = resolve(request.query.path || process.cwd());

    try {
      const stats = await stat(requestedPath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is not a directory' });
        return;
      }

      const folderName = basename(requestedPath) || 'download';
      const zipFileName = `${folderName}.zip`;

      reply.raw.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFileName}"`,
        'Transfer-Encoding': 'chunked'
      });

      const archive = archiver('zip', { zlib: { level: 5 } });

      archive.on('error', (err) => {
        console.error('Archive error:', err);
        reply.raw.end();
      });

      archive.pipe(reply.raw);

      // Add the directory contents to the zip
      archive.directory(requestedPath, folderName);

      await archive.finalize();
    } catch (error) {
      reply.code(400).send({
        error: 'Cannot download directory',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
