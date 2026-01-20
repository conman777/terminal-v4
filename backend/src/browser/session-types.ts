/**
 * Browser Session Types
 *
 * Type definitions for multi-session browser management.
 */

import type { Browser, Page } from 'playwright';
import type { LogEntry } from './browser-session-service.js';

export interface BrowserSessionMetadata {
  id: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  currentUrl: string;
  isActive: boolean;
}

export interface BrowserSessionData extends BrowserSessionMetadata {
  browser: Browser;
  page: Page;
  logs: LogEntry[];
}

export interface SessionPoolConfig {
  maxSessions: number;
  idleTimeout: number; // milliseconds
  cleanupInterval: number; // milliseconds
}

export interface SessionManagerConfig extends SessionPoolConfig {
  enablePersistence: boolean;
  logRetentionDays: number;
}

export const DEFAULT_SESSION_CONFIG: SessionManagerConfig = {
  maxSessions: 5,
  idleTimeout: 5 * 60 * 1000, // 5 minutes
  cleanupInterval: 60 * 1000, // 1 minute
  enablePersistence: true,
  logRetentionDays: 7
};
