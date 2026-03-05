import type { FastifyInstance } from 'fastify';
import { registerTerminalRoutes } from './terminal-routes';
import { registerFilesystemRoutes } from './filesystem-routes';
import { registerProjectsRoutes } from './projects-routes';
import { registerPreviewApiRoutes } from './preview-api-routes';
import { registerThreadRoutes } from './thread-routes';
import { registerStructuredRoutes } from '../structured/structured-routes';
import type { CoreRouteDependencies } from './types';

// Re-export types for backward compatibility
export type { CoreRouteDependencies } from './types';

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  // Health check endpoint
  app.get('/api/health', () => ({ status: 'ok' }));
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
