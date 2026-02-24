import { describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { createServer } from '../src/index';
import type { TerminalSessionSnapshot } from '../src/terminal/terminal-types';
import type { TerminalManager } from '../src/terminal/terminal-manager';

function makeTestAccessToken(): string {
  const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
  const username = process.env.ALLOWED_USERNAME?.trim() || 'terminal-stream-test-user';
  return jwt.sign({ sub: 'test-user-id', username }, secret, { expiresIn: '1h' });
}

describe('Terminal SSE stream', () => {
  it('streams history and ends immediately for inactive (persisted) sessions', async () => {
    const snapshot: TerminalSessionSnapshot = {
      id: 'term-1',
      title: 'Terminal 1',
      shell: 'bash',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ text: 'hello\n', ts: 123 }]
    };

    class StubTerminalManager {
      initialize = vi.fn(async () => {});
      listSessions = vi.fn(() => []);
      createSession = vi.fn(() => snapshot);
      getSession = vi.fn(() => snapshot);
      getProjectInfo = vi.fn(async () => null);
      write = vi.fn();
      resize = vi.fn();
      subscribe = vi.fn(() => {
        throw new Error('subscribe should not be called for inactive sessions');
      });
      close = vi.fn();
      restoreSession = vi.fn(() => null);
      isActive = vi.fn(() => false);
    }

    const terminalManager = new StubTerminalManager();
    const app = await createServer({
      logger: false,
      terminalManager: terminalManager as unknown as TerminalManager
    });
    await app.listen({ port: 0 });
    const accessToken = makeTestAccessToken();

    try {
      const res = await supertest(app.server)
        .get('/api/terminal/term-1/stream')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.text).toContain('event: data');
      expect(res.text).toContain('hello');
      expect(res.text).toContain('event: end');
    } finally {
      await app.close();
    }
  });
});
