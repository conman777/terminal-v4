import { describe, it, expect, beforeEach } from 'vitest';
import {
  logWebSocketConnection,
  logWebSocketMessage,
  getWebSocketConnections,
  getWebSocketMessages,
  clearWebSocketLogs,
  type WebSocketConnection,
  type WebSocketMessage
} from './websocket-interceptor';

describe('websocket-interceptor', () => {
  const testPort = 9999;

  beforeEach(() => {
    clearWebSocketLogs(testPort);
  });

  describe('Connection Tracking', () => {
    it('logs new WebSocket connections', () => {
      const connectionId = logWebSocketConnection(testPort, {
        url: 'ws://localhost:9999/api/updates',
        protocols: ['v1'],
        timestamp: Date.now(),
        status: 'connecting'
      });

      const connections = getWebSocketConnections(testPort);
      expect(connections).toHaveLength(1);
      expect(connections[0].id).toBe(connectionId);
      expect(connections[0].url).toBe('ws://localhost:9999/api/updates');
      expect(connections[0].status).toBe('connecting');
    });

    it('updates connection status', () => {
      const connectionId = logWebSocketConnection(testPort, {
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'connecting'
      });

      logWebSocketConnection(testPort, {
        id: connectionId,
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'connected'
      });

      const connections = getWebSocketConnections(testPort);
      expect(connections).toHaveLength(1);
      expect(connections[0].status).toBe('connected');
    });

    it('tracks closed connections', () => {
      const connectionId = logWebSocketConnection(testPort, {
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'connecting'
      });

      logWebSocketConnection(testPort, {
        id: connectionId,
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'closed',
        closeCode: 1000,
        closeReason: 'Normal closure'
      });

      const connections = getWebSocketConnections(testPort);
      expect(connections[0].status).toBe('closed');
      expect(connections[0].closeCode).toBe(1000);
      expect(connections[0].closeReason).toBe('Normal closure');
    });

    it('tracks error state', () => {
      const connectionId = logWebSocketConnection(testPort, {
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'connecting'
      });

      logWebSocketConnection(testPort, {
        id: connectionId,
        url: 'ws://localhost:9999/api/updates',
        protocols: [],
        timestamp: Date.now(),
        status: 'error',
        error: 'Connection refused'
      });

      const connections = getWebSocketConnections(testPort);
      expect(connections[0].status).toBe('error');
      expect(connections[0].error).toBe('Connection refused');
    });
  });

  describe('Message Tracking', () => {
    it('logs sent messages', () => {
      const connectionId = 'conn-1';
      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'sent',
        timestamp: Date.now(),
        data: '{"type":"ping"}',
        size: 15,
        format: 'text'
      });

      const messages = getWebSocketMessages(testPort);
      expect(messages).toHaveLength(1);
      expect(messages[0].direction).toBe('sent');
      expect(messages[0].data).toBe('{"type":"ping"}');
      expect(messages[0].format).toBe('text');
    });

    it('logs received messages', () => {
      const connectionId = 'conn-1';
      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'received',
        timestamp: Date.now(),
        data: '{"type":"pong"}',
        size: 15,
        format: 'text'
      });

      const messages = getWebSocketMessages(testPort);
      expect(messages).toHaveLength(1);
      expect(messages[0].direction).toBe('received');
      expect(messages[0].data).toBe('{"type":"pong"}');
    });

    it('logs binary messages', () => {
      const connectionId = 'conn-1';
      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'received',
        timestamp: Date.now(),
        data: '<Buffer 01 02 03>',
        size: 3,
        format: 'binary'
      });

      const messages = getWebSocketMessages(testPort);
      expect(messages[0].format).toBe('binary');
      expect(messages[0].size).toBe(3);
    });

    it('maintains message order', () => {
      const connectionId = 'conn-1';
      const now = Date.now();

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'sent',
        timestamp: now,
        data: 'msg1',
        size: 4,
        format: 'text'
      });

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'received',
        timestamp: now + 100,
        data: 'msg2',
        size: 4,
        format: 'text'
      });

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'sent',
        timestamp: now + 200,
        data: 'msg3',
        size: 4,
        format: 'text'
      });

      const messages = getWebSocketMessages(testPort);
      expect(messages).toHaveLength(3);
      expect(messages[0].data).toBe('msg1');
      expect(messages[1].data).toBe('msg2');
      expect(messages[2].data).toBe('msg3');
    });

    it('filters messages by connection ID', () => {
      logWebSocketMessage(testPort, {
        connectionId: 'conn-1',
        direction: 'sent',
        timestamp: Date.now(),
        data: 'from-conn-1',
        size: 11,
        format: 'text'
      });

      logWebSocketMessage(testPort, {
        connectionId: 'conn-2',
        direction: 'sent',
        timestamp: Date.now(),
        data: 'from-conn-2',
        size: 11,
        format: 'text'
      });

      const allMessages = getWebSocketMessages(testPort);
      expect(allMessages).toHaveLength(2);

      const conn1Messages = getWebSocketMessages(testPort, 'conn-1');
      expect(conn1Messages).toHaveLength(1);
      expect(conn1Messages[0].data).toBe('from-conn-1');

      const conn2Messages = getWebSocketMessages(testPort, 'conn-2');
      expect(conn2Messages).toHaveLength(1);
      expect(conn2Messages[0].data).toBe('from-conn-2');
    });

    it('filters messages by direction', () => {
      const connectionId = 'conn-1';

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'sent',
        timestamp: Date.now(),
        data: 'sent-1',
        size: 6,
        format: 'text'
      });

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'received',
        timestamp: Date.now(),
        data: 'received-1',
        size: 10,
        format: 'text'
      });

      logWebSocketMessage(testPort, {
        connectionId,
        direction: 'sent',
        timestamp: Date.now(),
        data: 'sent-2',
        size: 6,
        format: 'text'
      });

      const sentMessages = getWebSocketMessages(testPort, undefined, 'sent');
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[0].data).toBe('sent-1');
      expect(sentMessages[1].data).toBe('sent-2');

      const receivedMessages = getWebSocketMessages(testPort, undefined, 'received');
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].data).toBe('received-1');
    });
  });

  describe('Storage Limits', () => {
    it('limits connections to MAX_CONNECTIONS (50)', () => {
      // Add 60 connections
      for (let i = 0; i < 60; i++) {
        logWebSocketConnection(testPort, {
          url: `ws://localhost:9999/api/conn-${i}`,
          protocols: [],
          timestamp: Date.now() + i,
          status: 'connected'
        });
      }

      const connections = getWebSocketConnections(testPort);
      expect(connections).toHaveLength(50);
      // Should keep the most recent 50
      expect(connections[0].url).toBe('ws://localhost:9999/api/conn-10');
      expect(connections[49].url).toBe('ws://localhost:9999/api/conn-59');
    });

    it('limits messages to MAX_MESSAGES (1000)', () => {
      const connectionId = 'conn-1';

      // Add 1100 messages
      for (let i = 0; i < 1100; i++) {
        logWebSocketMessage(testPort, {
          connectionId,
          direction: 'sent',
          timestamp: Date.now() + i,
          data: `message-${i}`,
          size: 10,
          format: 'text'
        });
      }

      const messages = getWebSocketMessages(testPort);
      expect(messages).toHaveLength(1000);
      // Should keep the most recent 1000
      expect(messages[0].data).toBe('message-100');
      expect(messages[999].data).toBe('message-1099');
    });
  });

  describe('Port Isolation', () => {
    it('stores connections separately by port', () => {
      logWebSocketConnection(8000, {
        url: 'ws://localhost:8000/api',
        protocols: [],
        timestamp: Date.now(),
        status: 'connected'
      });

      logWebSocketConnection(8001, {
        url: 'ws://localhost:8001/api',
        protocols: [],
        timestamp: Date.now(),
        status: 'connected'
      });

      expect(getWebSocketConnections(8000)).toHaveLength(1);
      expect(getWebSocketConnections(8001)).toHaveLength(1);
      expect(getWebSocketConnections(8000)[0].url).toBe('ws://localhost:8000/api');
      expect(getWebSocketConnections(8001)[0].url).toBe('ws://localhost:8001/api');

      clearWebSocketLogs(8000);
      clearWebSocketLogs(8001);
    });

    it('stores messages separately by port', () => {
      logWebSocketMessage(8000, {
        connectionId: 'conn-1',
        direction: 'sent',
        timestamp: Date.now(),
        data: 'port-8000',
        size: 9,
        format: 'text'
      });

      logWebSocketMessage(8001, {
        connectionId: 'conn-1',
        direction: 'sent',
        timestamp: Date.now(),
        data: 'port-8001',
        size: 9,
        format: 'text'
      });

      expect(getWebSocketMessages(8000)).toHaveLength(1);
      expect(getWebSocketMessages(8001)).toHaveLength(1);
      expect(getWebSocketMessages(8000)[0].data).toBe('port-8000');
      expect(getWebSocketMessages(8001)[0].data).toBe('port-8001');

      clearWebSocketLogs(8000);
      clearWebSocketLogs(8001);
    });
  });

  describe('clearWebSocketLogs', () => {
    it('clears both connections and messages', () => {
      logWebSocketConnection(testPort, {
        url: 'ws://localhost:9999/api',
        protocols: [],
        timestamp: Date.now(),
        status: 'connected'
      });

      logWebSocketMessage(testPort, {
        connectionId: 'conn-1',
        direction: 'sent',
        timestamp: Date.now(),
        data: 'test',
        size: 4,
        format: 'text'
      });

      expect(getWebSocketConnections(testPort)).toHaveLength(1);
      expect(getWebSocketMessages(testPort)).toHaveLength(1);

      clearWebSocketLogs(testPort);

      expect(getWebSocketConnections(testPort)).toEqual([]);
      expect(getWebSocketMessages(testPort)).toEqual([]);
    });
  });
});
