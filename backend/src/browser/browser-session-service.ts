/**
 * Browser Session Service
 *
 * Manages headless browser lifecycle using Playwright.
 * Provides session management, log capture, and cleanup.
 */

import { chromium, Browser, Page, ConsoleMessage, Request, Response } from 'playwright';
import { getBrowserSettings } from '../settings/browser-settings-service.js';

export interface LogEntry {
  id: string;
  timestamp: number;
  type: 'console' | 'error' | 'network';
  // Console fields
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message?: string;
  // Error fields
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  // Network fields
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  duration?: number;
  resourceType?: string;
}

export interface BrowserSession {
  id: string;
  name: string;
  browser: Browser;
  page: Page;
  logs: LogEntry[];
  createdAt: number;
  lastActivity: number;
  currentUrl: string;
}

// Multiple sessions support
const sessions = new Map<string, BrowserSession>();
let activeSessionId: string | null = null;

// Cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Track pending network requests for duration calculation
const pendingRequests = new Map<string, { startTime: number; method: string; url: string; resourceType: string }>();

/**
 * Start a new browser session
 */
export async function startSession(name?: string): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const sessionId = generateId();
  const session: BrowserSession = {
    id: sessionId,
    name: name || `Session ${sessionId.slice(0, 8)}`,
    browser,
    page,
    logs: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    currentUrl: 'about:blank'
  };

  // Attach log listeners
  attachLogListeners(session);

  sessions.set(sessionId, session);
  activeSessionId = sessionId;

  // Start cleanup interval if not running
  if (!cleanupInterval) {
    startCleanupInterval();
  }

  console.log(`[browser] Session started: ${session.id} (${session.name})`);
  return session;
}

/**
 * Get the active session (for backward compatibility)
 */
export function getSession(): BrowserSession | null {
  if (!activeSessionId) {
    return null;
  }
  const session = sessions.get(activeSessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
  return session || null;
}

/**
 * Get a specific session by ID
 */
export function getSessionById(sessionId: string): BrowserSession | null {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
  }
  return session || null;
}

/**
 * Get all sessions
 */
export function getAllSessions(): BrowserSession[] {
  return Array.from(sessions.values());
}

/**
 * Switch to a different active session
 */
export function switchSession(sessionId: string): boolean {
  if (sessions.has(sessionId)) {
    activeSessionId = sessionId;
    return true;
  }
  return false;
}

/**
 * Stop the active session
 */
export async function stopSession(): Promise<boolean> {
  if (!activeSessionId) {
    return false;
  }
  return await stopSessionById(activeSessionId);
}

/**
 * Stop a specific session by ID
 */
export async function stopSessionById(sessionId: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  try {
    await session.browser.close();
    console.log(`[browser] Session stopped: ${session.id} (${session.name})`);
  } catch (err) {
    console.error('[browser] Error closing browser:', err);
  }

  sessions.delete(sessionId);

  if (activeSessionId === sessionId) {
    // Switch to another session if available
    const remainingSessions = Array.from(sessions.keys());
    activeSessionId = remainingSessions.length > 0 ? remainingSessions[0] : null;
  }

  pendingRequests.clear();
  return true;
}

/**
 * Get session status (for backward compatibility)
 */
export function getSessionStatus(): {
  active: boolean;
  id?: string;
  name?: string;
  currentUrl?: string;
  logCount?: number;
  createdAt?: number;
  lastActivity?: number;
} {
  const session = getSession();
  if (!session) {
    return { active: false };
  }

  return {
    active: true,
    id: session.id,
    name: session.name,
    currentUrl: session.currentUrl,
    logCount: session.logs.length,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity
  };
}

/**
 * Get status of all sessions
 */
export function getAllSessionsStatus(): Array<{
  id: string;
  name: string;
  currentUrl: string;
  logCount: number;
  createdAt: number;
  lastActivity: number;
  isActive: boolean;
}> {
  return Array.from(sessions.values()).map(session => ({
    id: session.id,
    name: session.name,
    currentUrl: session.currentUrl,
    logCount: session.logs.length,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    isActive: session.id === activeSessionId
  }));
}

/**
 * Attach log listeners to capture console, errors, and network
 */
function attachLogListeners(session: BrowserSession): void {
  const { page, logs } = session;

  // Console messages
  page.on('console', (msg: ConsoleMessage) => {
    const level = msg.type() as LogEntry['level'];
    logs.push({
      id: generateId(),
      timestamp: Date.now(),
      type: 'console',
      level: ['log', 'warn', 'error', 'info', 'debug'].includes(level) ? level : 'log',
      message: msg.text()
    });
    trimLogs(logs);
  });

  // Page errors (uncaught exceptions)
  page.on('pageerror', (error: Error) => {
    logs.push({
      id: generateId(),
      timestamp: Date.now(),
      type: 'error',
      message: error.message,
      stack: error.stack
    });
    trimLogs(logs);
  });

  // Network requests
  page.on('request', (request: Request) => {
    const requestId = request.url() + '-' + Date.now();
    pendingRequests.set(requestId, {
      startTime: Date.now(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType()
    });

    // Store request ID on request for later lookup
    (request as any).__requestId = requestId;
  });

  // Network responses
  page.on('response', (response: Response) => {
    const request = response.request();
    const requestId = (request as any).__requestId;
    const pending = requestId ? pendingRequests.get(requestId) : null;

    if (pending) {
      logs.push({
        id: generateId(),
        timestamp: Date.now(),
        type: 'network',
        method: pending.method,
        url: pending.url,
        status: response.status(),
        statusText: response.statusText(),
        duration: Date.now() - pending.startTime,
        resourceType: pending.resourceType
      });
      pendingRequests.delete(requestId);
      trimLogs(logs);
    }
  });

  // Request failed
  page.on('requestfailed', (request: Request) => {
    const requestId = (request as any).__requestId;
    const pending = requestId ? pendingRequests.get(requestId) : null;

    if (pending) {
      logs.push({
        id: generateId(),
        timestamp: Date.now(),
        type: 'network',
        method: pending.method,
        url: pending.url,
        status: 0,
        statusText: request.failure()?.errorText || 'Request failed',
        duration: Date.now() - pending.startTime,
        resourceType: pending.resourceType
      });
      pendingRequests.delete(requestId);
      trimLogs(logs);
    }
  });
}

/**
 * Keep logs under limit
 */
function trimLogs(logs: LogEntry[], maxLogs = 500): void {
  if (logs.length > maxLogs) {
    logs.splice(0, logs.length - maxLogs);
  }
}

/**
 * Clean up idle sessions
 */
function cleanupIdleSessions(): void {
  if (sessions.size === 0) return;

  const settings = getBrowserSettings();
  const now = Date.now();
  const sessionsToClose: string[] = [];

  for (const [sessionId, session] of sessions.entries()) {
    const idleTime = now - session.lastActivity;
    const age = now - session.createdAt;

    // Check idle timeout
    if (idleTime > settings.idleTimeoutMs) {
      console.log(`[browser] Cleaning up idle session: ${session.id} (${session.name}) - idle for ${Math.round(idleTime / 1000)}s`);
      sessionsToClose.push(sessionId);
      continue;
    }

    // Check max lifetime
    if (age > settings.maxLifetimeMs) {
      console.log(`[browser] Cleaning up old session: ${session.id} (${session.name}) - age ${Math.round(age / 1000)}s`);
      sessionsToClose.push(sessionId);
    }
  }

  // Close sessions that need cleanup
  for (const sessionId of sessionsToClose) {
    stopSessionById(sessionId);
  }
}

/**
 * Start cleanup interval
 */
function startCleanupInterval(): void {
  if (cleanupInterval) return;

  const settings = getBrowserSettings();
  cleanupInterval = setInterval(() => {
    cleanupIdleSessions();
  }, settings.cleanupIntervalMs);
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
