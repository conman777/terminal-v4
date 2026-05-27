import type { FastifyInstance } from 'fastify';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTerminalRoutes } from './terminal-routes';
import { registerFilesystemRoutes } from './filesystem-routes';
import { registerProjectsRoutes } from './projects-routes';
import { registerPreviewApiRoutes } from './preview-api-routes';
import { registerThreadRoutes } from './thread-routes';
import { registerStructuredRoutes } from '../structured/structured-routes';
import type { CoreRouteDependencies } from './types';

// Re-export types for backward compatibility
export type { CoreRouteDependencies } from './types';

function getClientBuildInfo(): {
  buildId: string;
  mainScript: string | null;
  mainStylesheet: string | null;
  indexMtimeMs: number | null;
} {
  const frontendPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  const indexPath = join(frontendPath, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const indexStat = statSync(indexPath);
  const mainScript = html.match(/<script\b[^>]*\bsrc="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
  const mainStylesheet = html.match(/<link\b[^>]*\bhref="([^"]*\/assets\/index-[^"]+\.css)"/)?.[1] ?? null;

  return {
    buildId: mainScript || String(Math.floor(indexStat.mtimeMs)),
    mainScript,
    mainStylesheet,
    indexMtimeMs: Math.floor(indexStat.mtimeMs),
  };
}

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  // Health check endpoint
  app.get('/api/health', () => ({ status: 'ok' }));

  app.get('/api/client-build', { config: { skipAuth: true } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    try {
      return {
        ...getClientBuildInfo(),
        checkedAt: Date.now(),
      };
    } catch {
      reply.code(503);
      return { error: 'Client build unavailable' };
    }
  });

  app.get('/api/latency/ws', { websocket: true }, (socket, request) => {
    const userId = request.userId;
    if (!userId) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    socket.on('message', (message) => {
      const data = message.toString();
      if (!data) return;
      if (!data.startsWith('{')) return;
      try {
        const msg = JSON.parse(data);
        if (msg?.type === 'ping' && typeof msg.id === 'number') {
          socket.send(JSON.stringify({
            type: 'pong',
            id: msg.id,
            sentAt: msg.sentAt ?? null,
            serverAt: Date.now()
          }));
        }
      } catch {
        // Ignore invalid JSON.
      }
    });
  });

  // Register route modules
  await registerTerminalRoutes(app, deps);
  await registerFilesystemRoutes(app);
  await registerProjectsRoutes(app);
  await registerPreviewApiRoutes(app);
  await registerThreadRoutes(app, deps);
  await registerStructuredRoutes(app, deps.structuredSessionManager);
}
