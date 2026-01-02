/**
 * Preview Logs Service
 *
 * Stores console logs, errors, and network requests from preview apps
 * so Claude Code can query them for debugging.
 */

export interface PreviewLogEntry {
  id: string;
  timestamp: number;
  type: 'console' | 'error' | 'network';
  // Console fields
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message?: string;
  // Error fields
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  // Network fields
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  duration?: number;
  responsePreview?: string;
  error?: string;
}

interface PortLogData {
  logs: PreviewLogEntry[];
  lastActivity: number;
}

// In-memory storage: port -> logs
const portLogs = new Map<number, PortLogData>();

// Configuration
const MAX_LOGS_PER_PORT = 500;
const STALE_PORT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Add a log entry for a port
 */
export function addLog(port: number, entry: Omit<PreviewLogEntry, 'id'>): PreviewLogEntry {
  let portData = portLogs.get(port);

  if (!portData) {
    portData = { logs: [], lastActivity: Date.now() };
    portLogs.set(port, portData);
  }

  const logEntry: PreviewLogEntry = {
    id: generateId(),
    ...entry
  };

  portData.logs.push(logEntry);
  portData.lastActivity = Date.now();

  // Enforce max logs limit
  if (portData.logs.length > MAX_LOGS_PER_PORT) {
    portData.logs = portData.logs.slice(-MAX_LOGS_PER_PORT);
  }

  return logEntry;
}

/**
 * Add multiple log entries (batch)
 */
export function addLogs(port: number, entries: Omit<PreviewLogEntry, 'id'>[]): PreviewLogEntry[] {
  return entries.map(entry => addLog(port, entry));
}

export interface GetLogsOptions {
  type?: 'console' | 'error' | 'network';
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  since?: number;
  limit?: number;
}

/**
 * Get logs for a port with optional filtering
 */
export function getLogs(port: number, options: GetLogsOptions = {}): PreviewLogEntry[] {
  const portData = portLogs.get(port);
  if (!portData) {
    return [];
  }

  let logs = portData.logs;

  // Filter by type
  if (options.type) {
    logs = logs.filter(log => log.type === options.type);
  }

  // Filter by level (for console logs)
  if (options.level) {
    logs = logs.filter(log => log.level === options.level);
  }

  // Filter by timestamp
  if (options.since) {
    logs = logs.filter(log => log.timestamp >= options.since);
  }

  // Apply limit (default 100, from end)
  const limit = options.limit ?? 100;
  if (logs.length > limit) {
    logs = logs.slice(-limit);
  }

  return logs;
}

/**
 * Get summary stats for a port
 */
export function getLogStats(port: number): { total: number; byType: Record<string, number>; byLevel: Record<string, number> } | null {
  const portData = portLogs.get(port);
  if (!portData) {
    return null;
  }

  const byType: Record<string, number> = {};
  const byLevel: Record<string, number> = {};

  for (const log of portData.logs) {
    byType[log.type] = (byType[log.type] || 0) + 1;
    if (log.level) {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;
    }
  }

  return {
    total: portData.logs.length,
    byType,
    byLevel
  };
}

/**
 * Clear all logs for a port
 */
export function clearLogs(port: number): boolean {
  const portData = portLogs.get(port);
  if (!portData) {
    return false;
  }

  portData.logs = [];
  portData.lastActivity = Date.now();
  return true;
}

/**
 * Get list of active ports with log counts
 */
export function getActivePorts(): Array<{ port: number; count: number; lastActivity: number }> {
  const result: Array<{ port: number; count: number; lastActivity: number }> = [];

  for (const [port, data] of portLogs.entries()) {
    result.push({
      port,
      count: data.logs.length,
      lastActivity: data.lastActivity
    });
  }

  return result.sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Clean up stale ports (no activity for 1 hour)
 */
export function cleanupStalePorts(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [port, data] of portLogs.entries()) {
    if (now - data.lastActivity > STALE_PORT_TIMEOUT_MS) {
      portLogs.delete(port);
      cleaned++;
    }
  }

  return cleaned;
}

// Start cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupInterval(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const cleaned = cleanupStalePorts();
    if (cleaned > 0) {
      console.log(`[preview-logs] Cleaned up ${cleaned} stale port(s)`);
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
