import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn as ptySpawn } from '@homebridge/node-pty-prebuilt-multiarch';
import path from 'node:path';
import fs from 'node:fs';
import type {
  TerminalCreateOptions,
  TerminalProcess,
  TerminalSessionSnapshot,
  TerminalSessionSummary,
  TerminalSpawnOptions,
  TerminalSpawner,
  TerminalStreamEvent
} from './terminal-types';
import {
  saveSession,
  loadSession,
  deleteSession,
  loadAllSessions,
  type PersistedSession
} from './session-store';

export type ProjectType = 'node' | 'python-flask' | 'django' | 'rust' | 'go' | 'static' | 'unknown';

export interface ProjectInfo {
  cwd: string;
  projectType: ProjectType;
  projectName?: string;
  startCommand?: string;
  indexPath?: string;
}

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
  cwd: string;
  createdAt: string;
  updatedAt: string;
  process: TerminalProcess;
  buffer: TerminalStreamEvent[];
  subscribers: Set<(event: TerminalStreamEvent | null) => void>;
  saveTimer?: NodeJS.Timeout;
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
  #persistedSessions = new Map<string, PersistedSession>();
  #spawnTerminal: TerminalSpawner;
  #defaultShell: string;
  #counter = 0;
  #initialized = false;

  constructor(options: TerminalManagerOptions = {}) {
    this.#spawnTerminal = options.spawnTerminal ?? ptySpawner;
    this.#defaultShell = options.defaultShell ?? detectShell();
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;

    // Load all persisted sessions on startup
    const persisted = await loadAllSessions();
    for (const session of persisted) {
      this.#persistedSessions.set(session.id, session);
    }
    this.#initialized = true;
    console.log(`Loaded ${persisted.length} persisted terminal sessions`);
  }

  // Schedule a debounced save for this session
  #scheduleSave(session: ManagedTerminal): void {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
    }
    // Save after 2 seconds of inactivity
    session.saveTimer = setTimeout(() => {
      this.#saveSessionToDisk(session);
    }, 2000);
  }

  async #saveSessionToDisk(session: ManagedTerminal): Promise<void> {
    const persisted: PersistedSession = {
      id: session.id,
      title: session.title,
      shell: session.shell,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      history: session.buffer
    };
    await saveSession(persisted);
    this.#persistedSessions.set(session.id, persisted);
  }

  // Get the current working directory by executing pwd/cd command
  async #getCurrentCwd(session: ManagedTerminal): Promise<string> {
    return new Promise((resolve) => {
      // Use a unique marker to identify our command output
      const marker = `__CWD_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
      let output = '';
      let timeoutId: NodeJS.Timeout;

      const handler = (event: TerminalStreamEvent | null) => {
        if (event === null) {
          cleanup();
          resolve(session.cwd); // Fall back to stored cwd
          return;
        }

        output += event.text;

        // Look for our marker in the output
        const markerStart = output.indexOf(marker + ':');
        const markerEnd = output.indexOf(':' + marker);

        if (markerStart !== -1 && markerEnd !== -1) {
          const cwdPath = output.slice(markerStart + marker.length + 1, markerEnd).trim();
          cleanup();

          if (cwdPath && cwdPath !== '') {
            // Update the stored cwd
            session.cwd = cwdPath;
            resolve(cwdPath);
          } else {
            resolve(session.cwd);
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        session.subscribers.delete(handler);
      };

      // Subscribe to output
      session.subscribers.add(handler);

      // Set timeout to fall back to stored cwd
      timeoutId = setTimeout(() => {
        cleanup();
        resolve(session.cwd);
      }, 1000);

      // Send command to get cwd with markers
      // Works on both Windows (cd) and Unix (pwd)
      if (process.platform === 'win32') {
        // Windows: echo marker & cd & echo marker
        session.process.write(`echo ${marker}:%cd%:${marker}\r`);
      } else {
        // Unix: echo marker:$(pwd):marker
        session.process.write(`echo "${marker}:$(pwd):${marker}"\n`);
      }
    });
  }

  listSessions(): TerminalSessionSummary[] {
    // Get active sessions
    const activeSessions = Array.from(this.#sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.buffer.length,
      isActive: true
    }));

    // Get persisted sessions that aren't currently active
    const activeIds = new Set(activeSessions.map((s) => s.id));
    const persistedSessions = Array.from(this.#persistedSessions.values())
      .filter((s) => !activeIds.has(s.id))
      .map((session) => ({
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.history.length,
        isActive: false
      }));

    // Return active sessions first, then persisted
    return [...activeSessions, ...persistedSessions];
  }

  getSession(id: string): TerminalSessionSnapshot | null {
    // Check active sessions first
    const session = this.#sessions.get(id);
    if (session) {
      return {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        history: [...session.buffer]
      };
    }

    // Fall back to persisted sessions
    const persisted = this.#persistedSessions.get(id);
    if (persisted) {
      return {
        id: persisted.id,
        title: persisted.title,
        shell: persisted.shell,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        history: [...persisted.history]
      };
    }

    return null;
  }

  #handleData(session: ManagedTerminal, chunk: string) {
    const event: TerminalStreamEvent = {
      text: chunk,
      ts: Date.now()
    };
    session.buffer.push(event);
    session.updatedAt = new Date().toISOString();
    session.subscribers.forEach((subscriber) => subscriber(event));

    // Schedule save to disk
    this.#scheduleSave(session);
  }

  #handleExit(session: ManagedTerminal, code: number | null, signal: NodeJS.Signals | null) {
    // Only notify if session still exists (not already closed manually)
    if (this.#sessions.has(session.id)) {
      // Save final state before removing
      if (session.saveTimer) {
        clearTimeout(session.saveTimer);
      }
      this.#saveSessionToDisk(session);

      session.subscribers.forEach((subscriber) => subscriber(null));
      session.subscribers.clear();
      this.#sessions.delete(session.id);
    }
  }

  createSession(options: TerminalCreateOptions = {}): TerminalSessionSnapshot {
    const id = options.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const title = options.title ?? `Terminal ${++this.#counter}`;
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const shell = options.shell ?? this.#defaultShell;
    const cwd = options.cwd ?? process.cwd();

    const ptyProcess = this.#spawnTerminal({
      shell,
      cols,
      rows,
      cwd,
      env: options.env
    });

    const session: ManagedTerminal = {
      id,
      title,
      shell,
      cwd,
      createdAt,
      updatedAt: createdAt,
      process: ptyProcess,
      buffer: [],
      subscribers: new Set()
    };

    ptyProcess.on('data', (data: string) => this.#handleData(session, data));
    ptyProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
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

  async getProjectInfo(id: string): Promise<ProjectInfo | null> {
    const session = this.#sessions.get(id);
    if (!session) {
      return null;
    }

    // Get the actual current working directory by querying the shell
    const cwd = await this.#getCurrentCwd(session);

    // Helper to check if file exists
    const exists = (filename: string): boolean => {
      try {
        return fs.existsSync(path.join(cwd, filename));
      } catch {
        return false;
      }
    };

    // Helper to read file
    const readFile = (filename: string): string | null => {
      try {
        return fs.readFileSync(path.join(cwd, filename), 'utf-8');
      } catch {
        return null;
      }
    };

    // Check for Node.js project
    if (exists('package.json')) {
      const pkgContent = readFile('package.json');
      if (pkgContent) {
        try {
          const pkg = JSON.parse(pkgContent);
          const scripts = pkg.scripts || {};
          if (scripts.dev) {
            return {
              cwd,
              projectType: 'node',
              projectName: pkg.name,
              startCommand: 'npm run dev'
            };
          }
          if (scripts.start) {
            return {
              cwd,
              projectType: 'node',
              projectName: pkg.name,
              startCommand: 'npm start'
            };
          }
          // Has package.json but no dev/start scripts
          return {
            cwd,
            projectType: 'node',
            projectName: pkg.name
          };
        } catch {
          // Invalid JSON, treat as unknown
        }
      }
    }

    // Check for Python Flask project
    if (exists('requirements.txt') && exists('app.py')) {
      return {
        cwd,
        projectType: 'python-flask',
        startCommand: 'python app.py'
      };
    }

    // Check for Django project
    if (exists('manage.py')) {
      return {
        cwd,
        projectType: 'django',
        startCommand: 'python manage.py runserver'
      };
    }

    // Check for Rust project
    if (exists('Cargo.toml')) {
      return {
        cwd,
        projectType: 'rust',
        startCommand: 'cargo run'
      };
    }

    // Check for Go project
    if (exists('go.mod')) {
      return {
        cwd,
        projectType: 'go',
        startCommand: 'go run .'
      };
    }

    // Check for static site (index.html without package.json)
    if (exists('index.html') && !exists('package.json')) {
      return {
        cwd,
        projectType: 'static',
        indexPath: path.join(cwd, 'index.html')
      };
    }

    // Unknown project type
    return {
      cwd,
      projectType: 'unknown'
    };
  }

  close(id: string): void {
    const session = this.#sessions.get(id);
    if (session) {
      // Cancel pending save
      if (session.saveTimer) {
        clearTimeout(session.saveTimer);
      }
      // Notify subscribers that session is ending before cleanup
      session.subscribers.forEach((subscriber) => subscriber(null));
      session.subscribers.clear();
      session.process.kill();
      this.#sessions.delete(id);
    }

    // Also remove from persisted sessions and delete from disk
    this.#persistedSessions.delete(id);
    deleteSession(id);
  }

  // Restore a persisted session by creating a new PTY with the same ID
  restoreSession(id: string, options: { cols?: number; rows?: number } = {}): TerminalSessionSnapshot | null {
    const persisted = this.#persistedSessions.get(id);
    if (!persisted) {
      return null;
    }

    // Check if already active
    if (this.#sessions.has(id)) {
      return this.getSession(id);
    }

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;

    // Validate cwd - fall back to process.cwd() if invalid
    let cwd = persisted.cwd;
    try {
      if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) {
        cwd = process.cwd();
      }
    } catch {
      cwd = process.cwd();
    }

    const ptyProcess = this.#spawnTerminal({
      shell: persisted.shell,
      cols,
      rows,
      cwd
    });

    const session: ManagedTerminal = {
      id: persisted.id,
      title: persisted.title,
      shell: persisted.shell,
      cwd,
      createdAt: persisted.createdAt,
      updatedAt: new Date().toISOString(),
      process: ptyProcess,
      buffer: [...persisted.history], // Restore history
      subscribers: new Set()
    };

    ptyProcess.on('data', (data: string) => this.#handleData(session, data));
    ptyProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(session, code, signal);
    });

    this.#sessions.set(id, session);

    return this.getSession(id);
  }
}
