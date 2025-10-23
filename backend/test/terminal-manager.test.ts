import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../src/terminal/terminal-manager';
import type {
  TerminalProcess,
  TerminalSpawnOptions
} from '../src/terminal/terminal-types';

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

    const snapshot = manager.createSession({ title: 'Demo Terminal', cols: 80, rows: 24 });
    expect(snapshot.title).toBe('Demo Terminal');
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24 })
    );

    const subscriber = vi.fn();
    manager.subscribe(snapshot.id, subscriber);

    fakeProcess.emit('data', 'hello\n');
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello\n' }));

    const history = manager.getSession(snapshot.id);
    expect(history?.history).toHaveLength(1);
  });

  it('writes input with newline normalisation and supports resize/close', () => {
    const fakeProcess = new FakeTerminalProcess();
    const spawnMock = vi.fn(() => fakeProcess);
    const manager = new TerminalManager({ spawnTerminal: spawnMock });

    const snapshot = manager.createSession();
    manager.write(snapshot.id, 'ls\n');
    expect(fakeProcess.writes[0]).toContain('ls');

    manager.resize(snapshot.id, 100, 40);
    expect(fakeProcess.resized).toContainEqual({ cols: 100, rows: 40 });

    manager.close(snapshot.id);
    expect(fakeProcess.killed).toBe(true);
    expect(manager.listSessions()).toHaveLength(0);
  });
});
