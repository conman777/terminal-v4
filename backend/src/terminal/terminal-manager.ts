import { randomUUID } from 'node:crypto';
import { TurnDetector, type ChatTurn } from './turn-detector';
import type { TerminalCliEvent } from './cli-events';
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
  updateThreadMetadata,
  getSessionMetadata,
  listSessionMetadata,
  deleteSessionMetadata,
  type SessionMetadataIndex,
  type ThreadMetadata
} from './session-store';
import { resolveSessionPaths } from './session-resolver';
import {
  isTmuxAvailable,
  tmuxSessionExists,
  spawnTmuxWithPty,
  destroyTmuxSession,
  getTmuxSessionCwd,
  listTmuxSessions
} from './tmux-manager';
import { buildInteractiveTerminalEnv } from './terminal-env';
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
import { outputIndicatesIdlePrompt } from './busy-state';
import { isTerminalControlResponseInput } from './control-input';
import { WorkspaceCopySandboxRuntime } from '../sandbox/workspace-copy-sandbox-runtime';
import type {
  SandboxMode,
  SandboxRuntime,
  TerminalSandboxInfo,
  TerminalSandboxPolicy
} from '../sandbox/sandbox-types';

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

function normalizeWorkspaceRoot(cwd: string, workspaceRoot?: string): string | null {
  const candidate = workspaceRoot || cwd;
  try {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

function createSandboxPolicy(
  cwd: string,
  mode: SandboxMode = 'off',
  workspaceRoot?: string,
  previous?: Partial<TerminalSandboxInfo>
): TerminalSandboxPolicy {
  if (mode === 'off') {
    return {
      mode,
      workspaceRoot: previous?.workspaceRoot ?? null
    };
  }

  return {
    mode,
    workspaceRoot: normalizeWorkspaceRoot(cwd, workspaceRoot) ?? previous?.workspaceRoot ?? cwd
  };
}

const DEFAULT_PERSIST_HISTORY_CHARS = 2_000_000;
const DEFAULT_PERSIST_HISTORY_EVENTS = 10_000;
const MAX_PERSIST_HISTORY_CHARS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_PERSIST_HISTORY_CHARS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSIST_HISTORY_CHARS;
})();
const MAX_PERSIST_HISTORY_EVENTS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_PERSIST_HISTORY_EVENTS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERSIST_HISTORY_EVENTS;
})();
const DEFAULT_IDLE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_IDLE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();
const DEFAULT_MAX_ACTIVE_SESSIONS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_MAX_ACTIVE_SESSIONS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
})();
const DEFAULT_TMUX_RECOVERY_CHECK_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.TMUX_RECOVERY_CHECK_INTERVAL_MS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1000;
})();
const DEFAULT_BUSY_WINDOW_MS = (() => {
  const parsed = Number.parseInt(process.env.TERMINAL_BUSY_WINDOW_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();

export interface TerminalManagerOptions {
  spawnTerminal?: TerminalSpawner;
  defaultShell?: string;
  useTmux?: boolean; // Enable tmux for persistent sessions (auto-detected if not specified)
  idleTimeoutMs?: number; // 0 disables idle timeout
  maxActiveSessions?: number; // 0 disables limit
  sandboxRuntime?: SandboxRuntime;
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
  private bufferSize = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly baseMaxDelay: number;
  private readonly baseMaxSize: number;
  private adaptiveDelay: number;
  private adaptiveSize: number;
  private burstModeUntil = 0;
  private readonly sendCallback: (data: string) => void;

  constructor(sendCallback: (data: string) => void, maxDelay = 16, maxSize = 4096) {
    this.sendCallback = sendCallback;
    this.baseMaxDelay = maxDelay;
    this.baseMaxSize = maxSize;
    this.adaptiveDelay = Math.min(maxDelay, 8);
    this.adaptiveSize = Math.min(maxSize, 4096);
  }

  append(data: string): void {
    this.buffer.push(data);
    this.bufferSize += data.length;

    if (this.bufferSize >= this.adaptiveSize) {
      // Buffer full - flush immediately
      this.flush();
    } else if (!this.timer) {
      // Start timer for delayed flush
      this.timer = setTimeout(() => this.flush(), this.adaptiveDelay);
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
      this.bufferSize = 0;
      this.#updateProfile(combined.length);
      this.sendCallback(combined);
    }
  }

  #updateProfile(flushSize: number): void {
    const now = Date.now();

    if (flushSize >= 32_768) {
      this.burstModeUntil = now + 1000;
      this.adaptiveDelay = Math.max(this.baseMaxDelay, 24);
      this.adaptiveSize = Math.max(this.baseMaxSize, 16_384);
      return;
    }

    if (flushSize >= 8_192 || now < this.burstModeUntil) {
      this.adaptiveDelay = Math.max(this.baseMaxDelay, 16);
      this.adaptiveSize = Math.max(this.baseMaxSize, 8_192);
      return;
    }

    this.adaptiveDelay = Math.min(this.baseMaxDelay, 8);
    this.adaptiveSize = Math.min(this.baseMaxSize, 4096);
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
    env: buildInteractiveTerminalEnv(process.env, options.env) as Record<string, string>
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
  #metadataIndexByUser = new Map<string, SessionMetadataIndex>();
  #recoveredUsers = new Set<string>(); // Track which users have had recovery run
  #lastTmuxRecoveryCheckByUser = new Map<string, number>();
  #spawnTerminal: TerminalSpawner;
  #defaultShell: string;
  #counter = 0;
  #useTmux: boolean;
  #idleTimeoutMs: number;
  #maxActiveSessions: number;
  #sandboxRuntime: SandboxRuntime;

  constructor(options: TerminalManagerOptions = {}) {
    this.#spawnTerminal = options.spawnTerminal ?? ptySpawner;
    this.#defaultShell = options.defaultShell ?? detectShell();

    // Auto-detect tmux availability if not explicitly specified
    if (options.useTmux !== undefined) {
      this.#useTmux = options.useTmux && isTmuxAvailable();
    } else {
      this.#useTmux = isTmuxAvailable();
    }
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#maxActiveSessions = options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.#sandboxRuntime = options.sandboxRuntime ?? new WorkspaceCopySandboxRuntime();
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
    const [persisted, metadataIndex] = await Promise.all([
      loadAllSessions(userId),
      listSessionMetadata(userId)
    ]);
    const userSessions = new Map<string, PersistedSession>();
    for (const session of persisted) {
      userSessions.set(session.id, session);
    }
    this.#persistedSessions.set(userId, userSessions);
    this.#metadataIndexByUser.set(userId, metadataIndex);
    console.log(`Loaded ${persisted.length} persisted terminal sessions for user ${userId}`);

    if (!this.#useTmux) {
      return;
    }

    // Recover orphaned tmux sessions once per user to prevent duplicate entries.
    if (!this.#recoveredUsers.has(userId)) {
      this.#recoveredUsers.add(userId);
      // First, recover any orphaned tmux sessions (tmux exists but no valid persisted data)
      const metadataIds = new Set(Object.keys(metadataIndex));
      const tmuxSessions = listTmuxSessions();
      for (const tmuxId of tmuxSessions) {
        if (!userSessions.has(tmuxId)) {
          if (!metadataIds.has(tmuxId)) {
            continue;
          }

          // Tmux exists but no valid persisted data - create minimal entry from metadata
          const metadata = metadataIndex[tmuxId] || (await getSessionMetadata(userId, tmuxId));
          if (!metadata) {
            continue;
          }
          const tmuxCwd = getTmuxSessionCwd(tmuxId) || metadata.cwd || process.cwd();
          const title = metadata.title || path.basename(tmuxCwd) || 'Recovered Terminal';
          console.log(`[TerminalManager] Recovering orphaned tmux session from metadata: ${tmuxId} -> ${title}`);

          const recovered: PersistedSession = {
            id: tmuxId,
            title,
            shell: metadata.shell || this.#defaultShell,
            cwd: metadata.cwd || tmuxCwd,
            createdAt: metadata.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sandbox: metadata.sandbox,
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
    }

    const lastCheck = this.#lastTmuxRecoveryCheckByUser.get(userId) || 0;
    const now = Date.now();
    if (now - lastCheck < DEFAULT_TMUX_RECOVERY_CHECK_INTERVAL_MS) {
      return;
    }
    this.#lastTmuxRecoveryCheckByUser.set(userId, now);

    // Reattach to any surviving tmux sessions not currently active in-memory.
    for (const session of userSessions.values()) {
      if (this.#sessions.has(session.id)) {
        continue;
      }
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

  #resetIdleTimer(session: ManagedTerminal): void {
    if (this.#idleTimeoutMs <= 0) return;
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      this.#expireIdleSession(session);
    }, this.#idleTimeoutMs);
  }

  #recordSessionActivity(session: ManagedTerminal): void {
    const now = Date.now();
    session.lastActivityAt = now;
    session.busyUntilAt = now + DEFAULT_BUSY_WINDOW_MS;
    this.#resetIdleTimer(session);
  }

  #isSessionBusy(session: ManagedTerminal, now = Date.now()): boolean {
    return session.busyUntilAt > now;
  }

  #markSessionIdle(session: ManagedTerminal): void {
    session.busyUntilAt = 0;
  }

  #expireIdleSession(session: ManagedTerminal): void {
    if (!this.#sessions.has(session.id)) {
      return;
    }

    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = undefined;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }

    session.updatedAt = new Date().toISOString();
    void this.#saveSessionToDisk(session).catch((error) => {
      console.error(`Failed to persist idle terminal session ${session.id}:`, error);
    });

    session.subscribers.forEach((subscriber) => subscriber(null));
    session.subscribers.clear();

    if (session.dataHandler) {
      session.process.off('data', session.dataHandler);
    }
    if (session.exitHandler) {
      session.process.off('exit', session.exitHandler);
    }

    session.outputBatcher?.destroy();

    try {
      session.process.kill();
    } catch (error) {
      console.error(`Failed to terminate idle terminal session ${session.id}:`, error);
    }

    this.#sessions.delete(session.id);
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
        history,
        sandbox: session.sandbox,
        thread: session.thread
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
    const metadataIndex = this.#metadataIndexByUser.get(userId) || {};
    const defaultCwd = process.env.HOME || process.cwd();
    const homeDir = process.env.HOME || null;
    const now = Date.now();

    // Get active sessions for this user
    const activeSessions = Array.from(this.#sessions.values())
      .filter((session) => session.userId === userId)
      .map((session) => {
        const resolved = resolveSessionPaths({
          cwd: session.cwd,
          metadataCwd: metadataIndex[session.id]?.cwd || null,
          defaultCwd,
          homeDir,
          threadProjectPath: session.thread?.projectPath
        });
        return {
          id: session.id,
          title: session.title,
          shell: session.shell,
          cwd: resolved.cwd || session.cwd,
          cwdSource: resolved.cwdSource,
          groupPath: resolved.groupPath,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          lastActivityAt: new Date(session.lastActivityAt).toISOString(),
          messageCount: session.buffer.length,
          isActive: true,
          isBusy: this.#isSessionBusy(session, now),
          usesTmux: session.usesTmux,
          sandbox: session.sandbox,
          thread: session.thread
        };
      });

    // Get persisted sessions for this user that aren't currently active
    const activeIds = new Set(activeSessions.map((s) => s.id));
    const userPersistedSessions = this.#persistedSessions.get(userId) || new Map();
    const persistedSessions = Array.from(userPersistedSessions.values())
      .filter((s) => !activeIds.has(s.id))
      .map((session) => {
        const resolved = resolveSessionPaths({
          cwd: session.cwd,
          metadataCwd: metadataIndex[session.id]?.cwd || null,
          defaultCwd,
          homeDir,
          threadProjectPath: session.thread?.projectPath
        });
        return {
          id: session.id,
          title: session.title,
          shell: session.shell,
          cwd: resolved.cwd || session.cwd,
          cwdSource: resolved.cwdSource,
          groupPath: resolved.groupPath,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          lastActivityAt: session.updatedAt,
          messageCount: session.history.length,
          isActive: false,
          isBusy: false,
          usesTmux: false,
          sandbox: session.sandbox,
          thread: session.thread
        };
      });

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
        createdAt: session.createdAt,
        sandbox: session.sandbox
      }).catch((error) => {
        console.error(`Failed to update session metadata for ${id}:`, error);
      });

      return {
        id: session.id,
        title: session.title,
        shell: session.shell,
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastActivityAt: new Date(session.lastActivityAt).toISOString(),
        messageCount: session.buffer.length,
        isActive: true,
        isBusy: this.#isSessionBusy(session),
        usesTmux: session.usesTmux,
        sandbox: session.sandbox,
        thread: session.thread
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
      createdAt: updated.createdAt,
      sandbox: updated.sandbox
    });

    return {
      id: updated.id,
      title: updated.title,
      shell: updated.shell,
      cwd: updated.cwd,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      lastActivityAt: updated.updatedAt,
      messageCount: updated.history.length,
      isActive: false,
      isBusy: false,
      usesTmux: false,
      sandbox: updated.sandbox,
      thread: updated.thread
    };
  }

  isActive(id: string): boolean {
    return this.#sessions.has(id);
  }

  syncThreadMetadata(userId: string, id: string, thread: ThreadMetadata): void {
    const active = this.#sessions.get(id);
    if (active && active.userId === userId) {
      active.thread = { ...thread };
    }

    const userPersistedSessions = this.#persistedSessions.get(userId);
    const persisted = userPersistedSessions?.get(id);
    if (persisted && userPersistedSessions) {
      userPersistedSessions.set(id, {
        ...persisted,
        thread: { ...thread }
      });
    }
  }

  getSession(
    userId: string,
    id: string,
    options: {
      maxHistoryChars?: number;
      maxHistoryEvents?: number;
      beforeTs?: number;
      afterTs?: number;
      beforeSeq?: number;
      afterSeq?: number;
      includeHistory?: boolean;
    } = {}
  ): TerminalSessionSnapshot | null {
    const includeHistory = options.includeHistory !== false;
    // Check active sessions first
    const session = this.#sessions.get(id);
    if (session && session.userId === userId) {
      const history = includeHistory ? this.#limitHistory(session.buffer, options) : [];
      return {
        id: session.id,
        title: session.title,
        shell: session.shell,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        history,
        usesTmux: session.usesTmux,
        currentCols: session.currentCols,
        currentRows: session.currentRows,
        sandbox: session.sandbox
      };
    }

    // Fall back to persisted sessions
    const userPersistedSessions = this.#persistedSessions.get(userId);
    const persisted = userPersistedSessions?.get(id);
    if (persisted) {
      this.#ensureHistorySequences(persisted.history);
      const history = includeHistory ? this.#limitHistory(persisted.history, options) : [];
      return {
        id: persisted.id,
        title: persisted.title,
        shell: persisted.shell,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        history,
        usesTmux: false,
        sandbox: persisted.sandbox
      };
    }

    return null;
  }

  #limitHistory(
    history: TerminalStreamEvent[],
    options: {
      maxHistoryChars?: number;
      maxHistoryEvents?: number;
      beforeTs?: number;
      afterTs?: number;
      beforeSeq?: number;
      afterSeq?: number;
    }
  ): TerminalStreamEvent[] {
    const { maxHistoryChars, maxHistoryEvents, beforeTs, afterTs, beforeSeq, afterSeq } = options;
    if (!maxHistoryChars && !maxHistoryEvents && !beforeTs && !afterTs && !beforeSeq && !afterSeq) {
      return [...history];
    }

    const endIndex = beforeSeq
      ? this.#findHistoryEndIndexBySeq(history, beforeSeq)
      : (beforeTs ? this.#findHistoryEndIndex(history, beforeTs) : history.length);
    let startIndex = afterSeq
      ? this.#findHistoryStartIndexBySeq(history, afterSeq)
      : (afterTs ? this.#findHistoryStartIndex(history, afterTs) : 0);
    if (startIndex > endIndex) startIndex = endIndex;

    if (maxHistoryEvents && endIndex - startIndex > maxHistoryEvents) {
      startIndex = Math.max(0, endIndex - maxHistoryEvents);
    }

    if (maxHistoryChars) {
      let charCount = 0;
      for (let i = endIndex - 1; i >= startIndex; i -= 1) {
        charCount += history[i]?.text?.length ?? 0;
        if (charCount > maxHistoryChars) {
          startIndex = i + 1;
          break;
        }
      }
    }

    return history.slice(startIndex, endIndex);
  }

  #findHistoryEndIndex(history: TerminalStreamEvent[], beforeTs: number): number {
    if (!Number.isFinite(beforeTs) || beforeTs <= 0) return history.length;
    let low = 0;
    let high = history.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const ts = history[mid]?.ts ?? 0;
      if (ts >= beforeTs) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  #findHistoryStartIndex(history: TerminalStreamEvent[], afterTs: number): number {
    if (!Number.isFinite(afterTs) || afterTs < 0) return 0;
    let low = 0;
    let high = history.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const ts = history[mid]?.ts ?? 0;
      if (ts > afterTs) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  #findHistoryEndIndexBySeq(history: TerminalStreamEvent[], beforeSeq: number): number {
    if (!Number.isFinite(beforeSeq) || beforeSeq <= 0) return history.length;
    let low = 0;
    let high = history.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const seq = history[mid]?.seq ?? 0;
      if (seq >= beforeSeq) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  #findHistoryStartIndexBySeq(history: TerminalStreamEvent[], afterSeq: number): number {
    if (!Number.isFinite(afterSeq) || afterSeq < 0) return 0;
    let low = 0;
    let high = history.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const seq = history[mid]?.seq ?? 0;
      if (seq > afterSeq) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }

  #ensureHistorySequences(history: TerminalStreamEvent[]): number {
    let nextSeq = 1;
    for (const entry of history) {
      if (!entry) continue;
      const currentSeq = Number.isFinite(entry.seq) ? Number(entry.seq) : 0;
      if (currentSeq <= 0) {
        entry.seq = nextSeq;
      }
      nextSeq = Math.max(nextSeq, Number(entry.seq) + 1);
    }
    return nextSeq;
  }

  #emitCwdChange(session: ManagedTerminal): void {
    const message = JSON.stringify({ __terminal_meta: true, type: 'cwd', cwd: session.cwd });
    session.subscribers.forEach((subscriber) => {
      subscriber({ text: message, ts: Date.now() });
    });
  }

  #applyOsc7Cwd(session: ManagedTerminal, chunk: string): void {
    const osc7Regex = /\x1b\]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    let updated = false;

    while ((match = osc7Regex.exec(chunk)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      try {
        const url = new URL(`file://${raw}`);
        let candidate = decodeURIComponent(url.pathname || '');
        if (!candidate) continue;
        if (process.platform === 'win32') {
          if (candidate.startsWith('/')) candidate = candidate.slice(1);
          candidate = candidate.replace(/\//g, '\\');
        }
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          if (session.cwd !== candidate) {
            session.cwd = candidate;
            updated = true;
          }
        }
      } catch {
        // Ignore invalid OSC 7 payloads.
      }
    }

    if (updated) {
      this.#emitCwdChange(session);
    }
  }

  #handleData(session: ManagedTerminal, chunk: string) {
    this.#recordSessionActivity(session);
    this.#applyOsc7Cwd(session, chunk);
    session.turnDetector?.onPtyOutput(chunk, Date.now());
    session.recentOutputTail = `${session.recentOutputTail}${chunk}`.slice(-512);
    const event: TerminalStreamEvent = {
      text: chunk,
      ts: Date.now(),
      seq: session.nextEventSeq++
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

    if (outputIndicatesIdlePrompt(session.recentOutputTail)) {
      this.#markSessionIdle(session);
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
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
      }
      // Destroy output batcher and turn detector
      session.outputBatcher?.destroy();
      session.turnDetector?.dispose();

      void this.#saveSessionToDisk(session).catch((error) => {
        console.error(`Failed to persist terminal session ${session.id}:`, error);
      });

      session.subscribers.forEach((subscriber) => subscriber(null));
      session.subscribers.clear();
      this.#sessions.delete(session.id);
    }
  }

  createSession(userId: string, options: TerminalCreateOptions = {}): TerminalSessionSnapshot {
    if (this.#maxActiveSessions > 0) {
      const activeForUser = Array.from(this.#sessions.values()).filter((session) => session.userId === userId).length;
      if (activeForUser >= this.#maxActiveSessions) {
        throw new Error(`Maximum active terminal sessions reached (${this.#maxActiveSessions})`);
      }
    }

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
    const sandboxPolicy = createSandboxPolicy(cwd, options.sandboxMode, options.workspaceRoot);
    const launch = this.#sandboxRuntime.prepareTerminalLaunch({
      sessionId: id,
      userId,
      shell,
      cwd,
      cols,
      rows,
      env: options.env,
      sandbox: sandboxPolicy
    });
    cwd = launch.cwd;
    const launchShell = launch.shell;
    const launchEnv = launch.env;

    // Use tmux if available for persistent sessions
    const usesTmux = this.#useTmux;
    let ptyProcess: TerminalProcess;

    if (usesTmux) {
      console.log(`[TerminalManager] Creating tmux-backed session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell: launchShell,
        cols,
        rows,
        cwd,
        env: launchEnv
      });
    } else {
      ptyProcess = this.#spawnTerminal({
        shell: launchShell,
        cols,
        rows,
        cwd,
        env: launchEnv
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
      shell: launchShell,
      cwd,
      createdAt,
      updatedAt: createdAt,
      process: ptyProcess,
      buffer: [],
      bufferCharCount: 0,
      subscribers: new Set(),
      inputBuffer: '',
      firstCommandBuffer: '',
      firstCommandCaptured: false,
      dataHandler,
      exitHandler,
      clientDimensions: new Map(),
      primaryClientId: null,
      currentCols: cols,
      currentRows: rows,
      nextEventSeq: 1,
      usesTmux,
      sandbox: launch.sandbox,
      outputBatcher: undefined, // Will be initialized below
      lastActivityAt: Date.now(),
      busyUntilAt: 0,
      recentOutputTail: ''
    };

    // Create output batcher for this session
    session.outputBatcher = new OutputBatcher((batchedData: string) => {
      this.#handleData(session, batchedData);
    });

    // Create turn detector — emits structured turn events to WS subscribers.
    session.turnDetector = new TurnDetector(
      (turn: ChatTurn) => {
        const metaEvent = {
          text: JSON.stringify({ __terminal_meta: true, type: 'turn', ...turn }),
          ts: turn.ts,
          seq: undefined
        };
        if (turn.role === 'assistant') {
          this.#markSessionIdle(session);
        }
        session.subscribers.forEach((sub) => sub(metaEvent));
      },
      (event: TerminalCliEvent) => {
        const metaEvent = {
          text: JSON.stringify({ __terminal_meta: true, type: 'cli_event', event }),
          ts: event.ts,
          seq: undefined
        };
        if (event.type === 'prompt_required') {
          this.#markSessionIdle(session);
        }
        session.subscribers.forEach((sub) => sub(metaEvent));
      }
    );

    // PTY data handler appends to batcher instead of calling #handleData directly
    const batchedDataHandler = (data: string) => {
      session.outputBatcher?.append(data);
    };
    session.dataHandler = batchedDataHandler;

    ptyProcess.on('data', batchedDataHandler);
    ptyProcess.on('exit', exitHandler);

    this.#sessions.set(id, session);
    this.#resetIdleTimer(session);

    // Save metadata index entry (survives session file corruption)
    updateSessionMetadata(userId, id, {
      title,
      shell: launchShell,
      cwd,
      createdAt,
      sandbox: launch.sandbox
    }).catch((error) => {
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
    if (isTerminalControlResponseInput(input)) {
      return;
    }

    // Flush output buffer before processing input for better responsiveness
    session.outputBatcher?.flush();

    this.#processInputForCwd(session, input);
    this.#captureFirstCommand(session, input);
    session.turnDetector?.onUserInput(input);
    session.process.write(normaliseNewlines(input));
    this.#recordSessionActivity(session);
  }

  resize(
    userId: string,
    id: string,
    cols: number,
    rows: number,
    clientId?: string,
    options: { priority?: boolean } = {}
  ): { currentCols: number; currentRows: number; ownerClientId: string | null } {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      throw new Error(`Terminal session ${id} not found`);
    }

    const now = Date.now();

    // Track this client's dimensions
    if (clientId) {
      session.clientDimensions.set(clientId, { cols, rows, updatedAt: now });
      if (options.priority) {
        session.primaryClientId = clientId;
      }
    }

    // If there is no owner yet, the first tracked client becomes the owner.
    // Anonymous resize requests (no clientId) are treated as legacy best-effort and
    // do not take ownership because they cause width ambiguity across multiple views.
    if (!session.primaryClientId && clientId) {
      session.primaryClientId = clientId;
    }

    let targetCols = cols;
    let targetRows = rows;
    if (session.primaryClientId) {
      const primaryDims = session.clientDimensions.get(session.primaryClientId);
      if (primaryDims) {
        targetCols = primaryDims.cols;
        targetRows = primaryDims.rows;
      } else {
        session.primaryClientId = null;
      }
    }
    // If still no primary owner (legacy anonymous resize / no tracked clients), use
    // the provided size for backwards compatibility.

    if (targetCols !== session.currentCols || targetRows !== session.currentRows) {
      session.currentCols = targetCols;
      session.currentRows = targetRows;
      session.process.resize(targetCols, targetRows);
    }
    return {
      currentCols: session.currentCols,
      currentRows: session.currentRows,
      ownerClientId: session.primaryClientId ?? null
    };
  }

  // Remove a client's dimensions (called when WebSocket disconnects)
  removeClient(userId: string, id: string, clientId: string): void {
    const session = this.#sessions.get(id);
    if (!session || session.userId !== userId) {
      return;
    }

    session.clientDimensions.delete(clientId);
    if (session.primaryClientId === clientId) {
      session.primaryClientId = null;
    }

    // Promote the most recently-updated remaining client to owner and resize to its
    // dimensions. This keeps PTY width aligned with one real client instead of
    // oscillating to a synthetic "largest dimensions" size.
    if (session.clientDimensions.size > 0) {
      let nextOwnerId: string | null = null;
      let nextOwnerDims: { cols: number; rows: number; updatedAt: number } | null = null;
      for (const [candidateId, dims] of session.clientDimensions.entries()) {
        if (!nextOwnerDims || dims.updatedAt > nextOwnerDims.updatedAt) {
          nextOwnerId = candidateId;
          nextOwnerDims = dims;
        }
      }
      if (nextOwnerId && nextOwnerDims) {
        session.primaryClientId = nextOwnerId;
        if (nextOwnerDims.cols !== session.currentCols || nextOwnerDims.rows !== session.currentRows) {
          session.currentCols = nextOwnerDims.cols;
          session.currentRows = nextOwnerDims.rows;
          session.process.resize(nextOwnerDims.cols, nextOwnerDims.rows);
        }
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

  close(userId: string, id: string): boolean {
    const session = this.#sessions.get(id);
    const userPersistedSessions = this.#persistedSessions.get(userId);
    const hasPersistedSession = Boolean(userPersistedSessions?.has(id));
    const ownsActiveSession = Boolean(session && session.userId === userId);

    if (session && session.userId !== userId) {
      return false;
    }
    if (!ownsActiveSession && !hasPersistedSession) {
      return false;
    }

    let closed = false;

    if (session && session.userId === userId) {
      // Cancel pending save
      if (session.saveTimer) {
        clearTimeout(session.saveTimer);
      }
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
      }
      // Destroy output batcher and turn detector
      session.outputBatcher?.destroy();
      session.turnDetector?.dispose();
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
      closed = true;
    } else if (this.#useTmux) {
      // Session might not be active but tmux session could still exist
      // (e.g., user is deleting a persisted session without restoring it first)
      if (userPersistedSessions?.has(id) && tmuxSessionExists(id)) {
        console.log(`[TerminalManager] Destroying orphaned tmux session ${id}`);
        destroyTmuxSession(id);
        closed = true;
      }
    }

    // Also remove from persisted sessions and delete from disk
    if (userPersistedSessions) {
      if (userPersistedSessions.has(id)) {
        closed = true;
      }
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
    return closed;
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
            if (session.idleTimer) {
              clearTimeout(session.idleTimer);
              session.idleTimer = undefined;
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
        // Destroy output batcher and turn detector
        session.outputBatcher?.destroy();
        session.turnDetector?.dispose();
        if (session.idleTimer) {
          clearTimeout(session.idleTimer);
          session.idleTimer = undefined;
        }
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

    if (this.#maxActiveSessions > 0) {
      const activeForUser = Array.from(this.#sessions.values()).filter((session) => session.userId === userId).length;
      if (activeForUser >= this.#maxActiveSessions) {
        throw new Error(`Maximum active terminal sessions reached (${this.#maxActiveSessions})`);
      }
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
    const sandboxPolicy = createSandboxPolicy(
      cwd,
      persisted.sandbox?.mode ?? 'off',
      persisted.sandbox?.workspaceRoot ?? undefined,
      persisted.sandbox
    );
    const launch = this.#sandboxRuntime.prepareTerminalLaunch({
      sessionId: id,
      userId,
      shell: persisted.shell,
      cwd,
      cols,
      rows,
      sandbox: sandboxPolicy
    });
    cwd = launch.cwd;
    const launchShell = launch.shell;

    // Spawn the process - if tmux session exists, reattach to it
    const usesTmux = this.#useTmux;
    let ptyProcess: TerminalProcess;

    if (hasTmuxSession) {
      // Reattach to existing tmux session - running processes are preserved!
      console.log(`[TerminalManager] Reattaching to existing tmux session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell: launchShell,
        cols,
        rows,
        cwd
      });
    } else if (usesTmux) {
      // Create new tmux session
      console.log(`[TerminalManager] Creating new tmux session for restored session ${id}`);
      ptyProcess = spawnTmuxWithPty(ptySpawn, {
        sessionId: id,
        shell: launchShell,
        cols,
        rows,
        cwd
      });
    } else {
      // Non-tmux fallback
      ptyProcess = this.#spawnTerminal({
        shell: launchShell,
        cols,
        rows,
        cwd
      });
    }

    const dataHandler = (data: string) => this.#handleData(session, data);
    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      this.#handleExit(session, code, signal);
    };

    const restoredHistory = hasTmuxSession ? [] : persisted.history.map((entry) => ({ ...entry }));
    const nextEventSeq = hasTmuxSession ? 1 : this.#ensureHistorySequences(restoredHistory);

    const session: ManagedTerminal = {
      id: persisted.id,
      userId,
      title: persisted.title,
      shell: launchShell,
      cwd,
      createdAt: persisted.createdAt,
      updatedAt: new Date().toISOString(),
      process: ptyProcess,
      // If reattaching to tmux, don't restore old history - we'll get fresh output
      // If creating new session, restore history so user sees previous output
      buffer: restoredHistory,
      bufferCharCount: hasTmuxSession ? 0 : restoredHistory.reduce((sum, entry) => sum + entry.text.length, 0),
      subscribers: new Set(),
      inputBuffer: '',
      firstCommandBuffer: '',
      firstCommandCaptured: true, // Restored sessions already have a name
      dataHandler,
      exitHandler,
      clientDimensions: new Map(),
      primaryClientId: null,
      currentCols: cols,
      currentRows: rows,
      nextEventSeq,
      usesTmux,
      sandbox: launch.sandbox,
      outputBatcher: undefined, // Will be initialized below
      lastActivityAt: Date.now(),
      busyUntilAt: 0,
      recentOutputTail: '',
      thread: persisted.thread
    };

    // Create output batcher for this session
    session.outputBatcher = new OutputBatcher((batchedData: string) => {
      this.#handleData(session, batchedData);
    });

    // Create turn detector — emits structured turn events to WS subscribers.
    session.turnDetector = new TurnDetector(
      (turn: ChatTurn) => {
        const metaEvent = {
          text: JSON.stringify({ __terminal_meta: true, type: 'turn', ...turn }),
          ts: turn.ts,
          seq: undefined
        };
        if (turn.role === 'assistant') {
          this.#markSessionIdle(session);
        }
        session.subscribers.forEach((sub) => sub(metaEvent));
      },
      (event: TerminalCliEvent) => {
        const metaEvent = {
          text: JSON.stringify({ __terminal_meta: true, type: 'cli_event', event }),
          ts: event.ts,
          seq: undefined
        };
        if (event.type === 'prompt_required') {
          this.#markSessionIdle(session);
        }
        session.subscribers.forEach((sub) => sub(metaEvent));
      }
    );

    // PTY data handler appends to batcher instead of calling #handleData directly
    const batchedDataHandler = (data: string) => {
      session.outputBatcher?.append(data);
    };
    session.dataHandler = batchedDataHandler;

    ptyProcess.on('data', batchedDataHandler);
    ptyProcess.on('exit', exitHandler);

    this.#sessions.set(id, session);
    this.#resetIdleTimer(session);

    return this.getSession(userId, id);
  }

  #captureFirstCommand(session: ManagedTerminal, input: string): void {
    if (session.firstCommandCaptured || !input) return;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      // Enter pressed — commit the buffered command as thread topic
      if (char === '\r' || char === '\n') {
        const command = session.firstCommandBuffer.trim();
        session.firstCommandCaptured = true;
        session.firstCommandBuffer = '';

        if (!command) return; // Skip empty Enter presses

        // Truncate to 80 chars for sidebar display
        const topic = command.length > 80 ? command.slice(0, 77) + '...' : command;

        // Persist async — fire and forget
        updateThreadMetadata(session.userId, session.id, { topic })
          .then((persisted) => {
            if (persisted?.thread) {
              this.syncThreadMetadata(session.userId, session.id, persisted.thread);
              // Notify WebSocket subscribers so sidebar updates live
              const metaEvent = {
                text: JSON.stringify({
                  __terminal_meta: true,
                  type: 'threadUpdate',
                  thread: persisted.thread
                }),
                ts: Date.now(),
                seq: undefined
              };
              session.subscribers.forEach((sub) => sub(metaEvent));
            }
          })
          .catch(() => { /* updateThreadMetadata already logs */ });
        return;
      }

      // Handle backspace
      if (char === '\x7f' || char === '\b') {
        session.firstCommandBuffer = session.firstCommandBuffer.slice(0, -1);
        continue;
      }

      // Skip escape sequences
      if (char === '\x1b') {
        if (input[i + 1] === '[') {
          let j = i + 2;
          while (j < input.length) {
            const code = input.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) { j++; break; }
            j++;
          }
          i = j - 1;
        } else {
          i++;
        }
        continue;
      }

      // Skip other control characters
      if (char.charCodeAt(0) < 32) continue;

      session.firstCommandBuffer += char;
    }
  }

  #processInputForCwd(session: ManagedTerminal, input: string): void {
    if (!input) return;

    let buffer = session.inputBuffer || '';
    const previousCwd = session.cwd;
    let cwdChanged = false;

    const commitLine = () => {
      const line = buffer;
      buffer = '';
      if (this.#updateCwdFromLine(session, line)) {
        cwdChanged = true;
      }
    };

    let i = 0;
    while (i < input.length) {
      const char = input[i];

      if (char === '\x1b') {
        const next = input[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < input.length) {
            const code = input.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) {
              j += 1;
              break;
            }
            j += 1;
          }
          i = j;
          continue;
        }
        i += 2;
        continue;
      }

      if (char === '\r' || char === '\n') {
        commitLine();
        i += 1;
        if (char === '\r' && input[i] === '\n') {
          i += 1;
        }
        continue;
      }

      if (char === '\x7f' || char === '\b') {
        buffer = buffer.slice(0, -1);
        i += 1;
        continue;
      }

      if (char.charCodeAt(0) < 32) {
        i += 1;
        continue;
      }

      buffer += char;
      i += 1;
    }

    session.inputBuffer = buffer;

    if (cwdChanged && session.cwd !== previousCwd) {
      this.#emitCwdChange(session);
    }
  }

  #updateCwdFromLine(session: ManagedTerminal, line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;

    const previousCwd = session.cwd;

    // Handle bare 'cd' command (goes to home directory)
    if (trimmed === 'cd') {
      const home = process.env.HOME;
      if (home && fs.existsSync(home)) {
        session.cwd = home;
      }
      return session.cwd !== previousCwd;
    }

    const match = trimmed.match(/^cd(?:\s+\/d)?\s+(?<path>.+)$/i);
    if (!match?.groups?.path) return false;

    let target = match.groups.path.trim();
    if (
      (target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'"))
    ) {
      target = target.slice(1, -1);
    }

    if (!target) return false;

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

    return session.cwd !== previousCwd;
  }
}
