import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalEvent } from './canonical-events';
import type { ProviderAdapter, ProviderProcess } from './adapter';
import { ClaudeAdapter } from './adapters/claude-adapter';
import { ensureDataDir } from '../utils/data-dir';
import { validatePathSecurity } from '../utils/path-security';

const DATA_DIR = ensureDataDir();

// ── Persisted session shape ───────────────────────────────────────────

export interface StructuredSessionSnapshot {
  id: string;
  cwd: string;
  provider: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  events: CanonicalEvent[];
}

// ── Runtime session ───────────────────────────────────────────────────

interface ManagedStructuredSession {
  id: string;
  userId: string;
  cwd: string;
  provider: string;
  model?: string;
  events: CanonicalEvent[];
  subscribers: Set<(event: CanonicalEvent) => void>;
  process: ProviderProcess | null;
  createdAt: number;
  saveTimer: NodeJS.Timeout | null;
}

// ── File helpers ──────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error(`Invalid ID: "${id}"`);
  return safe;
}

function getUserStructuredDir(userId: string): string {
  return join(DATA_DIR, 'users', sanitizeId(userId), 'structured');
}

async function ensureUserDir(userId: string): Promise<string> {
  const dir = getUserStructuredDir(userId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

function sessionFilePath(userId: string, sessionId: string): string {
  return join(getUserStructuredDir(userId), `${sanitizeId(sessionId)}.json`);
}

// ── Manager ───────────────────────────────────────────────────────────

export class StructuredSessionManager {
  private sessions = new Map<string, ManagedStructuredSession>();
  private adapters = new Map<string, ProviderAdapter>();

  constructor() {
    // Register built-in adapters
    const claude = new ClaudeAdapter();
    this.adapters.set(claude.providerId, claude);
  }

  async initialize(): Promise<void> {
    console.log('StructuredSessionManager initialized');
  }

  // ── Adapter registry ──────────────────────────────────────────────

  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  getAdapter(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  async createSession(
    userId: string,
    cwd: string,
    provider: string = 'claude',
    model?: string
  ): Promise<StructuredSessionSnapshot> {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unknown provider: ${provider}`);

    const absoluteCwd = await validatePathSecurity(cwd, 'working directory');
    const id = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const session: ManagedStructuredSession = {
      id,
      userId,
      cwd: absoluteCwd,
      provider,
      model,
      events: [],
      subscribers: new Set(),
      process: null,
      createdAt: Date.now(),
      saveTimer: null,
    };

    this.sessions.set(id, session);
    this.scheduleSave(session);

    return this.toSnapshot(session);
  }

  async listSessions(userId: string): Promise<StructuredSessionSnapshot[]> {
    await this.loadUserSessions(userId);
    return Array.from(this.sessions.values())
      .filter((s) => s.userId === userId)
      .map((s) => this.toSnapshot(s));
  }

  getSession(userId: string, id: string): StructuredSessionSnapshot | null {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return null;
    return this.toSnapshot(session);
  }

  // ── Messaging ─────────────────────────────────────────────────────

  async sendMessage(userId: string, id: string, text: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    const adapter = this.adapters.get(session.provider);
    if (!adapter) throw new Error(`No adapter for provider: ${session.provider}`);

    // Kill any running process before starting new query
    if (session.process) {
      session.process.kill();
      session.process = null;
    }

    const process = adapter.spawn({
      prompt: text,
      cwd: session.cwd,
      sessionId: this.extractCliSessionId(session),
      model: session.model,
    });

    session.process = process;

    // Stream events from the process
    try {
      for await (const event of process.events) {
        session.events.push(event);
        this.notifySubscribers(session, event);
        this.scheduleSave(session);

        // Store CLI session ID from session_started events
        if (event.type === 'session_started' && event.sessionId !== 'unknown') {
          (session as any).cliSessionId = event.sessionId;
        }
      }
    } catch (error) {
      console.error(`[StructuredSessionManager] Error in session ${id}:`, error);
      const errorEvent: CanonicalEvent = {
        type: 'error',
        ts: Date.now(),
        seq: 0,
        message: error instanceof Error ? error.message : String(error),
      };
      session.events.push(errorEvent);
      this.notifySubscribers(session, errorEvent);
      this.scheduleSave(session);
    } finally {
      session.process = null;
    }
  }

  // ── Subscribe ─────────────────────────────────────────────────────

  subscribe(userId: string, id: string, handler: (event: CanonicalEvent) => void): () => void {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) throw new Error(`Session not found: ${id}`);

    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  // ── Control ───────────────────────────────────────────────────────

  interrupt(userId: string, id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return;
    session.process?.interrupt();
  }

  approve(userId: string, id: string, approved: boolean): void {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return;
    session.process?.sendApproval(approved);
  }

  async deleteSession(userId: string, id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId) return;

    session.process?.kill();
    if (session.saveTimer) clearTimeout(session.saveTimer);
    this.sessions.delete(id);

    const filePath = sessionFilePath(userId, id);
    if (existsSync(filePath)) {
      try { await unlink(filePath); } catch { /* ok */ }
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  private async loadUserSessions(userId: string): Promise<void> {
    const dir = await ensureUserDir(userId);

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const sessionId = file.replace('.json', '');
        if (this.sessions.has(sessionId)) continue;

        try {
          const raw = await readFile(join(dir, file), 'utf-8');
          const data = JSON.parse(raw) as StructuredSessionSnapshot;
          this.sessions.set(data.id, {
            id: data.id,
            userId,
            cwd: data.cwd,
            provider: data.provider,
            model: data.model,
            events: data.events,
            subscribers: new Set(),
            process: null,
            createdAt: data.createdAt,
            saveTimer: null,
          });
        } catch {
          console.error(`Failed to load structured session: ${file}`);
        }
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private scheduleSave(session: ManagedStructuredSession): void {
    if (session.saveTimer) clearTimeout(session.saveTimer);
    session.saveTimer = setTimeout(() => {
      void this.saveSession(session).catch((err) => {
        console.error(`Failed to save structured session ${session.id}:`, err);
      });
    }, 2000);
  }

  private async saveSession(session: ManagedStructuredSession): Promise<void> {
    await ensureUserDir(session.userId);
    const filePath = sessionFilePath(session.userId, session.id);
    const snapshot = this.toSnapshot(session);
    await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private toSnapshot(session: ManagedStructuredSession): StructuredSessionSnapshot {
    return {
      id: session.id,
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      events: session.events,
    };
  }

  private notifySubscribers(session: ManagedStructuredSession, event: CanonicalEvent): void {
    for (const handler of session.subscribers) {
      try {
        handler(event);
      } catch (e) {
        console.error('Subscriber error:', e);
      }
    }
  }

  private extractCliSessionId(session: ManagedStructuredSession): string | undefined {
    return (session as any).cliSessionId ?? undefined;
  }
}
