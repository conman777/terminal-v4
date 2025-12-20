import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { fileURLToPath } from 'node:url';
import { registerCoreRoutes } from './routes/register-core-routes';
import { registerBookmarkRoutes } from './routes/bookmark-routes';
import { registerPreviewRoutes } from './routes/preview-routes';
import { registerClaudeCodeRoutes } from './claude-code/claude-code-routes';
import { TerminalManager, type TerminalManagerOptions } from './terminal/terminal-manager';
import { ClaudeCodeManager } from './claude-code/claude-code-manager';

export interface CreateServerOptions {
  logger?: FastifyServerOptions['logger'];
  terminalManager?: TerminalManager;
  terminalOptions?: TerminalManagerOptions;
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: process.env.LOG_LEVEL || 'info'
      } satisfies NonNullable<FastifyServerOptions['logger']>)
  });

  await app.register(cors, {
    origin: true
  });

  const terminalManager = options.terminalManager ?? new TerminalManager(options.terminalOptions);
  await terminalManager.initialize();
  await registerCoreRoutes(app, { terminalManager });
  await registerBookmarkRoutes(app);
  await registerPreviewRoutes(app);

  // Initialize Claude Code manager and routes
  const claudeCodeManager = new ClaudeCodeManager();
  await claudeCodeManager.initialize();
  await registerClaudeCodeRoutes(app, claudeCodeManager);

  return app;
}

async function start() {
  const terminalManager = new TerminalManager();
  const server = await createServer({ terminalManager });
  const port = Number(process.env.PORT || 3020);
  const host = process.env.HOST || '0.0.0.0';

  const shutdown = async (signal: string) => {
    server.log.info(`${signal} received, shutting down...`);
    try {
      await server.close();
      await terminalManager.closeAll();
      process.exit(0);
    } catch (err) {
      server.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await server.listen({ port, host });
  } catch (error) {
    server.log.error(error, 'Failed to start server');
    process.exit(1);
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === process.argv[1]) {
  start();
}
