import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TerminalManager } from '../src/terminal/terminal-manager';
import { MAX_BUFFER_CHARS } from '../src/terminal/types';
import type {
  TerminalProcess,
  TerminalSpawnOptions
} from '../src/terminal/terminal-types';

const TEST_USER_ID = 'test-user-123';
const OTHER_TEST_USER_ID = 'test-user-456';

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
    vi.useFakeTimers();
    try {
      const fakeProcess = new FakeTerminalProcess();
      const spawnMock = vi.fn((_options: TerminalSpawnOptions) => fakeProcess);
      const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

      const snapshot = manager.createSession(TEST_USER_ID, { title: 'Demo Terminal', cols: 80, rows: 24 });
      expect(snapshot.title).toBe('Demo Terminal');
      expect(spawnMock).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 80, rows: 24 })
      );

      const subscriber = vi.fn();
      manager.subscribe(TEST_USER_ID, snapshot.id, subscriber);

      fakeProcess.emit('data', 'hello\n');
      vi.advanceTimersByTime(20);
      expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello\n' }));

      const history = manager.getSession(TEST_USER_ID, snapshot.id);
      expect(history?.history).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('batches rapid PTY output into one subscriber event', () => {
    vi.useFakeTimers();
    try {
      const fakeProcess = new FakeTerminalProcess();
      const manager = new TerminalManager({ spawnTerminal: vi.fn(() => fakeProcess), useTmux: false });
      const snapshot = manager.createSession(TEST_USER_ID);
      const subscriber = vi.fn();

      manager.subscribe(TEST_USER_ID, snapshot.id, subscriber);
      fakeProcess.emit('data', 'hello ');
      fakeProcess.emit('data', 'world');

      expect(subscriber).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);

      expect(subscriber).toHaveBeenCalledTimes(1);
      expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello world' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports sequence-based incremental history when multiple events share a timestamp', () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const fakeProcess = new FakeTerminalProcess();
      const manager = new TerminalManager({ spawnTerminal: vi.fn(() => fakeProcess), useTmux: false });
      const snapshot = manager.createSession(TEST_USER_ID);

      fakeProcess.emit('data', 'one\n');
      vi.advanceTimersByTime(20);
      fakeProcess.emit('data', 'two\n');
      vi.advanceTimersByTime(20);
      fakeProcess.emit('data', 'three\n');
      vi.advanceTimersByTime(20);

      const full = manager.getSession(TEST_USER_ID, snapshot.id);
      expect(full?.history).toHaveLength(3);
      expect(full?.history.every((entry) => entry.ts === 1_700_000_000_000)).toBe(true);
      expect(full?.history.map((entry) => entry.seq)).toEqual([1, 2, 3]);

      const afterTs = manager.getSession(TEST_USER_ID, snapshot.id, { afterTs: 1_700_000_000_000 });
      expect(afterTs?.history).toHaveLength(0);

      const afterSeq = manager.getSession(TEST_USER_ID, snapshot.id, { afterSeq: 1 });
      expect(afterSeq?.history.map((entry) => entry.text)).toEqual(['two\n', 'three\n']);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('writes input with newline normalisation and supports resize/close', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

    const snapshot = manager.createSession(TEST_USER_ID);
    manager.write(TEST_USER_ID, snapshot.id, 'ls\n');
    expect(fakeProcess.writes[0]).toContain('ls');

    manager.resize(TEST_USER_ID, snapshot.id, 100, 40);
    expect(fakeProcess.resized).toContainEqual({ cols: 100, rows: 40 });

    const closed = manager.close(TEST_USER_ID, snapshot.id);
    expect(closed).toBe(true);
    expect(fakeProcess.killed).toBe(true);
    expect(manager.listSessions(TEST_USER_ID)).toHaveLength(0);
  });

  it('uses a single primary client for PTY resize ownership', () => {
    const fakeProcess = new FakeTerminalProcess();
    const manager = new TerminalManager({ spawnTerminal: vi.fn(() => fakeProcess), useTmux: false });
    const snapshot = manager.createSession(TEST_USER_ID, { cols: 80, rows: 24 });

    manager.resize(TEST_USER_ID, snapshot.id, 101, 41, 'client-a', { priority: true });
    expect(fakeProcess.resized).toContainEqual({ cols: 101, rows: 41 });

    const resizeCountAfterOwner = fakeProcess.resized.length;
    manager.resize(TEST_USER_ID, snapshot.id, 60, 20, 'client-b');
    expect(fakeProcess.resized).toHaveLength(resizeCountAfterOwner);

    const current = manager.getSession(TEST_USER_ID, snapshot.id);
    expect(current?.currentCols).toBe(101);
    expect(current?.currentRows).toBe(41);

    manager.resize(TEST_USER_ID, snapshot.id, 90, 30, 'client-b', { priority: true });
    expect(fakeProcess.resized).toContainEqual({ cols: 90, rows: 30 });
    const promoted = manager.getSession(TEST_USER_ID, snapshot.id);
    expect(promoted?.currentCols).toBe(90);
    expect(promoted?.currentRows).toBe(30);
  });

  it('reassigns PTY resize ownership when the primary client disconnects', () => {
    const fakeProcess = new FakeTerminalProcess();
    const manager = new TerminalManager({ spawnTerminal: vi.fn(() => fakeProcess), useTmux: false });
    const snapshot = manager.createSession(TEST_USER_ID, { cols: 80, rows: 24 });

    manager.resize(TEST_USER_ID, snapshot.id, 120, 40, 'client-a', { priority: true });
    manager.resize(TEST_USER_ID, snapshot.id, 95, 28, 'client-b');

    const beforeRemove = fakeProcess.resized.length;
    manager.removeClient(TEST_USER_ID, snapshot.id, 'client-a');

    expect(fakeProcess.resized.length).toBeGreaterThan(beforeRemove);
    expect(fakeProcess.resized[fakeProcess.resized.length - 1]).toEqual({ cols: 95, rows: 28 });

    const current = manager.getSession(TEST_USER_ID, snapshot.id);
    expect(current?.currentCols).toBe(95);
    expect(current?.currentRows).toBe(28);
  });

  it('does not allow one user to close another user terminal session', () => {
    const fakeProcess = new FakeTerminalProcess();
    const manager = new TerminalManager({ spawnTerminal: vi.fn(() => fakeProcess), useTmux: false });
    const snapshot = manager.createSession(TEST_USER_ID);

    const closed = manager.close(OTHER_TEST_USER_ID, snapshot.id);

    expect(closed).toBe(false);
    expect(fakeProcess.killed).toBe(false);
    expect(manager.isActive(snapshot.id)).toBe(true);
  });

  it('falls back to a safe cwd when given a non-existent cwd', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn((options: TerminalSpawnOptions) => {
      // Assert from inside to keep expectations close to the behaviour.
      expect(options.cwd).toBe(process.env.HOME || process.cwd());
      return fakeProcess;
    });
    const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

    manager.createSession(TEST_USER_ID, { cwd: '/this/path/should/not/exist' });
    expect(spawnMock).toHaveBeenCalled();
  });

  it('updates stored cwd when receiving a full cd command payload (UI-driven navigation)', async () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

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

  it('updates stored cwd when cd input arrives in incremental chunks', async () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

    const snapshot = manager.createSession(TEST_USER_ID, { cwd: process.cwd() });
    const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-cwd-'));

    try {
      manager.write(TEST_USER_ID, snapshot.id, 'c');
      manager.write(TEST_USER_ID, snapshot.id, 'd ');
      manager.write(TEST_USER_ID, snapshot.id, `"${tmpDir}"`);
      manager.write(TEST_USER_ID, snapshot.id, '\n');

      const projectInfo = await manager.getProjectInfo(TEST_USER_ID, snapshot.id);
      expect(projectInfo?.cwd).toBe(tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('caps buffered output to avoid unbounded memory growth', () => {
    vi.useFakeTimers();
    try {
      const fakeProcess = new FakeTerminalProcess();
      const spawnMock = vi.fn(() => fakeProcess);
      const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

      const snapshot = manager.createSession(TEST_USER_ID);

      const chunkA = 'A'.repeat(8_000_000);
      const chunkB = 'B'.repeat(8_000_000);
      const chunkC = 'C'.repeat(8_000_000);
      fakeProcess.emit('data', chunkA);
      fakeProcess.emit('data', chunkB);
      fakeProcess.emit('data', chunkC);
      vi.advanceTimersByTime(20);

      const history = manager.getSession(TEST_USER_ID, snapshot.id);
      const totalChars = history?.history.reduce((sum, entry) => sum + entry.text.length, 0) ?? 0;
      expect(totalChars).toBeLessThanOrEqual(MAX_BUFFER_CHARS);
      expect(history?.history[0].text[0]).toBe('B');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renames an active session', async () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock, useTmux: false });

    const snapshot = manager.createSession(TEST_USER_ID, { title: 'Old Name' });
    const updated = await manager.renameSession(TEST_USER_ID, snapshot.id, 'New Name');

    expect(updated?.title).toBe('New Name');
    expect(manager.getSession(TEST_USER_ID, snapshot.id)?.title).toBe('New Name');
  });

  it('enforces maximum active sessions per user when configured', () => {
    const manager = new TerminalManager({
      spawnTerminal: vi.fn(() => new FakeTerminalProcess()),
      useTmux: false,
      maxActiveSessions: 1
    });

    manager.createSession(TEST_USER_ID);
    expect(() => manager.createSession(TEST_USER_ID)).toThrow('Maximum active terminal sessions reached');
  });

  it('expires idle sessions when idle timeout is configured', () => {
    vi.useFakeTimers();
    try {
      const fakeProcess = new FakeTerminalProcess();
      const manager = new TerminalManager({
        spawnTerminal: vi.fn(() => fakeProcess),
        useTmux: false,
        idleTimeoutMs: 50
      });
      const snapshot = manager.createSession(TEST_USER_ID);

      expect(manager.isActive(snapshot.id)).toBe(true);
      vi.advanceTimersByTime(60);
      expect(manager.isActive(snapshot.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
