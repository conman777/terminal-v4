export type WebSocketConnectionStatus = 'connecting' | 'connected' | 'closing' | 'closed' | 'error';
export type WebSocketMessageDirection = 'sent' | 'received';
export type WebSocketMessageFormat = 'text' | 'binary';

export interface WebSocketConnection {
  id: string;
  port: number;
  url: string;
  status: WebSocketConnectionStatus;
  timestamp: number;
  protocols?: string[];
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

export interface WebSocketMessage {
  id: string;
  port: number;
  connectionId: string;
  timestamp: number;
  direction: WebSocketMessageDirection;
  format: WebSocketMessageFormat;
  size: number;
  data: string;
}

interface WebSocketPortStore {
  connections: WebSocketConnection[];
  messages: WebSocketMessage[];
  lastActivity: number;
}

interface WebSocketStoreQuery {
  connectionId?: string;
  direction?: WebSocketMessageDirection;
}

const storesByPort = new Map<number, WebSocketPortStore>();
const MAX_CONNECTIONS_PER_PORT = 200;
const MAX_MESSAGES_PER_PORT = 2000;
const MAX_MESSAGE_DATA_LENGTH = 2000;
const STALE_PORT_TIMEOUT_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let cleanupTimer: NodeJS.Timeout | null = null;
let idCounter = 0;

function generateId(): string {
  idCounter += 1;
  return `${Date.now()}-${idCounter}`;
}

function sanitizeMessageData(value: string): string {
  if (value.length <= MAX_MESSAGE_DATA_LENGTH) return value;
  return `${value.slice(0, MAX_MESSAGE_DATA_LENGTH)}... [truncated]`;
}

function getOrCreateStore(port: number): WebSocketPortStore {
  let store = storesByPort.get(port);
  if (!store) {
    store = {
      connections: [],
      messages: [],
      lastActivity: Date.now()
    };
    storesByPort.set(port, store);
  }
  return store;
}

function touchStore(port: number): WebSocketPortStore {
  const store = getOrCreateStore(port);
  store.lastActivity = Date.now();
  return store;
}

function trimConnections(store: WebSocketPortStore): void {
  if (store.connections.length <= MAX_CONNECTIONS_PER_PORT) return;
  const removed = store.connections.splice(0, store.connections.length - MAX_CONNECTIONS_PER_PORT);
  const removedIds = new Set(removed.map((item) => item.id));
  if (removedIds.size === 0) return;
  store.messages = store.messages.filter((message) => !removedIds.has(message.connectionId));
}

function trimMessages(store: WebSocketPortStore): void {
  if (store.messages.length <= MAX_MESSAGES_PER_PORT) return;
  store.messages.splice(0, store.messages.length - MAX_MESSAGES_PER_PORT);
}

export function logWebSocketConnection(
  port: number,
  payload: {
    id?: string;
    url: string;
    status: WebSocketConnectionStatus;
    timestamp?: number;
    protocols?: string[];
    closeCode?: number;
    closeReason?: string;
    error?: string;
  }
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return payload.id || '';
  }

  const store = touchStore(port);
  const now = Date.now();
  const id = payload.id || generateId();
  const existingIndex = store.connections.findIndex((entry) => entry.id === id);
  const merged: WebSocketConnection = {
    id,
    port,
    url: payload.url,
    status: payload.status,
    timestamp: payload.timestamp ?? now,
    protocols: payload.protocols,
    closeCode: payload.closeCode,
    closeReason: payload.closeReason,
    error: payload.error
  };

  if (existingIndex >= 0) {
    const prev = store.connections[existingIndex];
    store.connections[existingIndex] = {
      ...prev,
      ...merged,
      // Keep original timestamp for the same connection, update only when first seen.
      timestamp: prev.timestamp || merged.timestamp
    };
  } else {
    store.connections.push(merged);
  }

  trimConnections(store);
  return id;
}

export function logWebSocketMessage(
  port: number,
  payload: {
    connectionId: string;
    direction: WebSocketMessageDirection;
    format: WebSocketMessageFormat;
    data: string;
    size?: number;
    timestamp?: number;
  }
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  if (!payload.connectionId) return '';
  const store = touchStore(port);
  const data = sanitizeMessageData(payload.data || '');
  const entry: WebSocketMessage = {
    id: generateId(),
    port,
    connectionId: payload.connectionId,
    timestamp: payload.timestamp ?? Date.now(),
    direction: payload.direction,
    format: payload.format,
    size: payload.size ?? data.length,
    data
  };
  store.messages.push(entry);
  trimMessages(store);
  return entry.id;
}

export function getWebSocketLogs(port: number, query: WebSocketStoreQuery = {}): {
  connections: WebSocketConnection[];
  messages: WebSocketMessage[];
} {
  const store = storesByPort.get(port);
  if (!store) {
    return { connections: [], messages: [] };
  }

  const connections = [...store.connections];
  let messages = [...store.messages];
  if (query.connectionId) {
    messages = messages.filter((message) => message.connectionId === query.connectionId);
  }
  if (query.direction) {
    messages = messages.filter((message) => message.direction === query.direction);
  }

  return {
    connections,
    messages
  };
}

export function clearWebSocketLogs(port: number): boolean {
  return storesByPort.delete(port);
}

export function listWebSocketPorts(): number[] {
  return Array.from(storesByPort.keys()).sort((a, b) => a - b);
}

function cleanupStaleStores(): void {
  const now = Date.now();
  for (const [port, store] of storesByPort.entries()) {
    if (now - store.lastActivity > STALE_PORT_TIMEOUT_MS) {
      storesByPort.delete(port);
    }
  }
}

export function startWebSocketStoreCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupStaleStores, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

export function stopWebSocketStoreCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

startWebSocketStoreCleanup();
