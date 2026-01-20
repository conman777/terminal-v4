/**
 * WebSocket Interceptor
 *
 * Tracks WebSocket connections and messages for debugging purposes.
 * Stores connection states, message logs with direction filtering.
 */

export type WebSocketStatus = 'connecting' | 'connected' | 'closing' | 'closed' | 'error';
export type MessageDirection = 'sent' | 'received';
export type MessageFormat = 'text' | 'binary';

export interface WebSocketConnection {
  id: string;
  url: string;
  protocols: string[];
  timestamp: number;
  status: WebSocketStatus;
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

export interface WebSocketMessage {
  id?: string;
  connectionId: string;
  direction: MessageDirection;
  timestamp: number;
  data: string;
  size: number;
  format: MessageFormat;
}

interface WebSocketLogs {
  connections: WebSocketConnection[];
  messages: WebSocketMessage[];
}

// Storage: Map<port, WebSocketLogs>
const logsStore = new Map<number, WebSocketLogs>();

// Limits
const MAX_CONNECTIONS = 50;
const MAX_MESSAGES = 1000;

// ID generator
let connectionCounter = 0;
let messageCounter = 0;

function generateConnectionId(): string {
  return `ws-conn-${Date.now()}-${connectionCounter++}`;
}

function generateMessageId(): string {
  return `ws-msg-${Date.now()}-${messageCounter++}`;
}

/**
 * Initialize empty logs for a port
 */
function initializeLogs(port: number): WebSocketLogs {
  const logs: WebSocketLogs = {
    connections: [],
    messages: []
  };
  logsStore.set(port, logs);
  return logs;
}

/**
 * Get logs for a port
 */
function getLogsForPort(port: number): WebSocketLogs {
  let logs = logsStore.get(port);
  if (!logs) {
    logs = initializeLogs(port);
  }
  return logs;
}

/**
 * Trim array to max size
 */
function trimArray<T>(array: T[], maxSize: number): void {
  if (array.length > maxSize) {
    array.splice(0, array.length - maxSize);
  }
}

/**
 * Log or update a WebSocket connection
 * If connection has an id, updates existing; otherwise creates new
 */
export function logWebSocketConnection(
  port: number,
  connection: Omit<WebSocketConnection, 'id'> & { id?: string }
): string {
  const logs = getLogsForPort(port);

  // If updating existing connection
  if (connection.id) {
    const existing = logs.connections.find(c => c.id === connection.id);
    if (existing) {
      existing.status = connection.status;
      existing.timestamp = connection.timestamp;
      if (connection.closeCode !== undefined) existing.closeCode = connection.closeCode;
      if (connection.closeReason !== undefined) existing.closeReason = connection.closeReason;
      if (connection.error !== undefined) existing.error = connection.error;
      return connection.id;
    }
  }

  // Create new connection
  const id = generateConnectionId();
  const newConnection: WebSocketConnection = {
    id,
    url: connection.url,
    protocols: connection.protocols,
    timestamp: connection.timestamp,
    status: connection.status,
    closeCode: connection.closeCode,
    closeReason: connection.closeReason,
    error: connection.error
  };

  logs.connections.push(newConnection);
  trimArray(logs.connections, MAX_CONNECTIONS);

  return id;
}

/**
 * Log a WebSocket message
 */
export function logWebSocketMessage(
  port: number,
  message: Omit<WebSocketMessage, 'id'>
): string {
  const logs = getLogsForPort(port);

  const id = generateMessageId();
  const newMessage: WebSocketMessage = {
    id,
    connectionId: message.connectionId,
    direction: message.direction,
    timestamp: message.timestamp,
    data: message.data,
    size: message.size,
    format: message.format
  };

  logs.messages.push(newMessage);
  trimArray(logs.messages, MAX_MESSAGES);

  return id;
}

/**
 * Get WebSocket connections for a port
 */
export function getWebSocketConnections(port: number): WebSocketConnection[] {
  const logs = logsStore.get(port);
  if (!logs) return [];
  return [...logs.connections];
}

/**
 * Get WebSocket messages for a port
 * Optionally filter by connection ID and/or direction
 */
export function getWebSocketMessages(
  port: number,
  connectionId?: string,
  direction?: MessageDirection
): WebSocketMessage[] {
  const logs = logsStore.get(port);
  if (!logs) return [];

  let messages = [...logs.messages];

  if (connectionId !== undefined) {
    messages = messages.filter(m => m.connectionId === connectionId);
  }

  if (direction !== undefined) {
    messages = messages.filter(m => m.direction === direction);
  }

  return messages;
}

/**
 * Clear all WebSocket logs for a port
 */
export function clearWebSocketLogs(port: number): void {
  logsStore.delete(port);
}

/**
 * Get latest message timestamp for a port (for streaming updates)
 */
export function getLatestMessageTimestamp(port: number): number {
  const logs = logsStore.get(port);
  if (!logs || logs.messages.length === 0) return 0;
  return logs.messages[logs.messages.length - 1].timestamp;
}
