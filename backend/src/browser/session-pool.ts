/**
 * Browser Session Pool
 *
 * Manages pooling of browser instances for efficient resource usage.
 * Handles session lifecycle, cleanup, and resource limits.
 */

import crypto from 'crypto';
import { chromium, type Browser, type Page, type ConsoleMessage, type Request, type Response } from 'playwright';
import type {
  BrowserSessionData,
  BrowserSessionMetadata,
  SessionPoolConfig
} from './session-types.js';
import type { LogEntry } from './browser-session-service.js';

const REQUEST_TTL = 30000; // 30 seconds

export class SessionPool {
  private sessions: Map<string, BrowserSessionData> = new Map();
  private config: SessionPoolConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private requestCleanupInterval: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, { startTime: number; method: string; url: string; resourceType: string }> = new Map();

  constructor(config: SessionPoolConfig) {
    this.config = config;
  }

  /**
   * Start the cleanup interval
   */
  start(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, this.config.cleanupInterval);

    // Start cleanup for stale pending requests
    this.requestCleanupInterval = setInterval(() => {
      this.cleanupStalePendingRequests();
    }, 10000); // Every 10 seconds

    console.log('[session-pool] Started with config:', this.config);
  }

  /**
   * Stop the cleanup interval and close all sessions
   */
  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.requestCleanupInterval) {
      clearInterval(this.requestCleanupInterval);
      this.requestCleanupInterval = null;
    }

    await this.closeAllSessions();
    console.log('[session-pool] Stopped');
  }

  /**
   * Create a new browser session
   */
  async createSession(id: string, name: string): Promise<BrowserSessionData> {
    // Check session limit
    if (this.sessions.size >= this.config.maxSessions) {
      // Try to clean up idle sessions first
      await this.cleanupIdleSessions();

      // If still at limit, close oldest inactive session
      if (this.sessions.size >= this.config.maxSessions) {
        await this.closeOldestInactiveSession();
      }

      // If still at limit, throw error
      if (this.sessions.size >= this.config.maxSessions) {
        throw new Error(`Session limit reached (${this.config.maxSessions})`);
      }
    }

    // Launch browser
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    const session: BrowserSessionData = {
      id,
      name,
      browser,
      page,
      logs: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      currentUrl: 'about:blank',
      isActive: false
    };

    // Attach log listeners
    this.attachLogListeners(session);

    // Store session
    this.sessions.set(id, session);

    console.log(`[session-pool] Created session: ${id} (${name})`);
    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): BrowserSessionData | null {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session || null;
  }

  /**
   * Get all sessions
   */
  getSessions(): BrowserSessionMetadata[] {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      currentUrl: session.currentUrl,
      isActive: session.isActive
    }));
  }

  /**
   * Update session metadata
   */
  updateSession(id: string, updates: Partial<Pick<BrowserSessionMetadata, 'name' | 'currentUrl' | 'isActive'>>): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (updates.name !== undefined) {
      session.name = updates.name;
    }
    if (updates.currentUrl !== undefined) {
      session.currentUrl = updates.currentUrl;
    }
    if (updates.isActive !== undefined) {
      // If activating this session, deactivate all others
      if (updates.isActive) {
        for (const otherSession of this.sessions.values()) {
          if (otherSession.id !== id) {
            otherSession.isActive = false;
          }
        }
      }
      session.isActive = updates.isActive;
    }

    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Close a session
   */
  async closeSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    try {
      await session.browser.close();
      this.sessions.delete(id);
      console.log(`[session-pool] Closed session: ${id}`);
      return true;
    } catch (err) {
      console.error(`[session-pool] Error closing session ${id}:`, err);
      // Still remove from map even if close failed
      this.sessions.delete(id);
      return false;
    }
  }

  /**
   * Close all sessions
   */
  async closeAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.closeSession(id)));
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clean up idle sessions
   */
  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();
    const toClose: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivity;
      if (idleTime > this.config.idleTimeout) {
        toClose.push(id);
      }
    }

    if (toClose.length > 0) {
      console.log(`[session-pool] Cleaning up ${toClose.length} idle session(s)`);
      await Promise.all(toClose.map(id => this.closeSession(id)));
    }
  }

  /**
   * Close oldest inactive session to make room for new ones
   */
  private async closeOldestInactiveSession(): Promise<void> {
    let oldest: BrowserSessionData | null = null;

    for (const session of this.sessions.values()) {
      if (!session.isActive && (!oldest || session.lastActivity < oldest.lastActivity)) {
        oldest = session;
      }
    }

    if (oldest) {
      console.log(`[session-pool] Closing oldest inactive session: ${oldest.id}`);
      await this.closeSession(oldest.id);
    }
  }

  /**
   * Attach log listeners to capture console, errors, and network
   */
  private attachLogListeners(session: BrowserSessionData): void {
    const { page, logs } = session;

    // Generate unique ID for logs
    const generateLogId = () => crypto.randomUUID();

    // Console messages
    page.on('console', (msg: ConsoleMessage) => {
      const level = msg.type() as LogEntry['level'];
      logs.push({
        id: generateLogId(),
        timestamp: Date.now(),
        type: 'console',
        level: ['log', 'warn', 'error', 'info', 'debug'].includes(level) ? level : 'log',
        message: msg.text()
      });
      this.trimLogs(logs);
    });

    // Page errors
    page.on('pageerror', (error: Error) => {
      logs.push({
        id: generateLogId(),
        timestamp: Date.now(),
        type: 'error',
        message: error.message,
        stack: error.stack
      });
      this.trimLogs(logs);
    });

    // Network requests
    page.on('request', (request: Request) => {
      const requestId = request.url() + '-' + Date.now();
      this.pendingRequests.set(requestId, {
        startTime: Date.now(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType()
      });

      (request as any).__requestId = requestId;
    });

    // Network responses
    page.on('response', (response: Response) => {
      const request = response.request();
      const requestId = (request as any).__requestId;
      const pending = requestId ? this.pendingRequests.get(requestId) : null;

      if (pending) {
        logs.push({
          id: generateLogId(),
          timestamp: Date.now(),
          type: 'network',
          method: pending.method,
          url: pending.url,
          status: response.status(),
          statusText: response.statusText(),
          duration: Date.now() - pending.startTime,
          resourceType: pending.resourceType
        });
        this.pendingRequests.delete(requestId);
        this.trimLogs(logs);
      }
    });

    // Request failed
    page.on('requestfailed', (request: Request) => {
      const requestId = (request as any).__requestId;
      const pending = requestId ? this.pendingRequests.get(requestId) : null;

      if (pending) {
        logs.push({
          id: generateLogId(),
          timestamp: Date.now(),
          type: 'network',
          method: pending.method,
          url: pending.url,
          status: 0,
          statusText: request.failure()?.errorText || 'Request failed',
          duration: Date.now() - pending.startTime,
          resourceType: pending.resourceType
        });
        this.pendingRequests.delete(requestId);
        this.trimLogs(logs);
      }
    });
  }

  /**
   * Keep logs under limit (in-memory only, persistence handles long-term storage)
   */
  private trimLogs(logs: LogEntry[], maxLogs = 500): void {
    if (logs.length > maxLogs) {
      logs.splice(0, logs.length - maxLogs);
    }
  }

  /**
   * Clean up stale pending requests
   */
  private cleanupStalePendingRequests(): void {
    const now = Date.now();
    let cleanupCount = 0;
    for (const [key, request] of this.pendingRequests.entries()) {
      if (now - request.startTime > REQUEST_TTL) {
        this.pendingRequests.delete(key);
        cleanupCount++;
      }
    }
    if (cleanupCount > 0) {
      console.log(`[session-pool] Cleaned up ${cleanupCount} stale pending request(s)`);
    }
  }
}
