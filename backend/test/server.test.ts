import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createServer } from '../src/index';

describe('HTTP server', () => {
  let instance: Awaited<ReturnType<typeof createServer>>;

  beforeAll(async () => {
    instance = await createServer({ logger: false });
    await instance.listen({ port: 0 });
  });

  afterAll(async () => {
    await instance.close();
  });

  it('exposes a health endpoint', async () => {
    const response = await supertest(instance.server)
      .get('/api/health')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });
});
