import type { FastifyInstance } from 'fastify';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import {
  terminalCreateRequestSchema,
  terminalInputRequestSchema,
  terminalRenameRequestSchema,
  terminalResizeRequestSchema
} from './schemas';
import type { TerminalManager } from '../terminal/terminal-manager';
import { scanForProjects } from '../services/project-scanner';

// Define the root directory of the project for sandboxing filesystem operations
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

function normalizePathForPlatform(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithinBase(basePath: string, candidatePath: string): boolean {
  const baseNormalized = normalizePathForPlatform(resolve(basePath));
  const candidateNormalized = normalizePathForPlatform(resolve(candidatePath));

  if (candidateNormalized === baseNormalized) return true;

  const baseWithSep = baseNormalized.endsWith(sep) ? baseNormalized : baseNormalized + sep;
  return candidateNormalized.startsWith(baseWithSep);
}

let projectRootRealPathCache: string | null = null;
async function getProjectRootRealPath(): Promise<string> {
  if (projectRootRealPathCache) return projectRootRealPathCache;
  try {
    projectRootRealPathCache = await realpath(PROJECT_ROOT);
  } catch {
    projectRootRealPathCache = PROJECT_ROOT;
  }
  return projectRootRealPathCache;
}

async function resolvePathInProjectRoot(targetPath: string): Promise<string | null> {
  const resolvedTargetPath = resolve(targetPath);
  const baseRealPath = await getProjectRootRealPath();

  let targetRealPath: string;
  try {
    targetRealPath = await realpath(resolvedTargetPath);
  } catch {
    // If the path doesn't exist yet we still want to validate containment based on the resolved path.
    targetRealPath = resolvedTargetPath;
  }

  return isWithinBase(baseRealPath, targetRealPath) ? targetRealPath : null;
}

export interface CoreRouteDependencies {
  terminalManager: TerminalManager;
}

interface TerminalIdParams {
  id: string;
}

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/terminal', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    await deps.terminalManager.loadUserSessions(userId);
    reply.send({ sessions: deps.terminalManager.listSessions(userId) });
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
        updatedAt: session.updatedAt
      }
    });
  });

  app.get<{ Params: TerminalIdParams }>('/api/terminal/:id/history', async (request, reply) => {
    const userId = request.userId;
    if (!userId) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const snapshot = deps.terminalManager.getSession(userId, request.params.id);
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

    try {
      deps.terminalManager.resize(userId, request.params.id, result.data.cols, result.data.rows);
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

    const snapshot = deps.terminalManager.getSession(userId, request.params.id);
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

    const snapshot = deps.terminalManager.getSession(userId, request.params.id);
    if (!snapshot) {
      socket.close(4404, 'Terminal session not found');
      return;
    }

    const send = (text: string): boolean => {
      try {
        socket.send(text);
        return true;
      } catch {
        return false;
      }
    };

    if (!deps.terminalManager.isActive(snapshot.id)) {
      snapshot.history.forEach((entry) => {
        send(entry.text);
      });
      socket.close(1000, 'Session ended');
      return;
    }

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

    snapshot.history.forEach((entry) => {
      send(entry.text);
    });

    isBuffering = false;
    for (const event of bufferedEvents) {
      if (event === null) {
        socket.close(1000, 'Session ended');
        return;
      }
      send(event.text);
    }

    socket.on('message', (message) => {
      const data = message.toString();
      if (!data) return;
      try {
        deps.terminalManager.write(userId, request.params.id, data);
      } catch {
        socket.close(1011, 'Write failed');
      }
    });

    const cleanup = () => {
      unsubscribe();
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

  // Filesystem: List directories
  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (request, reply) => {
    // Resolve to absolute path
    const requestedPath = resolve(request.query.path || PROJECT_ROOT);
    const safePath = await resolvePathInProjectRoot(requestedPath);

    // Sandboxing check
    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside project root' });
      return;
    }

    try {
      const stats = await stat(safePath);
      if (!stats.isDirectory()) {
        reply.code(400).send({ error: 'Path is not a directory' });
        return;
      }

      const entries = await readdir(safePath, { withFileTypes: true });
      const folders = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Get parent directory (null if at root or outside SAFE_ROOT)
      const parsed = parse(safePath);
      let parent: string | null = null;
      if (parsed.root !== safePath) {
        const potentialParent = dirname(safePath);
        const baseRealPath = await getProjectRootRealPath();
        if (potentialParent !== safePath && isWithinBase(baseRealPath, potentialParent)) {
          parent = potentialParent;
        }
      }

      reply.send({
        path: safePath,
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
    const requestedPath = resolve(request.query.path || PROJECT_ROOT);
    const safePath = await resolvePathInProjectRoot(requestedPath);

    // Sandboxing check
    if (!safePath) {
      reply.code(403).send({ error: 'Access denied: path is outside project root' });
      return;
    }

    let stats;
    try {
      stats = await stat(safePath);
    } catch (error) {
      reply.code(400).send({
        error: 'Cannot download directory',
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!stats.isDirectory()) {
      reply.code(400).send({ error: 'Path is not a directory' });
      return;
    }

    const folderName = basename(safePath) || 'download';
    const zipFileName = `${folderName}.zip`;

    reply.hijack();

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
    archive.directory(safePath, folderName);

    try {
      await archive.finalize();
    } catch (error) {
      console.error('Archive finalize error:', error);
      reply.raw.end();
    }
  });

  // Projects: Scan for git repositories
  app.get<{ Querystring: { force?: string } }>('/api/projects/scan', async (request, reply) => {
    const force = request.query.force === 'true';
    try {
      const result = await scanForProjects(force);
      reply.send(result);
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to scan for projects',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
