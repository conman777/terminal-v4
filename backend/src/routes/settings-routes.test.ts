import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, getDatabase } from '../database/db';
import { registerSettingsRoutes } from './settings-routes';

function buildApp(userId: string) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.userId = userId;
  });
  return app;
}

describe('settings-routes desktop terminal input preference', () => {
  let tempDir = '';
  let userId = '';
  const originalDataDir = process.env.TERMINAL_DATA_DIR;

  function seedUser(id: string) {
    const db = getDatabase();
    db.prepare(
      'INSERT OR REPLACE INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, `test-${id}`, 'hash', new Date().toISOString(), new Date().toISOString());
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-v4-settings-'));
    process.env.TERMINAL_DATA_DIR = tempDir;
    closeDatabase();
    userId = randomUUID();
    seedUser(userId);
  });

  afterEach(() => {
    closeDatabase();
    if (originalDataDir === undefined) {
      delete process.env.TERMINAL_DATA_DIR;
    } else {
      process.env.TERMINAL_DATA_DIR = originalDataDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults desktop terminal input to disabled for new users', async () => {
    const app = buildApp(userId);
    await registerSettingsRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      desktopAllowTerminalInput: null,
    });

    await app.close();
  });

  it('persists desktop terminal input preference updates', async () => {
    const app = buildApp(userId);
    await registerSettingsRoutes(app);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { desktopAllowTerminalInput: true },
    });

    expect(patchResponse.statusCode).toBe(200);

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/settings',
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      desktopAllowTerminalInput: true,
    });

    await app.close();
  });
});
