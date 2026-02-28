import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { registerCoreRoutes } from './routes/register-core-routes';
import { registerBookmarkRoutes } from './routes/bookmark-routes';
import { registerNoteRoutes } from './routes/note-routes';
import { registerPreviewRoutes } from './routes/preview-routes';
import { registerTranscribeRoutes } from './routes/transcribe-routes';
import { registerSettingsRoutes } from './routes/settings-routes';
import { registerOpenAIRoutes } from './routes/openai-routes';
import { registerVaultRoutes } from './routes/vault-routes';
import { registerDevProxyRoutes } from './routes/dev-proxy-routes';
import { registerPreviewSubdomainRoutes } from './routes/preview-subdomain-routes';
import { registerPreviewLogsRoutes } from './routes/preview-logs-routes';
import { registerExternalProxyRoutes } from './routes/external-proxy-routes';
import { registerProcessRoutes } from './routes/process-routes';
import { registerSystemRoutes } from './routes/system-routes';
import { registerClaudeCodeRoutes } from './claude-code/claude-code-routes';
import { registerFileRoutes } from './routes/file-routes';
import { registerScreenshotRoutes } from './routes/screenshot-routes';
import { registerWebContainerRoutes } from './routes/webcontainer-routes';
import { TerminalManager, type TerminalManagerOptions } from './terminal/terminal-manager';
import { ClaudeCodeManager } from './claude-code/claude-code-manager';
import { getDatabase, closeDatabase } from './database/db';
import { registerAuthHook } from './auth/auth-hook';
import { registerAuthRoutes } from './auth/auth-routes';
import { registerPasskeyRoutes } from './auth/passkey-routes';
import { assertAuthConfig } from './auth/auth-service';
import { stopCleanupInterval } from './preview/preview-logs-service';
import { migrateOrphanedSessions } from './migrations/migrate-sessions';
import { startMemoryMonitoring, stopMemoryMonitoring } from './utils/memory-monitor';

export interface CreateServerOptions {
  logger?: FastifyServerOptions['logger'];
  terminalManager?: TerminalManager;
  terminalOptions?: TerminalManagerOptions;
}

// Build HTTPS options if TLS cert/key files are configured and exist
const httpsOptions = (() => {
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (certFile && keyFile && existsSync(certFile) && existsSync(keyFile)) {
    return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
  }
  return undefined;
})();

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: process.env.LOG_LEVEL || 'info'
      } satisfies NonNullable<FastifyServerOptions['logger']>),
    ...(httpsOptions ? { https: httpsOptions } : {})
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });
  // Compression is handled by Cloudflare - don't double-compress
  // await app.register(fastifyCompress, { ... });
  await app.register(websocket);
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024 // 100MB max for file uploads
    }
  });

  // Note: COEP/COOP headers removed - they break cross-origin preview iframe
  // WebContainers now use `coep: 'none'` boot option which relies on Chrome's Origin Trial
  // This means WebContainers only work in Chromium browsers, but proxy preview works everywhere

  // Initialize database
  getDatabase();

  // Migrate orphaned sessions from old storage location (one-time)
  await migrateOrphanedSessions();

  // Fail fast on insecure auth configuration
  assertAuthConfig();

  // Register auth hook (must be before routes)
  registerAuthHook(app);

  // Register auth routes
  registerAuthRoutes(app);
  registerPasskeyRoutes(app);

  // Register preview subdomain routes early (before other routes)
  // This handles requests to preview-{port}.{PREVIEW_SUBDOMAIN_BASE}
  await registerPreviewSubdomainRoutes(app);

  const terminalManager = options.terminalManager ?? new TerminalManager(options.terminalOptions);
  await terminalManager.initialize();

  // Initialize Claude Code manager before registering core routes
  const claudeCodeManager = new ClaudeCodeManager();
  await claudeCodeManager.initialize();

  // Register routes with both managers
  await registerCoreRoutes(app, { terminalManager, claudeCodeManager });
  await registerBookmarkRoutes(app);
  await registerNoteRoutes(app);
  await registerPreviewRoutes(app);
  await registerPreviewLogsRoutes(app);
  await registerTranscribeRoutes(app);
  await registerSettingsRoutes(app);
  await registerOpenAIRoutes(app);
  await registerVaultRoutes(app);
  await registerDevProxyRoutes(app);
  await registerClaudeCodeRoutes(app, claudeCodeManager);
  await registerFileRoutes(app);
  await registerProcessRoutes(app);
  await registerSystemRoutes(app);
  await registerExternalProxyRoutes(app);
  await registerScreenshotRoutes(app);
  await registerWebContainerRoutes(app);

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
    // API routes return proper 404 JSON
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not Found', message: 'API route not found' });
      return;
    }
    // Static assets with hashes should NOT fallback to index.html
    // They're immutable - if missing, they're truly missing (stale cache)
    if (request.url.startsWith('/assets/')) {
      reply.code(404).send({ error: 'Not Found', message: 'Asset not found - please refresh the page' });
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

  // Start memory monitoring
  startMemoryMonitoring();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info(`${signal} received, shutting down...`);
    try {
      stopMemoryMonitoring();
      stopCleanupInterval();
      // Run server.close() and terminalManager.closeAll() in parallel so PTY
      // cleanup still happens even if server.close() is slow (e.g. open WebSockets).
      // Cap server.close() at 10s to stay well within systemd's TimeoutStopSec=20.
      const serverCloseWithTimeout = Promise.race([
        server.close(),
        new Promise<void>((resolve) => setTimeout(() => {
          server.log.warn('server.close() timed out after 10s, continuing shutdown');
          resolve();
        }, 10_000))
      ]);
      await Promise.all([
        serverCloseWithTimeout,
        terminalManager.closeAll()
      ]);
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
    const protocol = httpsOptions ? 'https' : 'http';
    server.log.info(`Server listening on ${protocol}://${host}:${port}`);
  } catch (error) {
    server.log.error(error, 'Failed to start server');
    process.exit(1);
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === process.argv[1]) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
