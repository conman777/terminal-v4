/**
 * Process Log Store
 *
 * Captures and stores stdout/stderr from processes running on preview ports.
 * Allows AI to access server-side logs for debugging.
 */

export interface ProcessLogEntry {
  id: string;
  timestamp: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ProcessInfo {
  pid: number;
  port: number | null;  // null until process starts listening
  command: string;
  cwd: string;
  startedAt: number;
  exitCode: number | null;
  exitedAt: number | null;
  logs: ProcessLogEntry[];
}

// Store by PID
const processLogs = new Map<number, ProcessInfo>();

// Map port to PID for quick lookup
const portToPid = new Map<number, number>();

// Configuration
const MAX_LOGS_PER_PROCESS = 1000;
const MAX_LOG_SIZE = 50 * 1024; // 50KB per log entry
const CLEANUP_AFTER_EXIT_MS = 30 * 60 * 1000; // Keep logs 30 min after process exits

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Generate unique ID for log entry
 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

/**
 * Register a new process for log capture
 */
export function registerProcess(pid: number, command: string, cwd: string): void {
  processLogs.set(pid, {
    pid,
    port: null,
    command,
    cwd,
    startedAt: Date.now(),
    exitCode: null,
    exitedAt: null,
    logs: []
  });
}

/**
 * Add a log entry for a process
 */
export function addProcessLog(pid: number, stream: 'stdout' | 'stderr', data: string): void {
  const process = processLogs.get(pid);
  if (!process) return;

  // Truncate large log entries
  const truncatedData = data.length > MAX_LOG_SIZE
    ? data.slice(0, MAX_LOG_SIZE) + '\n... [truncated]'
    : data;

  const entry: ProcessLogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    stream,
    data: truncatedData
  };

  process.logs.push(entry);

  // Trim old logs if over limit (FIFO)
  if (process.logs.length > MAX_LOGS_PER_PROCESS) {
    process.logs.splice(0, process.logs.length - MAX_LOGS_PER_PROCESS);
  }
}

/**
 * Associate a port with a process (called when port detection occurs)
 */
export function associatePort(pid: number, port: number): void {
  const process = processLogs.get(pid);
  if (!process) return;

  // Remove old port mapping if exists
  if (process.port !== null) {
    portToPid.delete(process.port);
  }

  process.port = port;
  portToPid.set(port, pid);
}

/**
 * Mark process as exited
 */
export function markProcessExited(pid: number, exitCode: number | null): void {
  const process = processLogs.get(pid);
  if (!process) return;

  process.exitCode = exitCode;
  process.exitedAt = Date.now();
}

/**
 * Get logs for a port
 */
export function getProcessLogsByPort(port: number, since?: number): ProcessLogEntry[] {
  const pid = portToPid.get(port);
  if (pid === undefined) return [];

  const process = processLogs.get(pid);
  if (!process) return [];

  if (since !== undefined) {
    return process.logs.filter(log => log.timestamp > since);
  }
  return [...process.logs];
}

export function getProcessLogsByPortAfterCursor(
  port: number,
  cursor: { timestamp: number; id: string | null }
): ProcessLogEntry[] {
  const pid = portToPid.get(port);
  if (pid === undefined) return [];

  const process = processLogs.get(pid);
  if (!process) return [];

  if (!cursor.timestamp) {
    return [...process.logs];
  }

  const result: ProcessLogEntry[] = [];
  let matchedCursor = cursor.id === null;

  for (const log of process.logs) {
    if (log.timestamp < cursor.timestamp) {
      continue;
    }
    if (log.timestamp > cursor.timestamp) {
      result.push(log);
      continue;
    }
    if (matchedCursor) {
      result.push(log);
      continue;
    }
    if (log.id === cursor.id) {
      matchedCursor = true;
    }
  }

  if (!matchedCursor && cursor.id !== null) {
    return process.logs.filter((log) => log.timestamp >= cursor.timestamp);
  }

  return result;
}

/**
 * Get logs for a PID
 */
export function getProcessLogsByPid(pid: number, since?: number): ProcessLogEntry[] {
  const process = processLogs.get(pid);
  if (!process) return [];

  if (since !== undefined) {
    return process.logs.filter(log => log.timestamp > since);
  }
  return [...process.logs];
}

/**
 * Get process info by port
 */
export function getProcessInfoByPort(port: number): ProcessInfo | null {
  const pid = portToPid.get(port);
  if (pid === undefined) return null;
  return processLogs.get(pid) || null;
}

/**
 * Get process info by PID
 */
export function getProcessInfoByPid(pid: number): ProcessInfo | null {
  return processLogs.get(pid) || null;
}

/**
 * Get all tracked processes
 */
export function getAllProcesses(): ProcessInfo[] {
  return Array.from(processLogs.values());
}

/**
 * Get all active (non-exited) processes
 */
export function getActiveProcesses(): ProcessInfo[] {
  return Array.from(processLogs.values()).filter(p => p.exitedAt === null);
}

/**
 * Clear logs for a process
 */
export function clearProcessLogs(pid: number): number {
  const process = processLogs.get(pid);
  if (!process) return 0;

  const count = process.logs.length;
  process.logs = [];
  return count;
}

/**
 * Remove a process and its logs
 */
export function removeProcess(pid: number): void {
  const process = processLogs.get(pid);
  if (process?.port !== null) {
    portToPid.delete(process.port);
  }
  processLogs.delete(pid);
}

/**
 * Cleanup old exited processes
 */
function cleanupExitedProcesses(): void {
  const now = Date.now();

  for (const [pid, process] of processLogs.entries()) {
    if (process.exitedAt !== null && now - process.exitedAt > CLEANUP_AFTER_EXIT_MS) {
      removeProcess(pid);
    }
  }
}

/**
 * Start cleanup interval
 */
export function startCleanupInterval(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(cleanupExitedProcesses, 5 * 60 * 1000); // Every 5 minutes
}

/**
 * Stop cleanup interval
 */
export function stopCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup on module load
startCleanupInterval();
