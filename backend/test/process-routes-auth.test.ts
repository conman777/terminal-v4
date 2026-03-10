import { describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { createServer } from '../src/index';
import type { TerminalManager } from '../src/terminal/terminal-manager';
import type { TerminalSessionSnapshot } from '../src/terminal/terminal-types';

type TerminalManagerContract = Pick<
  TerminalManager,
  'initialize' | 'listSessions' | 'createSession' | 'getSession' | 'write' | 'subscribe' | 'resize' | 'close' | 'renameSession'
>;

async function withApp<T>(
  fn: (context: {
    app: Awaited<ReturnType<typeof createServer>>;
    accessToken: string;
  }) => Promise<T>
): Promise<T> {
  const terminalSession: TerminalSessionSnapshot = {
    id: 'term-1',
    title: 'Terminal 1',
    shell: 'bash',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: []
  };

  class StubTerminalManager implements TerminalManagerContract {
    initialize = vi.fn(async () => {});
    listSessions = vi.fn(() => []);
    createSession = vi.fn(() => terminalSession);
    getSession = vi.fn(() => terminalSession);
    write = vi.fn();
    subscribe = vi.fn(() => () => {});
    resize = vi.fn();
    close = vi.fn(() => true);
    renameSession = vi.fn(async (_userId: string, id: string, title: string) => ({
      id,
      title,
      shell: 'bash',
      createdAt: terminalSession.createdAt,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      isActive: true
    }));
  }

  const terminalManager = new StubTerminalManager();
  const app = await createServer({
    logger: false,
    terminalManager: terminalManager as unknown as TerminalManager
  });
  await app.listen({ port: 0 });
  const username = process.env.ALLOWED_USERNAME?.trim() || 'process-auth-user';
  const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
  const accessToken = jwt.sign(
    {
      sub: `process-auth-${Date.now()}`,
      username
    },
    secret,
    { expiresIn: '1h' }
  );

  try {
    return await fn({ app, accessToken });
  } finally {
    await app.close();
  }
}

describe('Process log route auth', () => {
  it('rejects authenticated stop requests for unmanaged processes', async () => {
    await withApp(async ({ app, accessToken }) => {
      const response = await supertest(app.server)
        .post('/api/processes/stop')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ pid: 999999 })
        .expect(403);

      expect(response.body.error).toBe('Process is not managed by this app');
    });
  });

  it('allows unauthenticated GET on process log listing', async () => {
    await withApp(async ({ app }) => {
      const response = await supertest(app.server)
        .get('/api/process-logs')
        .expect(200);

      expect(response.body).toMatchObject({
        count: expect.any(Number),
        processes: expect.any(Array)
      });
    });
  });

  it('requires auth for process log deletion', async () => {
    await withApp(async ({ app, accessToken }) => {
      await supertest(app.server)
        .delete('/api/process-logs/123')
        .expect(401);

      await supertest(app.server)
        .delete('/api/process-logs/123')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });
  });
});
