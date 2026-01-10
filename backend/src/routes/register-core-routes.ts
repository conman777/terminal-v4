import type { FastifyInstance } from 'fastify';
import { registerTerminalRoutes } from './terminal-routes';
import { registerFilesystemRoutes } from './filesystem-routes';
import { registerProjectsRoutes } from './projects-routes';
import { registerPreviewApiRoutes } from './preview-api-routes';
import type { CoreRouteDependencies } from './types';

// Re-export types for backward compatibility
export type { CoreRouteDependencies } from './types';

export async function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): Promise<void> {
  // Health check endpoint
  app.get('/api/health', () => ({ status: 'ok' }));

  // Register route modules
  await registerTerminalRoutes(app, deps);
  await registerFilesystemRoutes(app);
  await registerProjectsRoutes(app);
  await registerPreviewApiRoutes(app);
}
