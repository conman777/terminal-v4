import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createServer } from '../src/index';
import { register } from '../src/auth/auth-service';
import { EventEmitter } from 'node:events';
import type { TerminalProcess, TerminalSpawnOptions } from '../src/terminal/terminal-types';

class FakeTerminalProcess extends EventEmitter implements TerminalProcess {
  write(): void {}
  resize(): void {}
  kill(): void {}
}

async function withApp<T>(
  fn: (context: { app: Awaited<ReturnType<typeof createServer>>; accessToken: string }) => Promise<T>
): Promise<T> {
  const spawnMock = (_options: TerminalSpawnOptions) => new FakeTerminalProcess();
  const app = await createServer({ logger: false, terminalOptions: { spawnTerminal: spawnMock } });
  await app.listen({ port: 0 });
  const username = `fs-security-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const auth = await register(username, 'test-password-123');
  try {
    return await fn({ app, accessToken: auth.tokens.accessToken });
  } finally {
    await app.close();
  }
}

describe('Filesystem & preview sandboxing', () => {
  it('allows /api/fs/list outside the project root', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-v4-fs-list-'));
    try {
      await withApp(async ({ app, accessToken }) => {
        await supertest(app.server)
          .get('/api/fs/list')
          .set('Authorization', `Bearer ${accessToken}`)
          .query({ path: tmpDir })
          .expect(200);
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('blocks previewing files outside the project root', async () => {
    await withApp(async ({ app, accessToken }) => {
      await supertest(app.server)
        .get('/api/preview')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ path: '/tmp', file: 'index.html' })
        .expect(403);
    });
  });

  it('prevents traversal in /api/preview file parameter (including prefix-escape)', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');

    await withApp(async ({ app, accessToken }) => {
      await supertest(app.server)
        .get('/api/preview')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ path: projectRoot, file: '../terminal-v4-evil/index.html' })
        .expect(403);
    });
  });

  it('streams zip downloads for directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-v4-download-'));

    try {
      await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hello', 'utf-8');

      await withApp(async ({ app, accessToken }) => {
        const res = await supertest(app.server)
          .get('/api/fs/download')
          .set('Authorization', `Bearer ${accessToken}`)
          .query({ path: tmpDir })
          .expect(200);

        expect(res.headers['content-type']).toContain('application/zip');
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
