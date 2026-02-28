import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('session metadata store', () => {
  let tempDataDir = '';
  let previousTerminalDataDir: string | undefined;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousTerminalDataDir = process.env.TERMINAL_DATA_DIR;
    previousDataDir = process.env.DATA_DIR;
    tempDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-v4-session-store-'));
    process.env.TERMINAL_DATA_DIR = tempDataDir;
    delete process.env.DATA_DIR;
    vi.resetModules();
  });

  afterEach(async () => {
    if (previousTerminalDataDir === undefined) {
      delete process.env.TERMINAL_DATA_DIR;
    } else {
      process.env.TERMINAL_DATA_DIR = previousTerminalDataDir;
    }

    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }

    vi.resetModules();
    await fs.rm(tempDataDir, { recursive: true, force: true });
  });

  it('preserves concurrent metadata updates for the same user', async () => {
    const sessionStore = await import('../src/terminal/session-store');
    const userId = 'metadata-user';
    const createdAt = new Date().toISOString();

    await Promise.all([
      sessionStore.updateSessionMetadata(userId, 'session-a', {
        title: 'Session A',
        shell: 'bash',
        cwd: process.cwd(),
        createdAt
      }),
      sessionStore.updateSessionMetadata(userId, 'session-b', {
        title: 'Session B',
        shell: 'bash',
        cwd: process.cwd(),
        createdAt
      })
    ]);

    const index = await sessionStore.listSessionMetadata(userId);
    expect(Object.keys(index).sort()).toEqual(['session-a', 'session-b']);
  });
});
