import Fastify from 'fastify';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerClaudeCodeRoutes } from '../src/claude-code/claude-code-routes';

const TEST_USER_ID = 'test-user-123';
const TEST_USERNAME = 'test-user';

function createAuthedApp() {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    request.userId = TEST_USER_ID;
    request.username = TEST_USERNAME;
  });
  return app;
}

describe('Claude Code routes', () => {
  it('creates a new Claude Code session', async () => {
    const app = createAuthedApp();

    const createSession = vi.fn((_userId: string, cwd: string) => ({
      id: 'cc-1',
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      events: [],
      isActive: false
    }));

    const manager = {
      loadUserSessions: vi.fn(async () => {}),
      getAllSessions: vi.fn(() => []),
      createSession,
      getSession: vi.fn(() => null),
      subscribe: vi.fn(() => () => {}),
      sendInput: vi.fn(async () => {}),
      restoreSession: vi.fn(),
      stopSession: vi.fn(),
      deleteSession: vi.fn(),
      updateCwd: vi.fn()
    } as any;

    await registerClaudeCodeRoutes(app, manager);
    await app.listen({ port: 0 });

    try {
      const res = await supertest(app.server)
        .post('/api/claude-code/start')
        .send({})
        .expect(200);

      expect(createSession).toHaveBeenCalledWith(TEST_USER_ID, process.cwd(), 'sonnet');
      expect(res.body).toMatchObject({ id: 'cc-1', cwd: process.cwd() });
    } finally {
      await app.close();
    }
  });

  it('validates input payload and forwards to manager', async () => {
    const app = createAuthedApp();

    const sendInput = vi.fn(async () => {});
    const manager = {
      loadUserSessions: vi.fn(async () => {}),
      getAllSessions: vi.fn(() => []),
      createSession: vi.fn(),
      getSession: vi.fn(() => ({ id: 'cc-1', cwd: process.cwd(), createdAt: 0, updatedAt: 0, events: [], isActive: false })),
      subscribe: vi.fn(() => () => {}),
      sendInput,
      restoreSession: vi.fn(),
      stopSession: vi.fn(),
      deleteSession: vi.fn(),
      updateCwd: vi.fn()
    } as any;

    await registerClaudeCodeRoutes(app, manager);
    await app.listen({ port: 0 });

    try {
      await supertest(app.server)
        .post('/api/claude-code/cc-1/input')
        .send({})
        .expect(400);

      const ok = await supertest(app.server)
        .post('/api/claude-code/cc-1/input')
        .send({ text: 'hi' })
        .expect(200);

      expect(ok.body).toEqual({ success: true });
      expect(sendInput).toHaveBeenCalledWith(TEST_USER_ID, 'cc-1', 'hi');
    } finally {
      await app.close();
    }
  });

  it('lists sessions and updates cwd', async () => {
    const app = createAuthedApp();

    const updateCwd = vi.fn((_userId: string, _id: string, cwd: string) => ({
      id: 'cc-1',
      cwd,
      createdAt: 0,
      updatedAt: 0,
      events: [],
      isActive: false
    }));

    const manager = {
      loadUserSessions: vi.fn(async () => {}),
      getAllSessions: vi.fn(() => [{ id: 'cc-1', cwd: 'C:\\tmp', createdAt: 0, updatedAt: 0, events: [], isActive: false }]),
      createSession: vi.fn(),
      getSession: vi.fn(() => null),
      subscribe: vi.fn(() => () => {}),
      sendInput: vi.fn(async () => {}),
      restoreSession: vi.fn(),
      stopSession: vi.fn(),
      deleteSession: vi.fn(),
      updateCwd
    } as any;

    await registerClaudeCodeRoutes(app, manager);
    await app.listen({ port: 0 });

    try {
      const list = await supertest(app.server)
        .get('/api/claude-code')
        .expect(200);

      expect(list.body.sessions).toHaveLength(1);
      expect(list.body.sessions[0]).toMatchObject({ id: 'cc-1' });

      await supertest(app.server)
        .patch('/api/claude-code/cc-1/cwd')
        .send({})
        .expect(400);

      const patched = await supertest(app.server)
        .patch('/api/claude-code/cc-1/cwd')
        .send({ cwd: 'C:\\new' })
        .expect(200);

      expect(updateCwd).toHaveBeenCalledWith(TEST_USER_ID, 'cc-1', 'C:\\new');
      expect(patched.body).toMatchObject({ id: 'cc-1', cwd: 'C:\\new' });
    } finally {
      await app.close();
    }
  });
});
