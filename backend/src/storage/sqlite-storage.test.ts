/**
 * SQLite Storage Adapter Tests
 *
 * Unit tests for SQLite storage implementation.
 * Uses in-memory SQLite database for fast, isolated tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorage } from './sqlite-storage.js';
import type { IStorage } from './storage-interface.js';

describe('SQLiteStorage', () => {
  let storage: IStorage;

  beforeEach(() => {
    // Use in-memory database for tests
    storage = new SQLiteStorage(':memory:');
  });

  afterEach(() => {
    // Close database connection
    if (storage && typeof (storage as any).close === 'function') {
      (storage as any).close();
    }
  });

  describe('Log Operations', () => {
    it('should add a single log entry', () => {
      const logEntry = storage.addLog({
        session_id: 'session-1',
        port: 3000,
        timestamp: Date.now(),
        type: 'console',
        level: 'log',
        message: 'Test message'
      });

      expect(logEntry.id).toBeTruthy();
      expect(logEntry.created_at).toBeTruthy();
      expect(logEntry.message).toBe('Test message');
    });

    it('should add multiple log entries in batch', () => {
      const timestamp = Date.now();
      const entries = storage.addLogs([
        {
          session_id: 'session-1',
          port: 3000,
          timestamp,
          type: 'console',
          level: 'log',
          message: 'Message 1'
        },
        {
          session_id: 'session-1',
          port: 3000,
          timestamp: timestamp + 1,
          type: 'console',
          level: 'warn',
          message: 'Message 2'
        }
      ]);

      expect(entries).toHaveLength(2);
      expect(entries[0].message).toBe('Message 1');
      expect(entries[1].message).toBe('Message 2');
    });

    it('should retrieve logs by session ID', () => {
      const timestamp = Date.now();
      storage.addLog({
        session_id: 'session-1',
        port: 3000,
        timestamp,
        type: 'console',
        level: 'log',
        message: 'Session 1 log'
      });
      storage.addLog({
        session_id: 'session-2',
        port: 3000,
        timestamp: timestamp + 1,
        type: 'console',
        level: 'log',
        message: 'Session 2 log'
      });

      const logs = storage.getLogs({ sessionId: 'session-1' });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('Session 1 log');
    });

    it('should retrieve logs by port', () => {
      const timestamp = Date.now();
      storage.addLog({
        session_id: null,
        port: 3000,
        timestamp,
        type: 'network',
        method: 'GET',
        url: 'http://localhost:3000/api'
      });
      storage.addLog({
        session_id: null,
        port: 4000,
        timestamp: timestamp + 1,
        type: 'network',
        method: 'POST',
        url: 'http://localhost:4000/api'
      });

      const logs = storage.getLogs({ port: 3000 });
      expect(logs).toHaveLength(1);
      expect(logs[0].url).toBe('http://localhost:3000/api');
    });

    it('should filter logs by type', () => {
      const timestamp = Date.now();
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp,
        type: 'console',
        level: 'log',
        message: 'Console log'
      });
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: timestamp + 1,
        type: 'error',
        message: 'Error message'
      });

      const consoleLogs = storage.getLogs({ sessionId: 'session-1', type: 'console' });
      expect(consoleLogs).toHaveLength(1);
      expect(consoleLogs[0].type).toBe('console');

      const errorLogs = storage.getLogs({ sessionId: 'session-1', type: 'error' });
      expect(errorLogs).toHaveLength(1);
      expect(errorLogs[0].type).toBe('error');
    });

    it('should filter logs by timestamp', () => {
      const baseTime = Date.now();
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: baseTime,
        type: 'console',
        message: 'Old log'
      });
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: baseTime + 1000,
        type: 'console',
        message: 'New log'
      });

      const logs = storage.getLogs({ sessionId: 'session-1', since: baseTime + 500 });
      expect(logs).toHaveLength(1);
      expect(logs[0].message).toBe('New log');
    });

    it('should respect limit and offset', () => {
      const timestamp = Date.now();
      for (let i = 0; i < 10; i++) {
        storage.addLog({
          session_id: 'session-1',
          port: null,
          timestamp: timestamp + i,
          type: 'console',
          message: `Message ${i}`
        });
      }

      const firstPage = storage.getLogs({ sessionId: 'session-1', limit: 3, offset: 0 });
      expect(firstPage).toHaveLength(3);
      expect(firstPage[0].message).toBe('Message 0');

      const secondPage = storage.getLogs({ sessionId: 'session-1', limit: 3, offset: 3 });
      expect(secondPage).toHaveLength(3);
      expect(secondPage[0].message).toBe('Message 3');
    });

    it('should get log count', () => {
      const timestamp = Date.now();
      for (let i = 0; i < 5; i++) {
        storage.addLog({
          session_id: 'session-1',
          port: null,
          timestamp: timestamp + i,
          type: 'console',
          message: `Message ${i}`
        });
      }

      const count = storage.getLogCount({ sessionId: 'session-1' });
      expect(count).toBe(5);

      const consoleCount = storage.getLogCount({ sessionId: 'session-1', type: 'console' });
      expect(consoleCount).toBe(5);
    });

    it('should clear logs by session ID', () => {
      const timestamp = Date.now();
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp,
        type: 'console',
        message: 'Session 1'
      });
      storage.addLog({
        session_id: 'session-2',
        port: null,
        timestamp: timestamp + 1,
        type: 'console',
        message: 'Session 2'
      });

      const deleted = storage.clearLogs({ sessionId: 'session-1' });
      expect(deleted).toBe(1);

      const remaining = storage.getLogs({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].session_id).toBe('session-2');
    });

    it('should clear logs older than timestamp', () => {
      const baseTime = Date.now();
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: baseTime - 10000,
        type: 'console',
        message: 'Old log'
      });
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: baseTime,
        type: 'console',
        message: 'New log'
      });

      const deleted = storage.clearLogs({ olderThan: baseTime - 5000 });
      expect(deleted).toBe(1);

      const remaining = storage.getLogs({ sessionId: 'session-1' });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].message).toBe('New log');
    });

    it('should handle JSON serialization for headers and storage', () => {
      const logEntry = storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: Date.now(),
        type: 'network',
        requestHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
        responseHeaders: JSON.stringify({ 'Content-Length': '123' }),
        localStorage: JSON.stringify({ key: 'value' })
      });

      const logs = storage.getLogs({ sessionId: 'session-1' });
      expect(logs[0].requestHeaders).toBe(JSON.stringify({ 'Content-Type': 'application/json' }));
    });
  });

  describe('Browser Session Operations', () => {
    it('should create a browser session', () => {
      const session = storage.createSession({
        id: 'session-1',
        name: 'Test Session',
        current_url: 'about:blank',
        is_active: true
      });

      expect(session.id).toBe('session-1');
      expect(session.name).toBe('Test Session');
      expect(session.created_at).toBeTruthy();
      expect(session.last_activity).toBeTruthy();
    });

    it('should get a session by ID', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Test Session',
        current_url: 'about:blank',
        is_active: true
      });

      const session = storage.getSession('session-1');
      expect(session).toBeTruthy();
      expect(session!.name).toBe('Test Session');
    });

    it('should return null for non-existent session', () => {
      const session = storage.getSession('non-existent');
      expect(session).toBeNull();
    });

    it('should list all sessions', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Session 1',
        current_url: 'about:blank',
        is_active: true
      });
      storage.createSession({
        id: 'session-2',
        name: 'Session 2',
        current_url: 'about:blank',
        is_active: false
      });

      const sessions = storage.getSessions();
      expect(sessions).toHaveLength(2);
    });

    it('should filter sessions by active status', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Active',
        current_url: 'about:blank',
        is_active: true
      });
      storage.createSession({
        id: 'session-2',
        name: 'Inactive',
        current_url: 'about:blank',
        is_active: false
      });

      const activeSessions = storage.getSessions({ isActive: true });
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].name).toBe('Active');
    });

    it('should update a session', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Original',
        current_url: 'about:blank',
        is_active: true
      });

      const updated = storage.updateSession('session-1', {
        name: 'Updated',
        current_url: 'https://example.com',
        is_active: false
      });

      expect(updated).toBe(true);

      const session = storage.getSession('session-1');
      expect(session!.name).toBe('Updated');
      expect(session!.current_url).toBe('https://example.com');
      expect(session!.is_active).toBe(false);
    });

    it('should delete a session', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Test',
        current_url: 'about:blank',
        is_active: true
      });

      const deleted = storage.deleteSession('session-1');
      expect(deleted).toBe(true);

      const session = storage.getSession('session-1');
      expect(session).toBeNull();
    });

    it('should cascade delete session logs when session is deleted', () => {
      storage.createSession({
        id: 'session-1',
        name: 'Test',
        current_url: 'about:blank',
        is_active: true
      });

      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp: Date.now(),
        type: 'console',
        message: 'Test log'
      });

      storage.deleteSession('session-1');

      const logs = storage.getLogs({ sessionId: 'session-1' });
      expect(logs).toHaveLength(0);
    });
  });

  describe('Visual Baseline Operations', () => {
    beforeEach(() => {
      // Create a test session for baseline tests
      storage.createSession({
        id: 'session-1',
        name: 'Test Session',
        current_url: 'about:blank',
        is_active: true
      });
    });

    it('should create a visual baseline', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      const baseline = storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'abc123',
        viewport_width: 1920,
        viewport_height: 1080
      });

      expect(baseline.id).toBeTruthy();
      expect(baseline.session_id).toBe('session-1');
      expect(baseline.screenshot_hash).toBe('abc123');
    });

    it('should get a baseline by ID', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      const created = storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'abc123',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const baseline = storage.getBaseline(created.id);
      expect(baseline).toBeTruthy();
      expect(baseline!.screenshot_hash).toBe('abc123');
    });

    it('should get baselines by session ID', () => {
      storage.createSession({
        id: 'session-2',
        name: 'Session 2',
        current_url: 'about:blank',
        is_active: true
      });

      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com/page1',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash1',
        viewport_width: 1920,
        viewport_height: 1080
      });
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com/page2',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash2',
        viewport_width: 1920,
        viewport_height: 1080
      });
      storage.createBaseline({
        session_id: 'session-2',
        url: 'https://example.com/page3',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash3',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const baselines = storage.getBaselines('session-1');
      expect(baselines).toHaveLength(2);
      expect(baselines.every(b => b.session_id === 'session-1')).toBe(true);
    });

    it('should get baseline by URL and selector', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: '#header',
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash1',
        viewport_width: 1920,
        viewport_height: 1080
      });
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash2',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const baseline = storage.getBaselineByUrl('session-1', 'https://example.com', '#header');
      expect(baseline).toBeTruthy();
      expect(baseline!.screenshot_hash).toBe('hash1');
      expect(baseline!.selector).toBe('#header');
    });

    it('should update a baseline', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      const created = storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'old-hash',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const newBuffer = Buffer.from('new-screenshot-data');
      const updated = storage.updateBaseline(created.id, {
        screenshot_data: newBuffer,
        screenshot_hash: 'new-hash'
      });

      expect(updated).toBe(true);

      const baseline = storage.getBaseline(created.id);
      expect(baseline!.screenshot_hash).toBe('new-hash');
    });

    it('should delete a baseline', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      const created = storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const deleted = storage.deleteBaseline(created.id);
      expect(deleted).toBe(true);

      const baseline = storage.getBaseline(created.id);
      expect(baseline).toBeNull();
    });

    it('should delete all baselines for a session', () => {
      const screenshotBuffer = Buffer.from('fake-screenshot-data');
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com/page1',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash1',
        viewport_width: 1920,
        viewport_height: 1080
      });
      storage.createBaseline({
        session_id: 'session-1',
        url: 'https://example.com/page2',
        selector: null,
        screenshot_data: screenshotBuffer,
        screenshot_hash: 'hash2',
        viewport_width: 1920,
        viewport_height: 1080
      });

      const deleted = storage.deleteBaselines('session-1');
      expect(deleted).toBe(2);

      const baselines = storage.getBaselines('session-1');
      expect(baselines).toHaveLength(0);
    });
  });

  describe('Transaction Support', () => {
    it('should commit transaction on success', () => {
      const result = storage.runInTransaction(() => {
        storage.createSession({
          id: 'session-1',
          name: 'Test',
          current_url: 'about:blank',
          is_active: true
        });
        return 'success';
      });

      expect(result).toBe('success');
      const session = storage.getSession('session-1');
      expect(session).toBeTruthy();
    });

    it('should rollback transaction on error', () => {
      try {
        storage.runInTransaction(() => {
          storage.createSession({
            id: 'session-1',
            name: 'Test',
            current_url: 'about:blank',
            is_active: true
          });
          throw new Error('Test error');
        });
      } catch (err: any) {
        expect(err.message).toBe('Test error');
      }

      const session = storage.getSession('session-1');
      expect(session).toBeNull();
    });
  });

  describe('Stats and Maintenance', () => {
    it('should return storage stats', () => {
      const timestamp = Date.now();
      storage.createSession({
        id: 'session-1',
        name: 'Test',
        current_url: 'about:blank',
        is_active: true
      });
      storage.addLog({
        session_id: 'session-1',
        port: null,
        timestamp,
        type: 'console',
        message: 'Test'
      });

      const stats = storage.getStats();
      expect(stats.totalLogs).toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalBaselines).toBe(0);
      expect(stats.databaseSizeBytes).toBeGreaterThan(0);
      expect(stats.oldestLogTimestamp).toBe(timestamp);
      expect(stats.newestLogTimestamp).toBe(timestamp);
    });

    it('should vacuum database', () => {
      // Add some data
      storage.createSession({
        id: 'session-1',
        name: 'Test',
        current_url: 'about:blank',
        is_active: true
      });

      // Delete it
      storage.deleteSession('session-1');

      // Vacuum should not throw
      expect(() => storage.vacuum()).not.toThrow();
    });
  });
});
