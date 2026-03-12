import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createServer } from '../src/index';
import { generateAccessToken } from '../src/auth/auth-service';
import { createUser } from '../src/auth/user-store';
import bcrypt from 'bcrypt';
import { getDatabase } from '../src/database/db';
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
    history: [],
    usesTmux: false,
    sandbox: {
      mode: 'off',
      workspaceRoot: null,
      runtimeId: null,
      runtimeKind: 'local-host'
    }
  };

  const terminalManager: TerminalManagerContract = {
    initialize: async () => {},
    listSessions: () => [],
    createSession: () => terminalSession,
    getSession: () => terminalSession,
    write: () => {},
    subscribe: () => () => {},
    resize: () => {},
    close: () => true,
    renameSession: async (_userId: string, id: string, title: string) => ({
      id,
      title,
      shell: 'bash',
      createdAt: terminalSession.createdAt,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      isActive: true
    })
  };

  const app = await createServer({
    logger: false,
    terminalManager: terminalManager as unknown as TerminalManager
  });
  await app.listen({ port: 0 });

  const username = `vault-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const passwordHash = bcrypt.hashSync('test-password-123', 10);
  const user = createUser(username, passwordHash);
  const accessToken = generateAccessToken(user);

  try {
    return await fn({ app, accessToken });
  } finally {
    await app.close();
  }
}

describe('Vault routes', () => {
  afterEach(() => {
    const db = getDatabase();
    db.prepare("DELETE FROM api_key_vault WHERE key_name LIKE 'vault-test-%'").run();
  });

  it('stores encrypted values while revealing the original secret to the owner', async () => {
    await withApp(async ({ app, accessToken }) => {
      const createResponse = await supertest(app.server)
        .post('/api/vault')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'vault-test-openai', value: 'sk-test-123456' })
        .expect(200);

      expect(createResponse.body.key.maskedValue).toBe('****3456');

      const db = getDatabase();
      const row = db.prepare('SELECT key_value FROM api_key_vault WHERE id = ?').get(createResponse.body.key.id) as
        | { key_value: string }
        | undefined;

      expect(row?.key_value).toMatch(/^enc:v1:/);
      expect(row?.key_value).not.toContain('sk-test-123456');

      const revealResponse = await supertest(app.server)
        .get(`/api/vault/${createResponse.body.key.id}/reveal`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(revealResponse.body).toEqual({ value: 'sk-test-123456' });
    });
  });
});
