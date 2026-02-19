import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { stopCleanupInterval } from '../preview/preview-logs-service';
import { registerPreviewLogsRoutes } from './preview-logs-routes';

async function createTestApp(withUser = false) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (withUser) {
      request.userId = 'test-user';
      request.username = 'tester';
    }
  });
  await registerPreviewLogsRoutes(app);
  await app.ready();
  return app;
}

describe('preview-logs routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    stopCleanupInterval();
    delete process.env.ALLOW_UNAUTH_PREVIEW_LOG_READ;
    delete process.env.PREVIEW_LOG_INGEST_KEY;
  });

  it('requires auth for GET logs by default', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/80/logs'
    });

    expect(response.statusCode).toBe(401);
  });

  it('accepts authenticated log reads by default', async () => {
    app = await createTestApp(true);

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/80/logs'
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects out-of-range ports', async () => {
    app = await createTestApp(true);

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/65536/logs'
    });

    expect(response.statusCode).toBe(400);
  });

  it('allows unauthenticated GET logs when configured', async () => {
    process.env.ALLOW_UNAUTH_PREVIEW_LOG_READ = 'true';
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/8080/logs'
    });

    expect(response.statusCode).toBe(200);
  });

  it('enforces preview log ingest key when configured', async () => {
    process.env.PREVIEW_LOG_INGEST_KEY = 'secret-key';
    app = await createTestApp();

    const missingHeaderResponse = await app.inject({
      method: 'POST',
      url: '/api/preview/8080/logs',
      payload: {
        logs: [{ type: 'console', timestamp: Date.now(), level: 'log', message: 'test' }]
      }
    });
    expect(missingHeaderResponse.statusCode).toBe(401);

    const authorizedResponse = await app.inject({
      method: 'POST',
      url: '/api/preview/8080/logs',
      headers: {
        'x-preview-log-key': 'secret-key'
      },
      payload: {
        logs: [{ type: 'console', timestamp: Date.now(), level: 'log', message: 'test' }]
      }
    });
    expect(authorizedResponse.statusCode).toBe(200);
  });
});
