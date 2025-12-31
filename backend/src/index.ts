import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { registerCoreRoutes } from './routes/register-core-routes';
import { registerBookmarkRoutes } from './routes/bookmark-routes';
import { registerPreviewRoutes } from './routes/preview-routes';
import { registerTranscribeRoutes } from './routes/transcribe-routes';
import { registerSettingsRoutes } from './routes/settings-routes';
import { registerDevProxyRoutes } from './routes/dev-proxy-routes';
import { registerPreviewSubdomainRoutes } from './routes/preview-subdomain-routes';
import { registerProcessRoutes } from './routes/process-routes';
import { registerClaudeCodeRoutes } from './claude-code/claude-code-routes';
import { registerFileRoutes } from './routes/file-routes';
import { TerminalManager, type TerminalManagerOptions } from './terminal/terminal-manager';
import { ClaudeCodeManager } from './claude-code/claude-code-manager';
import { getDatabase, closeDatabase } from './database/db';
import { registerAuthHook } from './auth/auth-hook';
import { registerAuthRoutes } from './auth/auth-routes';

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
  await app.register(websocket);
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024 // 100MB max for file uploads
    }
  });

  // Initialize database
  getDatabase();

  // Register auth hook (must be before routes)
  registerAuthHook(app);

  // Register auth routes
  registerAuthRoutes(app);

  // Register preview subdomain routes early (before other routes)
  // This handles requests to preview-{port}.conordart.com
  await registerPreviewSubdomainRoutes(app);

  const terminalManager = options.terminalManager ?? new TerminalManager(options.terminalOptions);
  await terminalManager.initialize();

  // Initialize Claude Code manager before registering core routes
  const claudeCodeManager = new ClaudeCodeManager();
  await claudeCodeManager.initialize();

  // Register routes with both managers
  await registerCoreRoutes(app, { terminalManager, claudeCodeManager });
  await registerBookmarkRoutes(app);
  await registerPreviewRoutes(app);
  await registerTranscribeRoutes(app);
  await registerSettingsRoutes(app);
  await registerDevProxyRoutes(app);
  await registerClaudeCodeRoutes(app, claudeCodeManager);
  await registerFileRoutes(app);
  await registerProcessRoutes(app);

  // Serve static frontend files
  const frontendPath = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  await app.register(fastifyStatic, {
    root: frontendPath,
    prefix: '/',
    // Disable default caching so our setHeaders takes full control
    cacheControl: false,
    setHeaders: (res, path) => {
      // HTML files: never cache (always revalidate)
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else {
        // JS/CSS/assets with hashes: cache for 1 year
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  });

  // SPA fallback - serve index.html for non-API routes
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not Found', message: 'API route not found' });
      return;
    }
    // Set no-cache headers for SPA fallback
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return reply.sendFile('index.html');
  });

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
      closeDatabase();
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
