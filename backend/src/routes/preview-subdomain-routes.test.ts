import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPreviewSubdomainRoutes } from './preview-subdomain-routes';

async function createTestApp() {
  const app = Fastify();
  await app.register(websocket);
  await registerPreviewSubdomainRoutes(app);
  await app.ready();
  return app;
}

const appPort = (() => {
  const parsed = Number.parseInt(process.env.PORT || '3020', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3020;
})();
const isUnrestrictedPreview = process.env.UNRESTRICTED_PREVIEW === 'true';
const minimumAllowedPreviewPort = isUnrestrictedPreview ? 80 : 3000;

describe('preview-subdomain routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>> | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('handles the minimum allowed preview port instead of rejecting it', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: `/preview/${minimumAllowedPreviewPort}/`
    });

    // Without correct port-range handling this falls through to 404.
    expect(response.statusCode).toBe(204);
  });

  it('does not proxy the Terminal V4 app port', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/preview/${appPort}/`
    });

    expect(response.statusCode).toBe(404);
  });
});
