import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import path from 'node:path';
import os from 'node:os';
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
  it('allows /api/fs/list outside the project root', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-v4-fs-list-'));
    try {
      await withApp(async (app) => {
        await supertest(app.server)
          .get('/api/fs/list')
          .query({ path: tmpDir })
          .expect(200);
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
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

  it('streams zip downloads for directories', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-v4-download-'));

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

