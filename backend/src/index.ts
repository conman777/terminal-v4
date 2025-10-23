import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { fileURLToPath } from 'node:url';
import { registerCoreRoutes } from './routes/register-core-routes';
import { TerminalManager, type TerminalManagerOptions } from './terminal/terminal-manager';

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
  await registerCoreRoutes(app, { terminalManager });

  return app;
}

async function start() {
  const server = await createServer();
  const port = Number(process.env.PORT || 3020);
  const host = process.env.HOST || '0.0.0.0';

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
