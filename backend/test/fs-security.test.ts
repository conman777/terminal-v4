import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createServer } from '../src/index';
import { EventEmitter } from 'node:events';
import type { TerminalProcess, TerminalSpawnOptions } from '../src/terminal/terminal-types';

class FakeTerminalProcess extends EventEmitter implements TerminalProcess {
  write(): void {}
  resize(): void {}
  kill(): void {}
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof createServer>>) => Promise<T>): Promise<T> {
  const spawnMock = (_options: TerminalSpawnOptions) => new FakeTerminalProcess();
  const app = await createServer({ logger: false, terminalOptions: { spawnTerminal: spawnMock } });
  await app.listen({ port: 0 });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

describe('Filesystem & preview sandboxing', () => {
  it('blocks prefix-escape paths for /api/fs/list and /api/fs/download', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const prefixEscape = `${projectRoot}-evil`;

    await withApp(async (app) => {
      await supertest(app.server)
        .get('/api/fs/list')
        .query({ path: prefixEscape })
        .expect(403);

      await supertest(app.server)
        .get('/api/fs/download')
        .query({ path: prefixEscape })
        .expect(403);
    });
  });

  it('blocks symlink escapes for /api/fs/list', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');
    const linkPath = path.join(projectRoot, 'tmp-symlink-test');

    // Point a symlink inside the repo to an external directory.
    try {
      await fs.symlink('/tmp', linkPath);
    } catch (error) {
      // If symlinks are not permitted in this environment, skip the assertion.
      // (The core security check is still covered by the prefix-escape test.)
      return;
    }

    try {
      await withApp(async (app) => {
        await supertest(app.server)
          .get('/api/fs/list')
          .query({ path: linkPath })
          .expect(403);
      });
    } finally {
      await fs.unlink(linkPath).catch(() => {});
    }
  });

  it('blocks previewing files outside the project root', async () => {
    await withApp(async (app) => {
      await supertest(app.server)
        .get('/api/preview')
        .query({ path: '/tmp', file: 'index.html' })
        .expect(403);
    });
  });

  it('prevents traversal in /api/preview file parameter (including prefix-escape)', async () => {
    const projectRoot = path.resolve(process.cwd(), '..');

    await withApp(async (app) => {
      await supertest(app.server)
        .get('/api/preview')
        .query({ path: projectRoot, file: '../terminal-v4-evil/index.html' })
        .expect(403);
    });
  });

  it('streams zip downloads for in-root directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-download-'));

    try {
      await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hello', 'utf-8');

      await withApp(async (app) => {
        const res = await supertest(app.server)
          .get('/api/fs/download')
          .query({ path: tmpDir })
          .expect(200);

        expect(res.headers['content-type']).toContain('application/zip');
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});


