import { beforeEach, describe, expect, it } from 'vitest';
import {
  addProxyLog,
  clearProxyLogs,
  getLatestLogTimestamp,
  getProxyLogs,
  getProxyLogsAfterCursor
} from './request-log-store';

describe('request-log-store', () => {
  const testScopeId = 'user-1';
  const otherScopeId = 'user-2';
  const testPort = 9999;

  beforeEach(() => {
    clearProxyLogs(testScopeId, testPort);
    clearProxyLogs(otherScopeId, testPort);
    clearProxyLogs(testScopeId, 8000);
    clearProxyLogs(testScopeId, 8001);
  });

  describe('addProxyLog', () => {
    it('adds a log entry with generated id', () => {
      addProxyLog(testScopeId, testPort, {
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

      const logs = getProxyLogs(testScopeId, testPort);
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
      for (let i = 0; i < 250; i++) {
        addProxyLog(testScopeId, testPort, {
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

      const logs = getProxyLogs(testScopeId, testPort);
      expect(logs).toHaveLength(200);
      expect(logs[0].url).toBe('/test-50');
      expect(logs[199].url).toBe('/test-249');
    });

    it('stores logs separately per port', () => {
      addProxyLog(testScopeId, 8000, {
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

      addProxyLog(testScopeId, 8001, {
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

      expect(getProxyLogs(testScopeId, 8000)).toHaveLength(1);
      expect(getProxyLogs(testScopeId, 8001)).toHaveLength(1);
      expect(getProxyLogs(testScopeId, 8000)[0].url).toBe('/port-8000');
      expect(getProxyLogs(testScopeId, 8001)[0].url).toBe('/port-8001');
    });

    it('isolates logs by preview scope', () => {
      addProxyLog(testScopeId, testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/scope-1',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(otherScopeId, testPort, {
        timestamp: 2000,
        method: 'GET',
        url: '/scope-2',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      expect(getProxyLogs(testScopeId, testPort).map((log) => log.url)).toEqual(['/scope-1']);
      expect(getProxyLogs(otherScopeId, testPort).map((log) => log.url)).toEqual(['/scope-2']);
    });
  });

  describe('getProxyLogs', () => {
    it('returns empty array for port with no logs', () => {
      expect(getProxyLogs(testScopeId, 12345)).toEqual([]);
    });

    it('returns copy of logs (not the original array)', () => {
      addProxyLog(testScopeId, testPort, {
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

      const logs1 = getProxyLogs(testScopeId, testPort);
      const logs2 = getProxyLogs(testScopeId, testPort);
      expect(logs1).not.toBe(logs2);
      expect(logs1).toEqual(logs2);
    });

    it('filters by since timestamp', () => {
      addProxyLog(testScopeId, testPort, {
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

      addProxyLog(testScopeId, testPort, {
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

      const allLogs = getProxyLogs(testScopeId, testPort);
      expect(allLogs).toHaveLength(2);

      const newLogs = getProxyLogs(testScopeId, testPort, 1000);
      expect(newLogs).toHaveLength(1);
      expect(newLogs[0].url).toBe('/new');

      const noLogs = getProxyLogs(testScopeId, testPort, 2000);
      expect(noLogs).toHaveLength(0);
    });

    it('returns logs after a cursor when multiple entries share a timestamp', () => {
      addProxyLog(testScopeId, testPort, {
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

      addProxyLog(testScopeId, testPort, {
        timestamp: 1000,
        method: 'GET',
        url: '/second',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      addProxyLog(testScopeId, testPort, {
        timestamp: 1001,
        method: 'GET',
        url: '/third',
        status: 200,
        statusText: 'OK',
        duration: 10,
        requestSize: null,
        responseSize: 100,
        contentType: 'text/html',
        error: null
      });

      const logs = getProxyLogs(testScopeId, testPort);
      const afterCursor = getProxyLogsAfterCursor(testScopeId, testPort, {
        timestamp: logs[0].timestamp,
        id: logs[0].id
      });

      expect(afterCursor.map((log) => log.url)).toEqual(['/second', '/third']);
    });
  });

  describe('clearProxyLogs', () => {
    it('removes all logs for a port', () => {
      addProxyLog(testScopeId, testPort, {
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

      expect(getProxyLogs(testScopeId, testPort)).toHaveLength(1);
      clearProxyLogs(testScopeId, testPort);
      expect(getProxyLogs(testScopeId, testPort)).toHaveLength(0);
    });

    it('does not affect other ports', () => {
      addProxyLog(testScopeId, 8000, {
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

      addProxyLog(testScopeId, 8001, {
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

      clearProxyLogs(testScopeId, 8000);
      expect(getProxyLogs(testScopeId, 8000)).toHaveLength(0);
      expect(getProxyLogs(testScopeId, 8001)).toHaveLength(1);
    });
  });

  describe('getLatestLogTimestamp', () => {
    it('returns 0 for port with no logs', () => {
      expect(getLatestLogTimestamp(testScopeId, 12345)).toBe(0);
    });

    it('returns timestamp of most recent log', () => {
      addProxyLog(testScopeId, testPort, {
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

      addProxyLog(testScopeId, testPort, {
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

      expect(getLatestLogTimestamp(testScopeId, testPort)).toBe(3000);
    });
  });
});
