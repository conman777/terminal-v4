/**
 * SQLite Storage Adapter
 *
 * Implements IStorage interface using better-sqlite3 for fast, synchronous
 * database operations with connection pooling support.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDataDir } from '../utils/data-dir.js';
import { runMigrations } from './migration-runner.js';
import type {
  IStorage,
  StoredLogEntry,
  StoredBrowserSession,
  StoredVisualBaseline,
  GetLogsOptions,
  StorageStats
} from './storage-interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generateId(): string {
  return crypto.randomUUID();
}

export class SQLiteStorage implements IStorage {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || this.getDefaultPath();

    // Initialize database connection
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this.db.pragma('foreign_keys = ON'); // Enable foreign keys
    this.db.pragma('synchronous = NORMAL'); // Good balance of safety/performance

    // Run migrations
    // Note: For bundled builds, migrations are copied to dist/storage/migrations
    const migrationsPath = path.join(__dirname, 'migrations');
    runMigrations(this.db, migrationsPath);

    console.log(`[sqlite-storage] Initialized at: ${finalPath}`);
  }

  private getDefaultPath(): string {
    const dataDir = ensureDataDir();
    return path.join(dataDir, 'browser-storage.db');
  }

  // ============ LOG OPERATIONS ============

  addLog(entry: Omit<StoredLogEntry, 'id' | 'created_at'>): StoredLogEntry {
    const id = generateId();
    const created_at = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO browser_logs (
        id, session_id, port, timestamp, type, level, message,
        filename, lineno, colno, stack, method, url, status, statusText,
        duration, responsePreview, requestHeaders, responseHeaders,
        requestBody, responseBody, html, localStorage, sessionStorage, created_at
      ) VALUES (
        @id, @session_id, @port, @timestamp, @type, @level, @message,
        @filename, @lineno, @colno, @stack, @method, @url, @status, @statusText,
        @duration, @responsePreview, @requestHeaders, @responseHeaders,
        @requestBody, @responseBody, @html, @localStorage, @sessionStorage, @created_at
      )
    `);

    stmt.run({
      id,
      created_at,
      session_id: entry.session_id,
      port: entry.port,
      timestamp: entry.timestamp,
      type: entry.type,
      level: entry.level ?? null,
      message: entry.message ?? null,
      filename: entry.filename ?? null,
      lineno: entry.lineno ?? null,
      colno: entry.colno ?? null,
      stack: entry.stack ?? null,
      method: entry.method ?? null,
      url: entry.url ?? null,
      status: entry.status ?? null,
      statusText: entry.statusText ?? null,
      duration: entry.duration ?? null,
      responsePreview: entry.responsePreview ?? null,
      requestHeaders: entry.requestHeaders ?? null,
      responseHeaders: entry.responseHeaders ?? null,
      requestBody: entry.requestBody ?? null,
      responseBody: entry.responseBody ?? null,
      html: entry.html ?? null,
      localStorage: entry.localStorage ?? null,
      sessionStorage: entry.sessionStorage ?? null
    });

    return { id, created_at, ...entry };
  }

  addLogs(entries: Omit<StoredLogEntry, 'id' | 'created_at'>[]): StoredLogEntry[] {
    const insertMany = this.db.transaction((logs: Omit<StoredLogEntry, 'id' | 'created_at'>[]) => {
      return logs.map(entry => this.addLog(entry));
    });

    return insertMany(entries);
  }

  getLogs(options: GetLogsOptions): StoredLogEntry[] {
    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (options.sessionId) {
      conditions.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }

    if (options.port !== undefined) {
      conditions.push('port = @port');
      params.port = options.port;
    }

    if (options.type) {
      conditions.push('type = @type');
      params.type = options.type;
    }

    if (options.level) {
      conditions.push('level = @level');
      params.level = options.level;
    }

    if (options.since) {
      conditions.push('timestamp >= @since');
      params.since = options.since;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit !== undefined ? options.limit : 100;
    const offset = options.offset || 0;

    // Add limit and offset to params to prevent SQL injection
    params.limit = limit;
    params.offset = offset;

    const sql = `
      SELECT * FROM browser_logs
      ${whereClause}
      ORDER BY timestamp ASC
      LIMIT @limit OFFSET @offset
    `;

    const stmt = this.db.prepare(sql);
    return stmt.all(params) as StoredLogEntry[];
  }

  getLogCount(options: Omit<GetLogsOptions, 'limit' | 'offset'>): number {
    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (options.sessionId) {
      conditions.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }

    if (options.port !== undefined) {
      conditions.push('port = @port');
      params.port = options.port;
    }

    if (options.type) {
      conditions.push('type = @type');
      params.type = options.type;
    }

    if (options.level) {
      conditions.push('level = @level');
      params.level = options.level;
    }

    if (options.since) {
      conditions.push('timestamp >= @since');
      params.since = options.since;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM browser_logs ${whereClause}`;

    const stmt = this.db.prepare(sql);
    const result = stmt.get(params) as { count: number };
    return result.count;
  }

  clearLogs(options: { sessionId?: string; port?: number; olderThan?: number }): number {
    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (options.sessionId) {
      conditions.push('session_id = @sessionId');
      params.sessionId = options.sessionId;
    }

    if (options.port !== undefined) {
      conditions.push('port = @port');
      params.port = options.port;
    }

    if (options.olderThan) {
      conditions.push('timestamp < @olderThan');
      params.olderThan = options.olderThan;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `DELETE FROM browser_logs ${whereClause}`;

    const stmt = this.db.prepare(sql);
    const result = stmt.run(params);
    return result.changes;
  }

  // ============ BROWSER SESSION OPERATIONS ============

  createSession(session: Omit<StoredBrowserSession, 'created_at' | 'last_activity'>): StoredBrowserSession {
    const created_at = new Date().toISOString();
    const last_activity = created_at;

    const stmt = this.db.prepare(`
      INSERT INTO browser_sessions (
        id, name, created_at, last_activity, current_url, is_active, metadata
      ) VALUES (
        @id, @name, @created_at, @last_activity, @current_url, @is_active, @metadata
      )
    `);

    stmt.run({
      id: session.id,
      name: session.name,
      current_url: session.current_url,
      is_active: session.is_active ? 1 : 0,
      metadata: session.metadata || null,
      created_at,
      last_activity
    });

    return {
      ...session,
      created_at,
      last_activity
    };
  }

  getSession(id: string): StoredBrowserSession | null {
    const stmt = this.db.prepare('SELECT * FROM browser_sessions WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) return null;

    return {
      ...row,
      is_active: row.is_active === 1
    };
  }

  getSessions(options?: { isActive?: boolean; limit?: number }): StoredBrowserSession[] {
    let sql = 'SELECT * FROM browser_sessions';
    const params: any[] = [];

    if (options?.isActive !== undefined) {
      sql += ' WHERE is_active = ?';
      params.push(options.isActive ? 1 : 0);
    }

    sql += ' ORDER BY last_activity DESC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      ...row,
      is_active: row.is_active === 1
    }));
  }

  updateSession(id: string, updates: Partial<Omit<StoredBrowserSession, 'id' | 'created_at'>>): boolean {
    const fields: string[] = [];
    const params: Record<string, any> = { id };

    if (updates.name !== undefined) {
      fields.push('name = @name');
      params.name = updates.name;
    }

    if (updates.current_url !== undefined) {
      fields.push('current_url = @current_url');
      params.current_url = updates.current_url;
    }

    if (updates.is_active !== undefined) {
      fields.push('is_active = @is_active');
      params.is_active = updates.is_active ? 1 : 0;
    }

    if (updates.last_activity !== undefined) {
      fields.push('last_activity = @last_activity');
      params.last_activity = updates.last_activity;
    }

    if (updates.metadata !== undefined) {
      fields.push('metadata = @metadata');
      params.metadata = updates.metadata;
    }

    if (fields.length === 0) {
      return false;
    }

    const sql = `UPDATE browser_sessions SET ${fields.join(', ')} WHERE id = @id`;
    const stmt = this.db.prepare(sql);
    const result = stmt.run(params);
    return result.changes > 0;
  }

  deleteSession(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM browser_sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deactivateAllSessionsExcept(id: string): number {
    const stmt = this.db.prepare('UPDATE browser_sessions SET is_active = 0 WHERE id != ?');
    const result = stmt.run(id);
    return result.changes;
  }

  // ============ VISUAL BASELINE OPERATIONS ============

  createBaseline(baseline: Omit<StoredVisualBaseline, 'id' | 'created_at' | 'updated_at'>): StoredVisualBaseline {
    const id = generateId();
    const created_at = new Date().toISOString();
    const updated_at = created_at;

    const stmt = this.db.prepare(`
      INSERT INTO visual_baselines (
        id, session_id, url, selector, screenshot_data, screenshot_hash,
        viewport_width, viewport_height, created_at, updated_at, metadata
      ) VALUES (
        @id, @session_id, @url, @selector, @screenshot_data, @screenshot_hash,
        @viewport_width, @viewport_height, @created_at, @updated_at, @metadata
      )
    `);

    stmt.run({
      id,
      created_at,
      updated_at,
      session_id: baseline.session_id,
      url: baseline.url,
      selector: baseline.selector,
      screenshot_data: baseline.screenshot_data,
      screenshot_hash: baseline.screenshot_hash,
      viewport_width: baseline.viewport_width,
      viewport_height: baseline.viewport_height,
      metadata: baseline.metadata ?? null
    });

    return {
      id,
      created_at,
      updated_at,
      ...baseline
    };
  }

  getBaseline(id: string): StoredVisualBaseline | null {
    const stmt = this.db.prepare('SELECT * FROM visual_baselines WHERE id = ?');
    const result = stmt.get(id);
    return result ? (result as StoredVisualBaseline) : null;
  }

  getBaselines(sessionId: string): StoredVisualBaseline[] {
    const stmt = this.db.prepare('SELECT * FROM visual_baselines WHERE session_id = ? ORDER BY created_at DESC');
    return stmt.all(sessionId) as StoredVisualBaseline[];
  }

  getBaselineByUrl(sessionId: string, url: string, selector?: string): StoredVisualBaseline | null {
    const stmt = this.db.prepare(`
      SELECT * FROM visual_baselines
      WHERE session_id = ? AND url = ? AND (selector IS ? OR selector = ?)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(sessionId, url, selector || null, selector || null) as StoredVisualBaseline | null;
  }

  updateBaseline(id: string, updates: Partial<Omit<StoredVisualBaseline, 'id' | 'session_id' | 'created_at'>>): boolean {
    const fields: string[] = ['updated_at = @updated_at'];
    const params: Record<string, any> = {
      id,
      updated_at: new Date().toISOString()
    };

    if (updates.url !== undefined) {
      fields.push('url = @url');
      params.url = updates.url;
    }

    if (updates.selector !== undefined) {
      fields.push('selector = @selector');
      params.selector = updates.selector;
    }

    if (updates.screenshot_data !== undefined) {
      fields.push('screenshot_data = @screenshot_data');
      params.screenshot_data = updates.screenshot_data;
    }

    if (updates.screenshot_hash !== undefined) {
      fields.push('screenshot_hash = @screenshot_hash');
      params.screenshot_hash = updates.screenshot_hash;
    }

    if (updates.viewport_width !== undefined) {
      fields.push('viewport_width = @viewport_width');
      params.viewport_width = updates.viewport_width;
    }

    if (updates.viewport_height !== undefined) {
      fields.push('viewport_height = @viewport_height');
      params.viewport_height = updates.viewport_height;
    }

    if (updates.metadata !== undefined) {
      fields.push('metadata = @metadata');
      params.metadata = updates.metadata;
    }

    const sql = `UPDATE visual_baselines SET ${fields.join(', ')} WHERE id = @id`;
    const stmt = this.db.prepare(sql);
    const result = stmt.run(params);
    return result.changes > 0;
  }

  deleteBaseline(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM visual_baselines WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteBaselines(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM visual_baselines WHERE session_id = ?');
    const result = stmt.run(sessionId);
    return result.changes;
  }

  // ============ MAINTENANCE OPERATIONS ============

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  getStats(): StorageStats {
    const logCount = this.db.prepare('SELECT COUNT(*) as count FROM browser_logs').get() as { count: number };
    const sessionCount = this.db.prepare('SELECT COUNT(*) as count FROM browser_sessions').get() as { count: number };
    const baselineCount = this.db.prepare('SELECT COUNT(*) as count FROM visual_baselines').get() as { count: number };

    const logTimestamps = this.db.prepare(
      'SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM browser_logs'
    ).get() as { oldest: number | null; newest: number | null };

    // Get database file size
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;
    const databaseSizeBytes = pageCount * pageSize;

    return {
      totalLogs: logCount.count,
      totalSessions: sessionCount.count,
      totalBaselines: baselineCount.count,
      databaseSizeBytes,
      oldestLogTimestamp: logTimestamps.oldest,
      newestLogTimestamp: logTimestamps.newest
    };
  }

  // ============ TRANSACTION SUPPORT ============

  runInTransaction<T>(fn: () => T): T {
    const transaction = this.db.transaction(fn);
    return transaction();
  }

  // ============ CLEANUP ============

  close(): void {
    this.db.close();
  }
}
