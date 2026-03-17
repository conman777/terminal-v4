// Server-side request log store for preview proxy
// Captures all requests going through the proxy for debugging

// Max body size to capture (50KB)
const MAX_BODY_SIZE = 50 * 1024;

// Headers to filter out for security
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-auth-token',
  'x-api-key',
  'api-key',
  'x-csrf-token',
  'x-xsrf-token'
]);

export interface ProxyLogEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  duration: number;
  requestSize: number | null;
  responseSize: number | null;
  contentType: string | null;
  error: string | null;
  // New fields for full network logging
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
}

/**
 * Filter sensitive headers from a headers object
 */
export function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    } else {
      filtered[key] = '[REDACTED]';
    }
  }
  return filtered;
}

/**
 * Truncate body if too large
 */
export function truncateBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_BODY_SIZE) {
    return { body, truncated: false };
  }
  return {
    body: body.slice(0, MAX_BODY_SIZE) + '\n... [truncated at 50KB]',
    truncated: true
  };
}

// Log store keyed by scope+port.
const logStores = new Map<string, ProxyLogEntry[]>();

// Max logs per port
const MAX_LOGS_PER_PORT = 200;

// Generate unique ID
let idCounter = 0;
function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

/**
 * Add a log entry for a request
 */
export function addProxyLog(scopeId: string, port: number, entry: Omit<ProxyLogEntry, 'id'>): void {
  const id = generateId();
  const storeKey = getPreviewStoreKey(scopeId, port);

  if (!logStores.has(storeKey)) {
    logStores.set(storeKey, []);
  }
  const logs = logStores.get(storeKey)!;

  const logEntry = {
    id,
    ...entry
  };

  logs.push(logEntry);

  // Trim to max size (in-memory only)
  if (logs.length > MAX_LOGS_PER_PORT) {
    logs.splice(0, logs.length - MAX_LOGS_PER_PORT);
  }
}

/**
 * Get all logs for a port
 */
export function getProxyLogs(scopeId: string, port: number, since?: number): ProxyLogEntry[] {
  const logs = logStores.get(getPreviewStoreKey(scopeId, port)) || [];
  if (since) {
    return logs.filter(log => log.timestamp > since);
  }
  return [...logs];
}

export function getProxyLogsAfterCursor(
  scopeId: string,
  port: number,
  cursor: { timestamp: number; id: string | null }
): ProxyLogEntry[] {
  const logs = logStores.get(getPreviewStoreKey(scopeId, port)) || [];
  if (!cursor.timestamp) {
    return [...logs];
  }

  const result: ProxyLogEntry[] = [];
  let passedCursor = cursor.id === null;

  for (const log of logs) {
    if (log.timestamp < cursor.timestamp) {
      continue;
    }
    if (log.timestamp > cursor.timestamp) {
      result.push(log);
      continue;
    }
    if (passedCursor) {
      result.push(log);
      continue;
    }
    if (log.id === cursor.id) {
      passedCursor = true;
    }
  }

  return result;
}

/**
 * Clear logs for a port
 */
export function clearProxyLogs(scopeId: string, port: number): void {
  logStores.delete(getPreviewStoreKey(scopeId, port));
}

/**
 * Get latest log timestamp for a port (for polling)
 */
export function getLatestLogTimestamp(scopeId: string, port: number): number {
  const logs = logStores.get(getPreviewStoreKey(scopeId, port));
  if (!logs || logs.length === 0) return 0;
  return logs[logs.length - 1].timestamp;
}

/**
 * Get all ports that have been previewed (have logs)
 */
export function getActivePreviewPorts(scopeId: string): number[] {
  const prefix = `${scopeId}:`;
  return Array.from(logStores.keys())
    .filter((key) => key.startsWith(prefix))
    .map((key) => Number.parseInt(key.slice(prefix.length), 10))
    .filter((port) => Number.isFinite(port))
    .sort((a, b) => a - b);
}
import { getPreviewStoreKey } from './preview-scope.js';
