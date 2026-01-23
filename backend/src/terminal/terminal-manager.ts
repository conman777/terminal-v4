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
  updateSessionMetadata,
  getSessionMetadata,
  deleteSessionMetadata
} from './session-store';
import {
  isTmuxAvailable,
  tmuxSessionExists,
  spawnTmuxWithPty,
  destroyTmuxSession,
  getTmuxSessionCwd,
  listTmuxSessions
} from './tmux-manager';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MAX_BUFFER_CHARS,
  SAVE_DEBOUNCE_MS,
  CWD_TIMEOUT_MS,
  type ProjectType,
  type ProjectInfo,
  type ClientDimensions,
  type ManagedTerminal,
  type PersistedSession
} from './types';

// Re-export types for external consumers
export type { ProjectType, ProjectInfo } from './types';

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

const DEFAULT_PERSIST_HISTORY_CHARS = 500000;
const DEFAULT_PERSIST_HISTORY_EVENTS = 2000;
const MAX_PERSIST_HISTORY_CHARS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_PERSIST_HISTORY_CHARS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSIST_HISTORY_CHARS;
})();
const MAX_PERSIST_HISTORY_EVENTS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_PERSIST_HISTORY_EVENTS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSIST_HISTORY_EVENTS;
})();

export interface TerminalManagerOptions {
  spawnTerminal?: TerminalSpawner;
  defaultShell?: string;
  useTmux?: boolean; // Enable tmux for persistent sessions (auto-detected if not specified)
}

/**
 * OutputBatcher - Batches multiple PTY output events into fewer WebSocket messages
 *
 * Reduces WebSocket message count by combining rapid PTY outputs into single messages.
 * Uses smart flushing:
 * - Flushes immediately when buffer reaches size threshold (4KB)
 * - Flushes after short delay (16ms) if data is waiting
 * - Can be manually flushed before user input for responsiveness
 */
class OutputBatcher {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly maxDelay: number;
  private readonly maxSize: number;
  private readonly sendCallback: (data: string) => void;

  constructor(sendCallback: (data: string) => void, maxDelay = 16, maxSize = 4096) {
    this.sendCallback = sendCallback;
    this.maxDelay = maxDelay;
    this.maxSize = maxSize;
  }

  append(data: string): void {
    this.buffer.push(data);
    const size = this.buffer.reduce((acc, s) => acc + s.length, 0);

    if (size >= this.maxSize) {
      // Buffer full - flush immediately
      this.flush();
    } else if (!this.timer) {
      // Start timer for delayed flush
      this.timer = setTimeout(() => this.flush(), this.maxDelay);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      const combined = this.buffer.join('');
      this.buffer = [];
      this.sendCallback(combined);
    }
  }

  destroy(): void {
    this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
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
  #persistedSessions = new Map<string, Map<string, PersistedSession>>(); // userId -> sessionId -> session
  #recoveredUsers = new Set<string>(); // Track which users have had recovery run
  #spawnTerminal: TerminalSpawner;
  #defaultShell: string;
  #counter = 0;
  #useTmux: boolean;

  constructor(options: TerminalManagerOptions = {}) {
    this.#spawnTerminal = options.spawnTerminal ?? ptySpawner;
    this.#defaultShell = options.defaultShell ?? detectShell();

    // Auto-detect tmux availability if not explicitly specified
    if (options.useTmux !== undefined) {
      this.#useTmux = options.useTmux && isTmuxAvailable();
    } else {
      this.#useTmux = isTmuxAvailable();
    }
  }

  async initialize(): Promise<void> {
    if (this.#useTmux) {
      console.log('TerminalManager initialized with tmux persistence enabled');
      // List any existing tmux sessions from previous runs
      const existingSessions = listTmuxSessions();
      if (existingSessions.length > 0) {
        console.log(`Found ${existingSessions.length} existing tmux sessions from previous runs`);
      }
    } else {
      console.log('TerminalManager initialized (tmux not available - sessions will not persist across restarts)');
    }
  }

  /**
   * Check if tmux persistence is enabled
   */
  isTmuxEnabled(): boolean {
    return this.#useTmux;
  }

  async loadUserSessions(userId: string): Promise<void> {
    // Always reload from disk to detect external changes (deletions, other tabs, etc.)
    const persisted = await loadAllSessions(userId);
    const userSessions = new Map<string, PersistedSession>();
    for (const session of persisted) {
      userSessions.set(session.id, session);
    }
    this.#persistedSessions.set(userId, userSessions);
    console.log(`Loaded ${persisted.length} persisted terminal sessions for user ${userId}`);

    // Auto-restore sessions that have surviving tmux processes
    // Only run recovery once per user to prevent duplicate recovered sessions
    if (this.#useTmux && !this.#recoveredUsers.has(userId)) {
      this.#recoveredUsers.add(userId);

      // First, recover any orphaned tmux sessions (tmux exists but no valid persisted data)
      const tmuxSessions = listTmuxSessions();
      for (const tmuxId of tmuxSessions) {
        if (!userSessions.has(tmuxId)) {
          // Tmux exists but no valid persisted data - create minimal entry
          const cwd = getTmuxSessionCwd(tmuxId) || process.cwd();

          // Try to get title from metadata index (survives session file corruption)
          const metadata = await getSessionMetadata(userId, tmuxId);
          let title: string;
          if (metadata?.title) {
            title = metadata.title;
            console.log(`[TerminalManager] Recovering orphaned tmux session with saved title: ${tmuxId} -> ${title}`);
          } else {
            // Fall back to directory name
            const dirName = path.basename(cwd);
            title = dirName && dirName !== '/' ? `${dirName} (recovered)` : 'Recovered Terminal';
            console.log(`[TerminalManager] Recovering orphaned tmux session: ${tmuxId} -> ${title}`);
          }

          const recovered: PersistedSession = {
            id: tmuxId,
            title,
            shell: metadata?.shell || this.#defaultShell,
            cwd: metadata?.cwd || cwd,
            createdAt: metadata?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            history: []
          };
          userSessions.set(tmuxId, recovered);
          // Save the recovered session to disk
          try {
            await saveSession(userId, recovered);
          } catch (error) {
            console.error(`Failed to save recovered session ${tmuxId}:`, error);
          }
        }
      }

      // Now restore all sessions that have surviving tmux processes
      for (const session of userSessions.values()) {
        // Skip if already active
        if (this.#sessions.has(session.id)) {
          continue;
        }
        // Check if tmux session exists (survived server restart)
        try {
          if (tmuxSessionExists(session.id)) {
            console.log(`Auto-restoring session ${session.id} with surviving tmux process`);
            this.restoreSession(userId, session.id);
          }
        } catch (error) {
          console.error(`Failed to auto-restore session ${session.id}:`, error);
        }
      }
    }
  }

  // Schedule a debounced save for this session
  #scheduleSave(session: ManagedTerminal): void {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
    }
    // Save after period of inactivity
    session.saveTimer = setTimeout(() => {
      void this.#saveSessionToDisk(session).catch((error) => {
        console.error(`Failed to persist terminal session ${session.id}:`, error);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async #saveSessionToDisk(session: ManagedTerminal): Promise<void> {
    // If a save is already in progress, mark that another save is needed
    if (session.saveInProgress) {
      session.pendingSave = true;
      return;
    }

    session.saveInProgress = true;
    session.pendingSave = false;

    try {
      const history = session.usesTmux
        ? []
        : this.#limitHistory(session.buffer, {
            maxHistoryChars: MAX_PERSIST_HISTORY_CHARS,
            maxHistoryEvents: MAX_PERSIST_HISTORY_EVENTS
          });
      const persisted: PersistedSession = {
        id: session.id,
        title: session.title,
        shell: session.shell,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        history
      };
      await saveSession(session.userId, persisted);

      let userSessions = this.#persistedSessions.get(session.userId);
      if (!userSessions) {
        userSessions = new Map();
        this.#persistedSessions.set(session.userId, userSessions);
      }
      userSessions.set(session.id, persisted);
    } finally {
      session.saveInProgress = false;

      // If another save was requested while we were saving, do it now
      if (session.pendingSave) {
        session.pendingSave = false;
        // Use setImmediate to avoid stack overflow on rapid saves
        setImmediate(() => {
          void this.#saveSessionToDisk(session).catch((error) => {
            console.error(`Failed to persist terminal session ${session.id}:`, error);
          });
        });
      }
    }
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
      }, CWD_TIMEOUT_MS);

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

  listSessions(userId: string): TerminalSessionSummary[] {
    // Get active sessions for this user
    const activeSessions = Array.from(this.#sessions.values())
      .filter((session) => session.userId === userId)
      .map((session) => ({
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.buffer.length,
        isActive: true,
        usesTmux: session.usesTmux
      }));

    // Get persisted sessions for this user that aren't currently active
    const activeIds = new Set(activeSessions.map((s) => s.id));
    const userPersistedSessions = this.#persistedSessions.get(userId) || new Map();
    const persistedSessions = Array.from(userPersistedSessions.values())
      .filter((s) => !activeIds.has(s.id))
      .map((session) => ({
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.history.length,
        isActive: false,
        usesTmux: false
      }));

    // Return active sessions first, then persisted
    return [...activeSessions, ...persistedSessions];
  }

  async renameSession(userId: string, id: string, title: string): Promise<TerminalSessionSummary | null> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error('Terminal title cannot be empty');
    }

    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      session.title = trimmed;
      session.updatedAt = new Date().toISOString();
      this.#scheduleSave(session);

      // Update metadata index with new title
      updateSessionMetadata(userId, id, {
        title: trimmed,
        shell: session.shell,
        cwd: session.cwd,
        createdAt: session.createdAt
      }).catch((error) => {
        console.error(`Failed to update session metadata for ${id}:`, error);
      });

      return {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.buffer.length,
        isActive: true,
        usesTmux: session.usesTmux
      };
    }

    const userPersistedSessions = this.#persistedSessions.get(userId);
    const persisted = userPersistedSessions?.get(id);
    if (!persisted || !userPersistedSessions) {
      return null;
    }

    const updated: PersistedSession = {
      ...persisted,
      title: trimmed,
      updatedAt: new Date().toISOString()
    };

    await saveSession(userId, updated);
    userPersistedSessions.set(id, updated);

    // Update metadata index with new title
    await updateSessionMetadata(userId, id, {
      title: trimmed,
      shell: updated.shell,
      cwd: updated.cwd,
      createdAt: updated.createdAt
    });

    return {
      id: updated.id,
      title: updated.title,
      shell: updated.shell,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      messageCount: updated.history.length,
      isActive: false,
      usesTmux: false
    };
  }

  isActive(id: string): boolean {
    return this.#sessions.has(id);
  }

  getSession(
    userId: string,
    id: string,
    options: { maxHistoryChars?: number; maxHistoryEvents?: number } = {}
  ): TerminalSessionSnapshot | null {
    // Check active sessions first
    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      const history = this.#limitHistory(session.buffer, options);
      return {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        history,
        usesTmux: session.usesTmux
      };
    }

    // Fall back to persisted sessions
    const userPersistedSessions = this.#persistedSessions.get(userId);
    const persisted = userPersistedSessions?.get(id);
    if (persisted) {
      const history = this.#limitHistory(persisted.history, options);
      return {
        id: persisted.id,
        title: persisted.title,
        shell: persisted.shell,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        history,
        usesTmux: false
      };
    }

    return null;
  }

  #limitHistory(
    history: TerminalStreamEvent[],
    options: { maxHistoryChars?: number; maxHistoryEvents?: number }
  ): TerminalStreamEvent[] {
    const { maxHistoryChars, maxHistoryEvents } = options;
    if (!maxHistoryChars && !maxHistoryEvents) {
      return [...history];
    }

    let startIndex = 0;
    if (maxHistoryEvents && history.length > maxHistoryEvents) {
      startIndex = history.length - maxHistoryEvents;
    }

    if (maxHistoryChars) {
      let charCount = 0;
      for (let i = history.length - 1; i >= startIndex; i -= 1) {
        charCount += history[i]?.text?.length ?? 0;
        if (charCount > maxHistoryChars) {
          startIndex = i;
          break;
        }
      }
    }

    return history.slice(startIndex);
  }

  #handleData(session: ManagedTerminal, chunk: string) {
    const event: TerminalStreamEvent = {
      text: chunk,
      ts: Date.now()
    };
    session.buffer.push(event);
    session.bufferCharCount += event.text.length;
    while (session.bufferCharCount > MAX_BUFFER_CHARS && session.buffer.length > 1) {
      const removed = session.buffer.shift();
      if (removed) session.bufferCharCount -= removed.text.length;
    }
    session.updatedAt = new Date().toISOString();
    session.subscribers.forEach((subscriber) => subscriber(event));

    // Try to detect CWD from Windows prompt (e.g., "C:\path\to\folder>")
    // or Unix prompt with path (though less reliable)
    if (process.platform === 'win32') {
      // Windows cmd.exe prompt: "C:\Users\name\folder>"
      const winPromptMatch = chunk.match(/^([A-Za-z]:\\[^>]*?)>/m);
      if (winPromptMatch && winPromptMatch[1]) {
        const detectedPath = winPromptMatch[1].trim();
        if (detectedPath && fs.existsSync(detectedPath)) {
          session.cwd = detectedPath;
        }
      }
    }

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
      // Destroy output batcher
      session.outputBatcher?.destroy();

      void this.#saveSessionToDisk(session).catch((error) => {
        console.error(`Failed to persist terminal session ${session.id}:`, error);
      });

      session.subscribers.forEach((subscriber) => subscriber(null));
      session.subscribers.clear();
      this.#sessions.delete(session.id);
    }
  }

  createSession(userId: string, options: TerminalCreateOptions = {}): TerminalSessionSnapshot {
    const id = options.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const title = options.title ?? `Terminal ${++this.#counter}`;
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const shell = options.shell ?? this.#defaultShell;
    // Default to user's home directory instead of server's process.cwd()
    const defaultCwd = process.env.HOME || process.cwd();
    let cwd = options.cwd ?? defaultCwd;
    try {
      cwd = path.resolve(cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        cwd = defaultCwd;
      }
    } catch {
      cwd = defaultCwd;
    }

    // Use tmux if available for persistent sessions
    const usesTmux = this.#useTmux;
    let ptyProcess: TerminalProcess;

    if (usesTmux) {
      console.log(`[TerminalManager] Creating tmux-backed session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell,
        cols,
        rows,
        cwd,
        env: options.env
      });
    } else {
      ptyProcess = this.#spawnTerminal({
        shell,
        cols,
        rows,
        cwd,
        env: options.env
      });
    }

    const dataHandler = (data: string) => this.#handleData(session, data);
    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(session, code, signal);
    };

    const session: ManagedTerminal = {
      id,
      userId,
      title,
      shell,
      cwd,
      createdAt,
      updatedAt: createdAt,
      process: ptyProcess,
      buffer: [],
      bufferCharCount: 0,
      subscribers: new Set(),
      dataHandler,
      exitHandler,
      clientDimensions: new Map(),
      currentCols: cols,
      currentRows: rows,
      usesTmux,
      outputBatcher: undefined // Will be initialized below
    };

    // Create output batcher for this session
    session.outputBatcher = new OutputBatcher((batchedData: string) => {
      this.#handleData(session, batchedData);
    });

    // PTY data handler appends to batcher instead of calling #handleData directly
    const batchedDataHandler = (data: string) => {
      session.outputBatcher?.append(data);
    };
    session.dataHandler = batchedDataHandler;

    ptyProcess.on('data', batchedDataHandler);
    ptyProcess.on('exit', exitHandler);

    this.#sessions.set(id, session);

    // Save metadata index entry (survives session file corruption)
    updateSessionMetadata(userId, id, { title, shell, cwd, createdAt }).catch((error) => {
      console.error(`Failed to save session metadata for ${id}:`, error);
    });
    // Persist an initial session file so tmux sessions don't get "recovered" after restarts
    void this.#saveSessionToDisk(session).catch((error) => {
      console.error(`Failed to persist initial terminal session ${id}:`, error);
    });

    // Execute initial command if provided
    if (options.initialCommand) {
      const cmd = options.initialCommand;
      // Small delay to ensure terminal is ready
      setTimeout(() => {
        const newline = process.platform === 'win32' ? '\r' : '\n';
        session.process.write(cmd + newline);
      }, 100);
    }

    return this.getSession(userId, id)!;
  }

  subscribe(userId: string, id: string, handler: (event: TerminalStreamEvent | null) => void): () => void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new Error(`Terminal session ${id} not found`);
    }

    session.subscribers.add(handler);
    return () => {
      session.subscribers.delete(handler);
    };
  }

  write(userId: string, id: string, input: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new Error(`Terminal session ${id} not found`);
    }

    // Flush output buffer before processing input for better responsiveness
    session.outputBatcher?.flush();

    this.#maybeUpdateCwdFromInput(session, input);
    session.process.write(normaliseNewlines(input));
  }

  resize(userId: string, id: string, cols: number, rows: number, clientId?: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new Error(`Terminal session ${id} not found`);
    }

    // Track this client's dimensions
    if (clientId) {
      session.clientDimensions.set(clientId, { cols, rows });
    }

    // Use the LARGEST dimensions among all connected clients
    // This prevents mobile clients from shrinking the terminal when desktop is also connected
    // Desktop users get proper wide terminals; mobile users see wrapped text (acceptable tradeoff)
    const maxDims = this.#getMaxClientDimensions(session, cols, rows);

    if (maxDims.cols !== session.currentCols || maxDims.rows !== session.currentRows) {
      session.currentCols = maxDims.cols;
      session.currentRows = maxDims.rows;
      session.process.resize(maxDims.cols, maxDims.rows);
    }
  }

  // Calculate the maximum dimensions across all connected clients
  // Falls back to provided defaults if no clients are tracked
  #getMaxClientDimensions(
    session: { clientDimensions: Map<string, { cols: number; rows: number }> },
    defaultCols: number,
    defaultRows: number
  ): { cols: number; rows: number } {
    let maxCols = defaultCols;
    let maxRows = defaultRows;

    for (const dims of session.clientDimensions.values()) {
      if (dims.cols > maxCols) maxCols = dims.cols;
      if (dims.rows > maxRows) maxRows = dims.rows;
    }

    return { cols: maxCols, rows: maxRows };
  }

  // Remove a client's dimensions (called when WebSocket disconnects)
  removeClient(userId: string, id: string, clientId: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      return;
    }

    session.clientDimensions.delete(clientId);

    // If there are remaining clients, use the LARGEST dimensions among them
    // Otherwise keep current dimensions (will be updated when next client resizes)
    if (session.clientDimensions.size > 0) {
      const maxDims = this.#getMaxClientDimensions(session, session.currentCols, session.currentRows);
      if (maxDims.cols !== session.currentCols || maxDims.rows !== session.currentRows) {
        session.currentCols = maxDims.cols;
        session.currentRows = maxDims.rows;
        session.process.resize(maxDims.cols, maxDims.rows);
      }
    }
  }

  async getProjectInfo(userId: string, id: string): Promise<ProjectInfo | null> {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      return null;
    }

    // Use the stored cwd - it's set at session creation and updated by updateCwd
    const cwd = session.cwd;

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

  close(userId: string, id: string): void {
    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      // Cancel pending save
      if (session.saveTimer) {
        clearTimeout(session.saveTimer);
      }
      // Destroy output batcher
      session.outputBatcher?.destroy();
      // Notify subscribers that session is ending before cleanup
      session.subscribers.forEach((subscriber) => subscriber(null));
      session.subscribers.clear();
      // Remove event listeners to prevent memory leaks
      if (session.dataHandler) {
        session.process.off('data', session.dataHandler);
      }
      if (session.exitHandler) {
        session.process.off('exit', session.exitHandler);
      }
      session.process.kill();

      // If using tmux, destroy the tmux session so it doesn't persist
      if (session.usesTmux) {
        console.log(`[TerminalManager] Destroying tmux session ${id}`);
        destroyTmuxSession(id);
      }

      this.#sessions.delete(id);
    } else if (this.#useTmux) {
      // Session might not be active but tmux session could still exist
      // (e.g., user is deleting a persisted session without restoring it first)
      const userPersistedSessions = this.#persistedSessions.get(userId);
      if (userPersistedSessions?.has(id) && tmuxSessionExists(id)) {
        console.log(`[TerminalManager] Destroying orphaned tmux session ${id}`);
        destroyTmuxSession(id);
      }
    }

    // Also remove from persisted sessions and delete from disk
    const userPersistedSessions = this.#persistedSessions.get(userId);
    if (userPersistedSessions) {
      userPersistedSessions.delete(id);
    }
    // Fire-and-forget with error handling to prevent unhandled rejection
    deleteSession(userId, id).catch((error) => {
      console.error(`Failed to delete session file for ${id}:`, error);
    });
    // Also delete metadata index entry
    deleteSessionMetadata(userId, id).catch((error) => {
      console.error(`Failed to delete session metadata for ${id}:`, error);
    });
  }

  // Kill all active sessions
  // When persist=true (default), tmux sessions are kept alive so they can be reattached after restart
  // When persist=false, tmux sessions are destroyed
  async closeAll(options: { persist?: boolean } = {}): Promise<void> {
    const persist = options.persist ?? true;
    console.log(`Closing all ${this.#sessions.size} active terminal sessions (persist=${persist})`);
    const sessions = Array.from(this.#sessions.values());

    if (persist) {
      await Promise.all(
        sessions.map(async (session) => {
          try {
            if (session.saveTimer) {
              clearTimeout(session.saveTimer);
            }
            session.updatedAt = new Date().toISOString();
            await this.#saveSessionToDisk(session);
          } catch (error) {
            console.error(`Failed to persist terminal session ${session.id}:`, error);
          }
        })
      );
    }

    for (const session of sessions) {
      try {
        // Destroy output batcher
        session.outputBatcher?.destroy();
        session.subscribers.forEach((subscriber) => subscriber(null));
        session.subscribers.clear();
        // Remove event listeners to prevent memory leaks
        if (session.dataHandler) {
          session.process.off('data', session.dataHandler);
        }
        if (session.exitHandler) {
          session.process.off('exit', session.exitHandler);
        }
        session.process.kill();

        // If not persisting, also destroy tmux sessions
        if (!persist && session.usesTmux) {
          console.log(`[TerminalManager] Destroying tmux session ${session.id}`);
          destroyTmuxSession(session.id);
        } else if (session.usesTmux) {
          console.log(`[TerminalManager] Detaching from tmux session ${session.id} (session will persist)`);
        }
      } catch (err) {
        console.error(`Error killing session ${session.id}:`, err);
      }
    }
    this.#sessions.clear();
  }

  // Restore a persisted session by creating a new PTY with the same ID
  restoreSession(userId: string, id: string, options: { cols?: number; rows?: number } = {}): TerminalSessionSnapshot | null {
    const userPersistedSessions = this.#persistedSessions.get(userId);
    const persisted = userPersistedSessions?.get(id);
    if (!persisted) {
      return null;
    }

    // Check if already active
    if (this.#sessions.has(id)) {
      return this.getSession(userId, id);
    }

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;

    // Check if tmux session exists (process survived server restart)
    const hasTmuxSession = this.#useTmux && tmuxSessionExists(id);

    // Validate cwd - fall back to user's home directory if invalid
    // If tmux session exists, try to get current working dir from it
    const defaultCwd = process.env.HOME || process.cwd();
    let cwd = persisted.cwd;
    if (hasTmuxSession) {
      const tmuxCwd = getTmuxSessionCwd(id);
      if (tmuxCwd) {
        cwd = tmuxCwd;
      }
    }
    try {
      if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) {
        cwd = defaultCwd;
      }
    } catch {
      cwd = defaultCwd;
    }

    // Spawn the process - if tmux session exists, reattach to it
    const usesTmux = this.#useTmux;
    let ptyProcess: TerminalProcess;

    if (hasTmuxSession) {
      // Reattach to existing tmux session - running processes are preserved!
      console.log(`[TerminalManager] Reattaching to existing tmux session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell: persisted.shell,
        cols,
        rows,
        cwd
      });
    } else if (usesTmux) {
      // Create new tmux session
      console.log(`[TerminalManager] Creating new tmux session for restored session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell: persisted.shell,
        cols,
        rows,
        cwd
      });
    } else {
      // Non-tmux fallback
      ptyProcess = this.#spawnTerminal({
        shell: persisted.shell,
        cols,
        rows,
        cwd
      });
    }

    const dataHandler = (data: string) => this.#handleData(session, data);
    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(session, code, signal);
    };

    const session: ManagedTerminal = {
      id: persisted.id,
      userId,
      title: persisted.title,
      shell: persisted.shell,
      cwd,
      createdAt: persisted.createdAt,
      updatedAt: new Date().toISOString(),
      process: ptyProcess,
      // If reattaching to tmux, don't restore old history - we'll get fresh output
      // If creating new session, restore history so user sees previous output
      buffer: hasTmuxSession ? [] : [...persisted.history],
      bufferCharCount: hasTmuxSession ? 0 : persisted.history.reduce((sum, entry) => sum + entry.text.length, 0),
      subscribers: new Set(),
      dataHandler,
      exitHandler,
      clientDimensions: new Map(),
      currentCols: cols,
      currentRows: rows,
      usesTmux,
      outputBatcher: undefined // Will be initialized below
    };

    // Create output batcher for this session
    session.outputBatcher = new OutputBatcher((batchedData: string) => {
      this.#handleData(session, batchedData);
    });

    // PTY data handler appends to batcher instead of calling #handleData directly
    const batchedDataHandler = (data: string) => {
      session.outputBatcher?.append(data);
    };
    session.dataHandler = batchedDataHandler;

    ptyProcess.on('data', batchedDataHandler);
    ptyProcess.on('exit', exitHandler);

    this.#sessions.set(id, session);

    return this.getSession(userId, id);
  }

  #maybeUpdateCwdFromInput(session: ManagedTerminal, input: string): void {
    if (!input) return;
    if (!input.includes('\n') && !input.includes('\r')) return;

    const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const previousCwd = session.cwd;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Handle bare 'cd' command (goes to home directory)
      if (trimmed === 'cd') {
        const home = process.env.HOME;
        if (home && fs.existsSync(home)) {
          session.cwd = home;
        }
        continue;
      }

      const match = trimmed.match(/^cd(?:\s+\/d)?\s+(?<path>.+)$/i);
      if (!match?.groups?.path) continue;

      let target = match.groups.path.trim();
      if (
        (target.startsWith('"') && target.endsWith('"')) ||
        (target.startsWith("'") && target.endsWith("'"))
      ) {
        target = target.slice(1, -1);
      }

      if (!target) continue;

      // Expand "~" on Unix-like systems.
      if (target === '~' || target.startsWith('~/')) {
        const home = process.env.HOME;
        if (home) {
          target = path.join(home, target.slice(1));
        }
      }

      const resolvedTarget = path.resolve(session.cwd || process.cwd(), target);
      try {
        if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()) {
          session.cwd = resolvedTarget;
        }
      } catch {
        // Ignore invalid paths.
      }
    }

    // Notify subscribers if cwd changed
    if (session.cwd !== previousCwd) {
      const cwdMessage = JSON.stringify({ type: 'cwd', cwd: session.cwd });
      session.subscribers.forEach((subscriber) => {
        subscriber({ text: cwdMessage, ts: Date.now() });
      });
    }
  }
}
