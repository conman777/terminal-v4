import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { stopCleanupInterval } from '../preview/preview-logs-service';
import { registerPreviewLogsRoutes } from './preview-logs-routes';

async function createTestApp() {
  const app = Fastify();
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
  });

  it('accepts low valid ports', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/80/logs'
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects out-of-range ports', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/65536/logs'
    });

    expect(response.statusCode).toBe(400);
  });
});

