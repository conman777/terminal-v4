/**
 * Storage Interface
 *
 * Abstract interface for storage adapters to enable testing and
 * potential future support for different storage backends.
 */

// Log entry types
export interface StoredLogEntry {
  id: string;
  session_id: string | null;
  port: number | null;
  timestamp: number;
  type: 'console' | 'error' | 'network' | 'dom' | 'storage';
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  duration?: number;
  responsePreview?: string;
  requestHeaders?: string; // JSON string
  responseHeaders?: string; // JSON string
  requestBody?: string;
  responseBody?: string;
  html?: string;
  localStorage?: string; // JSON string
  sessionStorage?: string; // JSON string
  created_at: string; // ISO timestamp
}

// Browser session metadata
export interface StoredBrowserSession {
  id: string;
  name: string;
  created_at: string;
  last_activity: string;
  current_url: string;
  is_active: boolean;
  metadata?: string; // JSON string for additional session data
}

// Visual baseline snapshot
export interface StoredVisualBaseline {
  id: string;
  session_id: string;
  url: string;
  selector: string | null;
  screenshot_data: Buffer;
  screenshot_hash: string;
  viewport_width: number;
  viewport_height: number;
  created_at: string;
  updated_at: string;
  metadata?: string; // JSON string
}

// Abstract storage interface
export interface IStorage {
  // Log operations
  addLog(entry: Omit<StoredLogEntry, 'id' | 'created_at'>): StoredLogEntry;
  addLogs(entries: Omit<StoredLogEntry, 'id' | 'created_at'>[]): StoredLogEntry[];
  getLogs(options: GetLogsOptions): StoredLogEntry[];
  getLogCount(options: Omit<GetLogsOptions, 'limit' | 'offset'>): number;
  clearLogs(options: { sessionId?: string; port?: number; olderThan?: number }): number;

  // Browser session operations
  createSession(session: Omit<StoredBrowserSession, 'created_at' | 'last_activity'>): StoredBrowserSession;
  getSession(id: string): StoredBrowserSession | null;
  getSessions(options?: { isActive?: boolean; limit?: number }): StoredBrowserSession[];
  updateSession(id: string, updates: Partial<Omit<StoredBrowserSession, 'id' | 'created_at'>>): boolean;
  deleteSession(id: string): boolean;
  deactivateAllSessionsExcept(id: string): number;

  // Visual baseline operations
  createBaseline(baseline: Omit<StoredVisualBaseline, 'id' | 'created_at' | 'updated_at'>): StoredVisualBaseline;
  getBaseline(id: string): StoredVisualBaseline | null;
  getBaselines(sessionId: string): StoredVisualBaseline[];
  getBaselineByUrl(sessionId: string, url: string, selector?: string): StoredVisualBaseline | null;
  updateBaseline(id: string, updates: Partial<Omit<StoredVisualBaseline, 'id' | 'session_id' | 'created_at'>>): boolean;
  deleteBaseline(id: string): boolean;
  deleteBaselines(sessionId: string): number;

  // Maintenance operations
  vacuum(): void;
  getStats(): StorageStats;

  // Transaction support
  runInTransaction<T>(fn: () => T): T;
}

export interface GetLogsOptions {
  sessionId?: string;
  port?: number;
  type?: 'console' | 'error' | 'network' | 'dom' | 'storage';
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  since?: number;
  limit?: number;
  offset?: number;
}

export interface StorageStats {
  totalLogs: number;
  totalSessions: number;
  totalBaselines: number;
  databaseSizeBytes: number;
  oldestLogTimestamp: number | null;
  newestLogTimestamp: number | null;
}
