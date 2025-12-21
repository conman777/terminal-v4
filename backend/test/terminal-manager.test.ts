import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TerminalManager } from '../src/terminal/terminal-manager';
import type {
  TerminalProcess,
  TerminalSpawnOptions
} from '../src/terminal/terminal-types';

const TEST_USER_ID = 'test-user-123';

class FakeTerminalProcess extends EventEmitter implements TerminalProcess {
  writes: string[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', 0, null);
  }
}

describe('TerminalManager', () => {
  it('creates sessions and streams output to subscribers', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn((_options: TerminalSpawnOptions) => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    const snapshot = manager.createSession(TEST_USER_ID, { title: 'Demo Terminal', cols: 80, rows: 24 });
    expect(snapshot.title).toBe('Demo Terminal');
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24 })
    );

    const subscriber = vi.fn();
    manager.subscribe(TEST_USER_ID, snapshot.id, subscriber);

    fakeProcess.emit('data', 'hello\n');
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello\n' }));

    const history = manager.getSession(TEST_USER_ID, snapshot.id);
    expect(history?.history).toHaveLength(1);
  });

  it('writes input with newline normalisation and supports resize/close', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    const snapshot = manager.createSession(TEST_USER_ID);
    manager.write(TEST_USER_ID, snapshot.id, 'ls\n');
    expect(fakeProcess.writes[0]).toContain('ls');

    manager.resize(TEST_USER_ID, snapshot.id, 100, 40);
    expect(fakeProcess.resized).toContainEqual({ cols: 100, rows: 40 });

    manager.close(TEST_USER_ID, snapshot.id);
    expect(fakeProcess.killed).toBe(true);
    expect(manager.listSessions(TEST_USER_ID)).toHaveLength(0);
  });

  it('falls back to a safe cwd when given a non-existent cwd', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn((options: TerminalSpawnOptions) => {
      // Assert from inside to keep expectations close to the behaviour.
      expect(options.cwd).toBe(process.cwd());
      return fakeProcess;
    });
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    manager.createSession(TEST_USER_ID, { cwd: '/this/path/should/not/exist' });
    expect(spawnMock).toHaveBeenCalled();
  });

  it('updates stored cwd when receiving a full cd command payload (UI-driven navigation)', async () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    const snapshot = manager.createSession(TEST_USER_ID, { cwd: process.cwd() });
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-cwd-'));

    try {
      // This mimics App.jsx sending a full command with a newline terminator.
      manager.write(TEST_USER_ID, snapshot.id, `cd "${tmpDir}"\n`);
      const projectInfo = await manager.getProjectInfo(TEST_USER_ID, snapshot.id);
      expect(projectInfo?.cwd).toBe(tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('caps buffered output to avoid unbounded memory growth', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    const snapshot = manager.createSession(TEST_USER_ID);

    const chunkA = 'A'.repeat(1_100_000);
    const chunkB = 'B'.repeat(1_100_000);
    fakeProcess.emit('data', chunkA);
    fakeProcess.emit('data', chunkB);

    const history = manager.getSession(TEST_USER_ID, snapshot.id);
    expect(history?.history).toHaveLength(1);
    expect(history?.history[0].text[0]).toBe('B');
  });
});
