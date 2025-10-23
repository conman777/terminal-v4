import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import path from 'node:path';
import type {
  TerminalCreateOptions,
  TerminalProcess,
  TerminalSessionSnapshot,
  TerminalSessionSummary,
  TerminalSpawnOptions,
  TerminalSpawner,
  TerminalStreamEvent
} from './terminal-types';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

function detectShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function normaliseNewlines(input: string): string {
  if (process.platform === 'win32') {
    return input.replace(/\r?\n/g, '\r\n');
  }
  return input;
}

export interface TerminalManagerOptions {
  spawnTerminal?: TerminalSpawner;
  defaultShell?: string;
}

interface ManagedTerminal {
  id: string;
  title: string;
  shell: string;
  createdAt: string;
  updatedAt: string;
  process: TerminalProcess;
  buffer: TerminalStreamEvent[];
  subscribers: Set<(event: TerminalStreamEvent | null) => void>;
}

function ptySpawner(options: TerminalSpawnOptions): TerminalProcess {
  const emitter = new EventEmitter() as TerminalProcess;

  const ptyProcess = ptySpawn(options.shell, [], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env } as Record<string, string>
  });

  ptyProcess.onData((data: string) => {
    emitter.emit('data', data);
  });

  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    emitter.emit('exit', exitCode, signal ?? null);
  });

  emitter.write = (data: string) => {
    ptyProcess.write(data);
  };

  emitter.resize = (cols: number, rows: number) => {
    ptyProcess.resize(cols, rows);
  };

  emitter.kill = (signal?: NodeJS.Signals | number) => {
    ptyProcess.kill(signal as string);
  };

  return emitter;
}

export class TerminalManager {
  #sessions = new Map<string, ManagedTerminal>();
  #spawnTerminal: TerminalSpawner;
  #defaultShell: string;
  #counter = 0;

  constructor(options: TerminalManagerOptions = {}) {
    this.#spawnTerminal = options.spawnTerminal ?? ptySpawner;
    this.#defaultShell = options.defaultShell ?? detectShell();
  }

  listSessions(): TerminalSessionSummary[] {
    return Array.from(this.#sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.buffer.length
    }));
  }

  getSession(id: string): TerminalSessionSnapshot | null {
    const session = this.#sessions.get(id);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      title: session.title,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      history: [...session.buffer]
    };
  }

  #handleData(session: ManagedTerminal, chunk: string) {
    const event: TerminalStreamEvent = {
      text: chunk,
      ts: Date.now()
    };
    session.buffer.push(event);
    session.updatedAt = new Date().toISOString();
    session.subscribers.forEach((subscriber) => subscriber(event));
  }

  #handleExit(session: ManagedTerminal, code: number | null, signal: NodeJS.Signals | null) {
    session.subscribers.forEach((subscriber) => subscriber(null));
    this.#sessions.delete(session.id);
  }

  createSession(options: TerminalCreateOptions = {}): TerminalSessionSnapshot {
    const id = options.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const title = options.title ?? `Terminal ${++this.#counter}`;
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const shell = options.shell ?? this.#defaultShell;

    const process = this.#spawnTerminal({
      shell,
      cols,
      rows,
      cwd: options.cwd,
      env: options.env
    });

    const session: ManagedTerminal = {
      id,
      title,
      shell,
      createdAt,
      updatedAt: createdAt,
      process,
      buffer: [],
      subscribers: new Set()
    };

    process.on('data', (data: string) => this.#handleData(session, data));
    process.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(session, code, signal);
    });

    this.#sessions.set(id, session);

    return this.getSession(id)!;
  }

  subscribe(id: string, handler: (event: TerminalStreamEvent | null) => void): () => void {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error(`Terminal session ${id} not found`);
    }

    session.subscribers.add(handler);
    return () => {
      session.subscribers.delete(handler);
    };
  }

  write(id: string, input: string): void {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error(`Terminal session ${id} not found`);
    }

    session.process.write(normaliseNewlines(input));
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error(`Terminal session ${id} not found`);
    }
    session.process.resize(cols, rows);
  }

  close(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) {
      return;
    }
    session.process.kill();
    this.#sessions.delete(id);
  }
}
