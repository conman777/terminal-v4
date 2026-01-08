import { describe, it, expect, beforeEach } from 'vitest';
import { addProxyLog, getProxyLogs, clearProxyLogs, getLatestLogTimestamp } from './request-log-store';

describe('request-log-store', () => {
  const testPort = 9999;

  beforeEach(() => {
    clearProxyLogs(testPort);
  });

  describe('addProxyLog', () => {
    it('adds a log entry with generated id', () => {
      addProxyLog(testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/test',
        status: 200,
        statusText: 'OK',
        duration: 50,
        requestSize: null,
        responseSize: 1024,
        contentType: 'text/html',
        error: null
      });

      const logs = getProxyLogs(testPort);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        timestamp: 1000,
        method: 'GET',
        url: '/test',
        status: 200,
        duration: 50
      });
      expect(logs[0].id).toBeDefined();
    });

    it('trims logs to MAX_LOGS_PER_PORT (200)', () => {
      // Add 250 logs
      for (let i = 0; i < 250; i++) {
        addProxyLog(testPort, {
          timestamp: i,
          method: 'GET',
          url: `/test-${i}`,
          status: 200,
          statusText: 'OK',
          duration: 10,
          requestSize: null,
          responseSize: 100,
          contentType: 'text/html',
          error: null
        });
      }

      const logs = getProxyLogs(testPort);
      expect(logs).toHaveLength(200);
      // Should have the last 200 (indices 50-249)
      expect(logs[0].url).toBe('/test-50');
      expect(logs[199].url).toBe('/test-249');
    });

    it('stores logs separately per port', () => {
      addProxyLog(8000, {
        timestamp: 1000,
        method: 'GET',
        url: '/port-8000',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(8001, {
        timestamp: 2000,
        method: 'POST',
        url: '/port-8001',
        status: 201,
        statusText: 'Created',
        duration: 20,
        requestSize: 50,
        responseSize: 200,
        contentType: 'application/json',
        error: null
      });

      expect(getProxyLogs(8000)).toHaveLength(1);
      expect(getProxyLogs(8001)).toHaveLength(1);
      expect(getProxyLogs(8000)[0].url).toBe('/port-8000');
      expect(getProxyLogs(8001)[0].url).toBe('/port-8001');

      // Cleanup
      clearProxyLogs(8000);
      clearProxyLogs(8001);
    });
  });

  describe('getProxyLogs', () => {
    it('returns empty array for port with no logs', () => {
      expect(getProxyLogs(12345)).toEqual([]);
    });

    it('returns copy of logs (not the original array)', () => {
      addProxyLog(testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/test',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      const logs1 = getProxyLogs(testPort);
      const logs2 = getProxyLogs(testPort);
      expect(logs1).not.toBe(logs2);
      expect(logs1).toEqual(logs2);
    });

    it('filters by since timestamp', () => {
      addProxyLog(testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/old',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(testPort, {
        timestamp: 2000,
        method: 'GET',
        url: '/new',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      const allLogs = getProxyLogs(testPort);
      expect(allLogs).toHaveLength(2);

      const newLogs = getProxyLogs(testPort, 1000);
      expect(newLogs).toHaveLength(1);
      expect(newLogs[0].url).toBe('/new');

      const noLogs = getProxyLogs(testPort, 2000);
      expect(noLogs).toHaveLength(0);
    });
  });

  describe('clearProxyLogs', () => {
    it('removes all logs for a port', () => {
      addProxyLog(testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/test',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      expect(getProxyLogs(testPort)).toHaveLength(1);
      clearProxyLogs(testPort);
      expect(getProxyLogs(testPort)).toHaveLength(0);
    });

    it('does not affect other ports', () => {
      addProxyLog(8000, {
        timestamp: 1000,
        method: 'GET',
        url: '/port-8000',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(8001, {
        timestamp: 2000,
        method: 'GET',
        url: '/port-8001',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      clearProxyLogs(8000);
      expect(getProxyLogs(8000)).toHaveLength(0);
      expect(getProxyLogs(8001)).toHaveLength(1);

      clearProxyLogs(8001);
    });
  });

  describe('getLatestLogTimestamp', () => {
    it('returns 0 for port with no logs', () => {
      expect(getLatestLogTimestamp(12345)).toBe(0);
    });

    it('returns timestamp of most recent log', () => {
      addProxyLog(testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/first',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(testPort, {
        timestamp: 3000,
        method: 'GET',
        url: '/last',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      expect(getLatestLogTimestamp(testPort)).toBe(3000);
    });
  });
});
