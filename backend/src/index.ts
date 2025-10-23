import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { fileURLToPath } from 'node:url';
import { registerCoreRoutes } from './routes/register-core-routes';
import { MemorySessionStore } from './session/memory-session-store';
import type { SessionStore } from './session/types';
import { spawnClaudeProcess, type SpawnClaudeOptions } from './claude/cli';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { TerminalManager, type TerminalManagerOptions } from './terminal/terminal-manager';

export interface CreateServerOptions {
  logger?: FastifyServerOptions['logger'];
  sessionStore?: SessionStore;
  spawnClaude?: (options: SpawnClaudeOptions) => ChildProcessWithoutNullStreams;
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

  const sessionStore = options.sessionStore ?? new MemorySessionStore();
  const spawnClaude = options.spawnClaude ?? spawnClaudeProcess;
  const terminalManager = options.terminalManager ?? new TerminalManager(options.terminalOptions);
  await registerCoreRoutes(app, { sessionStore, spawnClaude, terminalManager });

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
