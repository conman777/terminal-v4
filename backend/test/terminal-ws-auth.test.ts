import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createServer } from '../src/index';
import type { TerminalManager } from '../src/terminal/terminal-manager';
import type { TerminalSessionSnapshot } from '../src/terminal/terminal-types';
import { WebSocket } from 'ws';

// Generate a test token that matches the server's expected format without
// going through register() (which checks ALLOWED_USERNAME in the env).
// The username must match ALLOWED_USERNAME if that env var is set.
function makeTestToken(): string {
  const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
  const username = process.env.ALLOWED_USERNAME?.trim() || 'test-ws-auth-user';
  return jwt.sign({ sub: 'test-user-id', username }, secret, { expiresIn: '1h' });
}

async function withApp<T>(
  fn: (ctx: { port: number; accessToken: string }) => Promise<T>
): Promise<T> {
  const snapshot: TerminalSessionSnapshot = {
    id: 'term-1',
    title: 'Terminal 1',
    shell: 'bash',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: []
  };

  const terminalManager = {
    initialize: vi.fn(async () => {}),
    listSessions: vi.fn(() => []),
    createSession: vi.fn(() => snapshot),
    getSession: vi.fn(() => snapshot),
    getProjectInfo: vi.fn(async () => null),
    write: vi.fn(),
    resize: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    close: vi.fn(() => true),
    isActive: vi.fn(() => true),
    removeClient: vi.fn(),
    restoreSession: vi.fn(() => null)
  };

  const app = await createServer({
    logger: false,
    terminalManager: terminalManager as unknown as TerminalManager
  });
  await app.listen({ port: 0 });

  const address = app.server.address() as { port: number };

  try {
    return await fn({ port: address.port, accessToken: makeTestToken() });
  } finally {
    await app.close();
  }
}

function connectWs(port: number): Promise<{ ws: WebSocket; closeEvent: Promise<{ code: number; reason: string }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/term-1/ws?history=0`);
    const closeEvent = new Promise<{ code: number; reason: string }>((res) => {
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() }));
    });
    ws.on('open', () => resolve({ ws, closeEvent }));
    ws.on('error', reject);
  });
}

describe('Terminal WebSocket auth', () => {
  it('closes with 4401 when a non-auth message type is sent', async () => {
    await withApp(async ({ port }) => {
      const { ws, closeEvent } = await connectWs(port);
      ws.send(JSON.stringify({ type: 'hello', data: 'world' }));
      const { code } = await closeEvent;
      expect(code).toBe(4401);
    });
  });

  it('allows plain terminal input before auth if a valid auth frame follows', async () => {
    await withApp(async ({ port, accessToken }) => {
      const { ws, closeEvent } = await connectWs(port);
      ws.send('ls\r');
      ws.send(JSON.stringify({ type: 'auth', token: accessToken }));

      const raceResult = await Promise.race([
        closeEvent.then(e => ({ kind: 'close' as const, code: e.code })),
        new Promise<{ kind: 'timeout' }>(res => setTimeout(() => res({ kind: 'timeout' }), 500))
      ]);

      ws.close();

      if (raceResult.kind === 'close') {
        expect(raceResult.code).not.toBe(4401);
      } else {
        expect(raceResult.kind).toBe('timeout');
      }
    });
  });

  it('closes with 4401 when an invalid token is sent', async () => {
    await withApp(async ({ port }) => {
      const { ws, closeEvent } = await connectWs(port);
      ws.send(JSON.stringify({ type: 'auth', token: 'invalid.token.here' }));
      const { code } = await closeEvent;
      expect(code).toBe(4401);
    });
  });

  it('does not close with 4401 when a valid token is sent', async () => {
    await withApp(async ({ port, accessToken }) => {
      const { ws, closeEvent } = await connectWs(port);
      ws.send(JSON.stringify({ type: 'auth', token: accessToken }));

      // A 4401 close arrives quickly on auth failure; a valid session stays open.
      const raceResult = await Promise.race([
        closeEvent.then(e => ({ kind: 'close' as const, code: e.code })),
        new Promise<{ kind: 'timeout' }>(res => setTimeout(() => res({ kind: 'timeout' }), 500))
      ]);

      ws.close();

      if (raceResult.kind === 'close') {
        expect(raceResult.code).not.toBe(4401);
      } else {
        expect(raceResult.kind).toBe('timeout');
      }
    });
  });
});
