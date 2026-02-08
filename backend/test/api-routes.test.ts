import { describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { createServer } from '../src/index';
import { register } from '../src/auth/auth-service';
import type { TerminalManager } from '../src/terminal/terminal-manager';
import type { TerminalSessionSnapshot } from '../src/terminal/terminal-types';

type TerminalManagerContract = Pick<
  TerminalManager,
  'initialize' | 'listSessions' | 'createSession' | 'getSession' | 'write' | 'subscribe' | 'resize' | 'close' | 'renameSession'
>;

async function withApp<T>(
  fn: (context: {
    app: Awaited<ReturnType<typeof createServer>>;
    terminalManager: TerminalManagerContract;
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
  const username = `api-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const auth = await register(username, 'test-password-123');

  try {
    return await fn({ app, terminalManager, accessToken: auth.tokens.accessToken });
  } finally {
    await app.close();
  }
}

describe('API routes', () => {
  it('creates a terminal session', async () => {
    await withApp(async ({ app, terminalManager, accessToken }) => {
      const response = await supertest(app.server)
        .post('/api/terminal')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(201);

      expect(response.body.session).toMatchObject({
        id: 'term-1',
        title: 'Terminal 1'
      });
      expect(terminalManager.createSession).toHaveBeenCalled();
    });
  });

  it('validates terminal payload', async () => {
    await withApp(async ({ app, accessToken }) => {
      const response = await supertest(app.server)
        .post('/api/terminal')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ cols: -1 })
        .expect(400);

      expect(response.body.error).toBe('Invalid terminal request body');
    });
  });

  it('sends terminal input', async () => {
    await withApp(async ({ app, terminalManager, accessToken }) => {
      await supertest(app.server)
        .post('/api/terminal/term-1/input')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ command: 'ls' })
        .expect(204);

      expect(terminalManager.write).toHaveBeenCalledWith(
        expect.any(String),
        'term-1',
        'ls'
      );
    });
  });

  it('returns terminal history', async () => {
    await withApp(async ({ app, accessToken }) => {
      const response = await supertest(app.server)
        .get('/api/terminal/term-1/history')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.id).toBe('term-1');
    });
  });

  it('renames a terminal session', async () => {
    await withApp(async ({ app, terminalManager, accessToken }) => {
      const response = await supertest(app.server)
        .patch('/api/terminal/term-1')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Renamed Terminal' })
        .expect(200);

      expect(response.body.session).toMatchObject({
        id: 'term-1',
        title: 'Renamed Terminal'
      });
      expect(terminalManager.renameSession).toHaveBeenCalledWith(
        expect.any(String),
        'term-1',
        'Renamed Terminal'
      );
    });
  });

  it('closes a terminal session', async () => {
    await withApp(async ({ app, terminalManager, accessToken }) => {
      await supertest(app.server)
        .delete('/api/terminal/term-1')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      expect(terminalManager.close).toHaveBeenCalledWith(expect.any(String), 'term-1');
    });
  });

  it('returns 404 when closing a missing terminal session', async () => {
    await withApp(async ({ app, terminalManager, accessToken }) => {
      const closeMock = terminalManager.close as unknown as ReturnType<typeof vi.fn>;
      closeMock.mockReturnValueOnce(false);

      const response = await supertest(app.server)
        .delete('/api/terminal/term-missing')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(response.body.error).toBe('Terminal session not found');
    });
  });
});
