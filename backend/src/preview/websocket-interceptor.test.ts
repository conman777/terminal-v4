import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearWebSocketLogs,
  getWebSocketLogs,
  logWebSocketConnection,
  logWebSocketMessage
} from './websocket-interceptor';

describe('websocket-interceptor store', () => {
  const TEST_PORT = 55173;

  beforeEach(() => {
    clearWebSocketLogs(TEST_PORT);
  });

  it('tracks connection lifecycle and messages', () => {
    const connectionId = logWebSocketConnection(TEST_PORT, {
      url: '/socket',
      status: 'connecting',
      protocols: ['json']
    });

    logWebSocketConnection(TEST_PORT, {
      id: connectionId,
      url: '/socket',
      status: 'connected'
    });

    logWebSocketMessage(TEST_PORT, {
      connectionId,
      direction: 'sent',
      format: 'text',
      data: 'ping'
    });

    const { connections, messages } = getWebSocketLogs(TEST_PORT);
    expect(connections).toHaveLength(1);
    expect(connections[0].status).toBe('connected');
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('sent');
  });

  it('filters messages by connection id and direction', () => {
    const a = logWebSocketConnection(TEST_PORT, { url: '/a', status: 'connected' });
    const b = logWebSocketConnection(TEST_PORT, { url: '/b', status: 'connected' });

    logWebSocketMessage(TEST_PORT, { connectionId: a, direction: 'sent', format: 'text', data: 'a-sent' });
    logWebSocketMessage(TEST_PORT, { connectionId: a, direction: 'received', format: 'text', data: 'a-received' });
    logWebSocketMessage(TEST_PORT, { connectionId: b, direction: 'sent', format: 'text', data: 'b-sent' });

    const filteredByConnection = getWebSocketLogs(TEST_PORT, { connectionId: a });
    expect(filteredByConnection.messages).toHaveLength(2);

    const filteredByDirection = getWebSocketLogs(TEST_PORT, { direction: 'received' });
    expect(filteredByDirection.messages).toHaveLength(1);
    expect(filteredByDirection.messages[0].data).toContain('a-received');
  });

  it('clears logs for a port', () => {
    const connectionId = logWebSocketConnection(TEST_PORT, { url: '/socket', status: 'connected' });
    logWebSocketMessage(TEST_PORT, { connectionId, direction: 'sent', format: 'text', data: 'hello' });

    expect(getWebSocketLogs(TEST_PORT).messages).toHaveLength(1);
    clearWebSocketLogs(TEST_PORT);
    expect(getWebSocketLogs(TEST_PORT).messages).toHaveLength(0);
  });
});
