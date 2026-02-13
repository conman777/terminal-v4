import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import { __previewApiRoutesTestUtils, registerPreviewApiRoutes } from './preview-api-routes';
import { clearCookies, hasCookies, storeCookies } from '../preview/cookie-store';
import { clearPerformanceMetrics } from '../preview/performance-store';
import {
  clearWebSocketLogs,
  logWebSocketConnection,
  logWebSocketMessage
} from '../preview/websocket-interceptor';

async function createTestApp(authenticated: boolean) {
  const app = Fastify();
  await app.register(websocket);
  if (authenticated) {
    app.addHook('onRequest', async (request) => {
      (request as { userId?: string }).userId = 'test-user';
    });
  }
  await registerPreviewApiRoutes(app);
  await app.ready();
  return app;
}

describe('preview-api-routes Windows helpers', () => {
  it('parses Get-NetTCPConnection JSON output', () => {
    const entries = __previewApiRoutesTestUtils.parseWindowsPowerShellListeningEntries(
      JSON.stringify([
        { LocalPort: 5173, OwningProcess: 1234, ProcessName: 'node.exe' },
        { LocalPort: 3020, OwningProcess: 9000, ProcessName: 'terminal.exe' }
      ])
    );

    expect(entries).toEqual([
      { port: 5173, pid: 1234, process: 'node' }
    ]);
  });

  it('parses netstat LISTENING lines and de-duplicates repeated ports', () => {
    const output = [
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1001',
      '  TCP    [::]:5173              [::]:0                 LISTENING       1001',
      '  TCP    127.0.0.1:3020         0.0.0.0:0              LISTENING       2002'
    ].join('\n');
    const entries = __previewApiRoutesTestUtils.parseWindowsNetstatListeningEntries(output);

    expect(entries).toEqual([
      { port: 5173, pid: 1001, process: '' }
    ]);
  });

  it('parses tasklist CSV output into a PID->process map', () => {
    const output = [
      '"node.exe","1234","Console","1","45,000 K"',
      '"Code.exe","4321","Console","1","120,000 K"'
    ].join('\n');
    const processMap = __previewApiRoutesTestUtils.parseWindowsTasklistProcessMap(output);

    expect(processMap.get(1234)).toBe('node');
    expect(processMap.get(4321)).toBe('Code');
  });
});

describe('preview-api-routes Linux helpers', () => {
  it('parses ss LISTEN output', () => {
    const output = [
      'LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*    users:(("node",pid=8123,fd=19))',
      'LISTEN 0      128             [::]:3020         [::]:*    users:(("terminal",pid=9001,fd=21))'
    ].join('\n');
    const entries = __previewApiRoutesTestUtils.parseLinuxSsListeningEntries(output);

    expect(entries).toEqual([
      { port: 5173, pid: 8123, process: 'node' }
    ]);
  });

  it('parses netstat LISTEN output', () => {
    const output = [
      'tcp        0      0 0.0.0.0:5173            0.0.0.0:*               LISTEN      8123/node',
      'tcp6       0      0 :::3020                 :::*                    LISTEN      9001/terminal'
    ].join('\n');
    const entries = __previewApiRoutesTestUtils.parseLinuxNetstatListeningEntries(output);

    expect(entries).toEqual([
      { port: 5173, pid: 8123, process: 'node' }
    ]);
  });
});

describe('preview-api-routes active-ports endpoint', () => {
  let app: Awaited<ReturnType<typeof createTestApp>> | null = null;
  const TEST_PORT = 55173;

  afterEach(async () => {
    clearCookies(TEST_PORT);
    clearPerformanceMetrics(TEST_PORT);
    clearWebSocketLogs(TEST_PORT);
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('returns 401 when unauthenticated', async () => {
    app = await createTestApp(false);
    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/active-ports'
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns the active ports contract when authenticated', async () => {
    app = await createTestApp(true);
    const response = await app.inject({
      method: 'GET',
      url: '/api/preview/active-ports'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { ports?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.ports)).toBe(true);
    if (body.ports && body.ports.length > 0) {
      const first = body.ports[0];
      expect(typeof first.port).toBe('number');
      expect(typeof first.listening).toBe('boolean');
      expect(typeof first.previewed).toBe('boolean');
    }
  });

  it('returns 401 when clearing all cookies unauthenticated', async () => {
    app = await createTestApp(false);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/preview/cookies'
    });
    expect(response.statusCode).toBe(401);
  });

  it('clears all stored preview cookies when authenticated', async () => {
    storeCookies(TEST_PORT, ['session_id=abc123; Path=/; SameSite=Lax']);
    expect(hasCookies(TEST_PORT)).toBe(true);

    app = await createTestApp(true);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/preview/cookies'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success?: boolean; clearedPorts?: number };
    expect(body.success).toBe(true);
    expect(typeof body.clearedPorts).toBe('number');
    expect(body.clearedPorts).toBeGreaterThanOrEqual(1);
    expect(hasCookies(TEST_PORT)).toBe(false);
  });

  it('accepts performance metrics ingestion without auth', async () => {
    app = await createTestApp(false);
    const response = await app.inject({
      method: 'POST',
      url: `/api/preview/${TEST_PORT}/performance`,
      payload: {
        metrics: [
          {
            type: 'runtimeMetrics',
            timestamp: Date.now(),
            data: { fps: 60, memory: null, longTasks: [] }
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { success?: boolean; accepted?: number; rejected?: number };
    expect(body.success).toBe(true);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
  });

  it('requires auth to read performance metrics', async () => {
    app = await createTestApp(false);
    const response = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/performance`
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns and clears performance metrics when authenticated', async () => {
    app = await createTestApp(true);
    await app.inject({
      method: 'POST',
      url: `/api/preview/${TEST_PORT}/performance`,
      payload: {
        metrics: [
          {
            type: 'coreWebVitals',
            timestamp: Date.now(),
            data: { lcp: 1234, fid: null, cls: null }
          }
        ]
      }
    });

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/performance`
    });
    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json() as {
      metrics?: { coreWebVitals?: Array<Record<string, unknown>> };
    };
    expect(Array.isArray(getBody.metrics?.coreWebVitals)).toBe(true);
    expect((getBody.metrics?.coreWebVitals || []).length).toBeGreaterThanOrEqual(1);

    const clearResponse = await app.inject({
      method: 'DELETE',
      url: `/api/preview/${TEST_PORT}/performance`
    });
    expect(clearResponse.statusCode).toBe(200);

    const clearedResponse = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/performance`
    });
    const clearedBody = clearedResponse.json() as {
      metrics?: {
        coreWebVitals?: unknown[];
        loadMetrics?: unknown[];
        runtimeMetrics?: unknown[];
      };
    };
    expect(clearedBody.metrics?.coreWebVitals || []).toHaveLength(0);
    expect(clearedBody.metrics?.loadMetrics || []).toHaveLength(0);
    expect(clearedBody.metrics?.runtimeMetrics || []).toHaveLength(0);
  });

  it('requires auth to read websocket logs', async () => {
    app = await createTestApp(false);
    const response = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/websockets`
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns websocket connections/messages and supports filtering', async () => {
    const connectionId = logWebSocketConnection(TEST_PORT, {
      url: '/socket',
      status: 'connected',
      protocols: ['json']
    });
    logWebSocketMessage(TEST_PORT, {
      connectionId,
      direction: 'sent',
      format: 'text',
      data: 'ping'
    });
    logWebSocketMessage(TEST_PORT, {
      connectionId,
      direction: 'received',
      format: 'text',
      data: 'pong'
    });

    app = await createTestApp(true);
    const response = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/websockets`
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      connections?: Array<Record<string, unknown>>;
      messages?: Array<Record<string, unknown>>;
    };
    expect(body.connections?.length || 0).toBeGreaterThanOrEqual(1);
    expect(body.messages?.length || 0).toBeGreaterThanOrEqual(2);

    const filteredResponse = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/websockets?connectionId=${encodeURIComponent(connectionId)}&direction=sent`
    });
    expect(filteredResponse.statusCode).toBe(200);
    const filteredBody = filteredResponse.json() as { messages?: Array<{ direction?: string }> };
    expect(filteredBody.messages || []).toHaveLength(1);
    expect(filteredBody.messages?.[0]?.direction).toBe('sent');
  });

  it('clears websocket logs when authenticated', async () => {
    const connectionId = logWebSocketConnection(TEST_PORT, {
      url: '/socket',
      status: 'connected'
    });
    logWebSocketMessage(TEST_PORT, {
      connectionId,
      direction: 'sent',
      format: 'text',
      data: 'hello'
    });

    app = await createTestApp(true);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/preview/${TEST_PORT}/websockets`
    });
    expect(response.statusCode).toBe(200);

    const afterClear = await app.inject({
      method: 'GET',
      url: `/api/preview/${TEST_PORT}/websockets`
    });
    const body = afterClear.json() as { connections?: unknown[]; messages?: unknown[] };
    expect(body.connections || []).toHaveLength(0);
    expect(body.messages || []).toHaveLength(0);
  });
});
