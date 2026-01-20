/**
 * Browser Session Manager
 *
 * Coordinates multi-session management with persistence layer.
 * Handles session lifecycle, log persistence, and cleanup.
 */

import crypto from 'crypto';
import { SessionPool } from './session-pool.js';
import { SQLiteStorage } from '../storage/sqlite-storage.js';
import type { IStorage } from '../storage/storage-interface.js';
import type {
  BrowserSessionData,
  BrowserSessionMetadata,
  SessionManagerConfig
} from './session-types.js';
import type { LogEntry } from './browser-session-service.js';

export class SessionManager {
  private pool: SessionPool;
  private storage: IStorage | null = null;
  private config: SessionManagerConfig;
  private retentionCleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: SessionManagerConfig, storage?: IStorage) {
    this.config = config;
    this.pool = new SessionPool({
      maxSessions: config.maxSessions,
      idleTimeout: config.idleTimeout,
      cleanupInterval: config.cleanupInterval
    });

    if (config.enablePersistence) {
      this.storage = storage || new SQLiteStorage();
      console.log('[session-manager] Persistence enabled');
    }
  }

  /**
   * Start the session manager
   */
  start(): void {
    this.pool.start();

    // Start retention cleanup if persistence is enabled
    if (this.storage) {
      this.startRetentionCleanup();
    }

    console.log('[session-manager] Started');
  }

  /**
   * Stop the session manager
   */
  async stop(): Promise<void> {
    await this.pool.stop();

    if (this.retentionCleanupInterval) {
      clearInterval(this.retentionCleanupInterval);
      this.retentionCleanupInterval = null;
    }

    console.log('[session-manager] Stopped');
  }

  /**
   * Create a new browser session
   */
  async createSession(name?: string): Promise<BrowserSessionMetadata> {
    const id = this.generateId();
    const sessionName = name || `Session ${Date.now()}`;

    // Create session in pool
    const session = await this.pool.createSession(id, sessionName);

    // Persist session metadata if enabled
    if (this.storage) {
      this.storage.createSession({
        id: session.id,
        name: session.name,
        current_url: session.currentUrl,
        is_active: session.isActive
      });
    }

    return {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      currentUrl: session.currentUrl,
      isActive: session.isActive
    };
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): BrowserSessionMetadata | null {
    const session = this.pool.getSession(id);
    if (!session) return null;

    // Update last activity in storage
    if (this.storage) {
      this.storage.updateSession(id, {
        last_activity: new Date().toISOString()
      });
    }

    return {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      currentUrl: session.currentUrl,
      isActive: session.isActive
    };
  }

  /**
   * Get internal session data (with browser/page)
   */
  getSessionData(id: string): BrowserSessionData | null {
    return this.pool.getSession(id);
  }

  /**
   * Get all sessions
   */
  getSessions(): BrowserSessionMetadata[] {
    return this.pool.getSessions();
  }

  /**
   * Update session
   */
  updateSession(id: string, updates: Partial<Pick<BrowserSessionMetadata, 'name' | 'currentUrl' | 'isActive'>>): boolean {
    const success = this.pool.updateSession(id, updates);

    if (success && this.storage) {
      const storageUpdates: any = {
        last_activity: new Date().toISOString()
      };

      if (updates.name !== undefined) storageUpdates.name = updates.name;
      if (updates.currentUrl !== undefined) storageUpdates.current_url = updates.currentUrl;
      if (updates.isActive !== undefined) {
        storageUpdates.is_active = updates.isActive;

        // If activating this session, deactivate all others in storage
        if (updates.isActive) {
          this.storage.deactivateAllSessionsExcept(id);
        }
      }

      this.storage.updateSession(id, storageUpdates);
    }

    return success;
  }

  /**
   * Set active session
   */
  setActiveSession(id: string): boolean {
    return this.updateSession(id, { isActive: true });
  }

  /**
   * Get active session
   */
  getActiveSession(): BrowserSessionMetadata | null {
    const sessions = this.pool.getSessions();
    const active = sessions.find(s => s.isActive);
    return active || null;
  }

  /**
   * Close a session
   */
  async closeSession(id: string): Promise<boolean> {
    const success = await this.pool.closeSession(id);

    if (success && this.storage) {
      // Delete session from storage (cascade will delete logs)
      this.storage.deleteSession(id);
    }

    return success;
  }

  /**
   * Add log entry for a session
   */
  addLog(sessionId: string, entry: Omit<LogEntry, 'id'>): void {
    const session = this.pool.getSession(sessionId);
    if (!session) return;

    const logEntry: LogEntry = {
      ...entry,
      id: this.generateId()
    };

    session.logs.push(logEntry);

    // Persist to storage
    if (this.storage) {
      this.storage.addLog({
        session_id: sessionId,
        port: null,
        timestamp: entry.timestamp,
        type: entry.type,
        level: entry.level,
        message: entry.message,
        filename: entry.filename,
        lineno: entry.lineno,
        colno: entry.colno,
        stack: entry.stack,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        statusText: entry.statusText,
        duration: entry.duration,
        resourceType: entry.resourceType
      });
    }
  }

  /**
   * Get logs for a session
   */
  getLogs(sessionId: string, options?: { type?: string; since?: number; limit?: number }): LogEntry[] {
    // If persistence is enabled, get from storage
    if (this.storage) {
      const logs = this.storage.getLogs({
        sessionId,
        type: options?.type as any,
        since: options?.since,
        limit: options?.limit || 100
      });

      return logs.map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        level: log.level,
        message: log.message,
        stack: log.stack,
        method: log.method,
        url: log.url,
        status: log.status,
        statusText: log.statusText,
        duration: log.duration,
        resourceType: log.resourceType
      }));
    }

    // Otherwise, get from in-memory session
    const session = this.pool.getSession(sessionId);
    if (!session) return [];

    let logs = session.logs;

    if (options?.type) {
      logs = logs.filter(log => log.type === options.type);
    }

    if (options?.since) {
      logs = logs.filter(log => log.timestamp >= options.since!);
    }

    if (options?.limit) {
      logs = logs.slice(-options.limit);
    }

    return logs;
  }

  /**
   * Clear logs for a session
   */
  clearLogs(sessionId: string): void {
    const session = this.pool.getSession(sessionId);
    if (session) {
      session.logs = [];
    }

    if (this.storage) {
      this.storage.clearLogs({ sessionId });
    }
  }

  /**
   * Get stats
   */
  getStats(): {
    sessionCount: number;
    maxSessions: number;
    storageStats?: any;
  } {
    const stats: any = {
      sessionCount: this.pool.getSessionCount(),
      maxSessions: this.config.maxSessions
    };

    if (this.storage) {
      stats.storageStats = this.storage.getStats();
    }

    return stats;
  }

  /**
   * Start retention cleanup interval
   */
  private startRetentionCleanup(): void {
    if (!this.storage || this.retentionCleanupInterval) return;

    // Run cleanup every hour
    this.retentionCleanupInterval = setInterval(() => {
      this.cleanupOldLogs();
    }, 60 * 60 * 1000); // 1 hour

    console.log(`[session-manager] Started retention cleanup (${this.config.logRetentionDays} days)`);
  }

  /**
   * Clean up old logs based on retention policy
   */
  private cleanupOldLogs(): void {
    if (!this.storage) return;

    const retentionMs = this.config.logRetentionDays * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMs;

    const deleted = this.storage.clearLogs({ olderThan: cutoffTime });
    if (deleted > 0) {
      console.log(`[session-manager] Cleaned up ${deleted} old log(s) (older than ${this.config.logRetentionDays} days)`);
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return crypto.randomUUID();
  }
}
