/**
 * Browser Session Service
 *
 * Manages headless browser lifecycle using Playwright.
 * Provides session management, log capture, and cleanup.
 */

import { chromium, Browser, Page, ConsoleMessage, Request, Response } from 'playwright';

export interface LogEntry {
  id: string;
  timestamp: number;
  type: 'console' | 'error' | 'network';
  // Console fields
  level?: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message?: string;
  // Error fields
  stack?: string;
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
  browser: Browser;
  page: Page;
  logs: LogEntry[];
  createdAt: number;
  lastActivity: number;
  currentUrl: string;
}

// Single active session (simple approach)
let activeSession: BrowserSession | null = null;

// Cleanup interval
let cleanupInterval: NodeJS.Timeout | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Track pending network requests for duration calculation
const pendingRequests = new Map<string, { startTime: number; method: string; url: string; resourceType: string }>();

/**
 * Start a new browser session
 */
export async function startSession(): Promise<BrowserSession> {
  // Close existing session if any
  if (activeSession) {
    await stopSession();
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  const session: BrowserSession = {
    id: generateId(),
    browser,
    page,
    logs: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    currentUrl: 'about:blank'
  };

  // Attach log listeners
  attachLogListeners(session);

  activeSession = session;

  // Start cleanup interval if not running
  if (!cleanupInterval) {
    startCleanupInterval();
  }

  console.log(`[browser] Session started: ${session.id}`);
  return session;
}

/**
 * Get the active session
 */
export function getSession(): BrowserSession | null {
  if (activeSession) {
    activeSession.lastActivity = Date.now();
  }
  return activeSession;
}

/**
 * Stop the active session
 */
export async function stopSession(): Promise<boolean> {
  if (!activeSession) {
    return false;
  }

  try {
    await activeSession.browser.close();
    console.log(`[browser] Session stopped: ${activeSession.id}`);
  } catch (err) {
    console.error('[browser] Error closing browser:', err);
  }

  activeSession = null;
  pendingRequests.clear();
  return true;
}

/**
 * Get session status
 */
export function getSessionStatus(): {
  active: boolean;
  id?: string;
  currentUrl?: string;
  logCount?: number;
  createdAt?: number;
  lastActivity?: number;
} {
  if (!activeSession) {
    return { active: false };
  }

  return {
    active: true,
    id: activeSession.id,
    currentUrl: activeSession.currentUrl,
    logCount: activeSession.logs.length,
    createdAt: activeSession.createdAt,
    lastActivity: activeSession.lastActivity
  };
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
  if (!activeSession) return;

  const idleTime = Date.now() - activeSession.lastActivity;
  if (idleTime > IDLE_TIMEOUT_MS) {
    console.log(`[browser] Cleaning up idle session: ${activeSession.id} (idle for ${Math.round(idleTime / 1000)}s)`);
    stopSession();
  }
}

/**
 * Start cleanup interval
 */
function startCleanupInterval(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    cleanupIdleSessions();
  }, CLEANUP_INTERVAL_MS);
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
