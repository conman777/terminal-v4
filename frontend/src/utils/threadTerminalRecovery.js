import { createUuid } from './createUuid';
import { getEnvironmentCacheScope } from './remoteEnvironments';

const EVENT = 'thread-terminal-recovery-change';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function threadTerminalRecoveryKey(auth, threadId) {
  const environment = getEnvironmentCacheScope();
  return `threadTerminalRecovery:v1:${encodeURIComponent(auth.home)}:${encodeURIComponent(auth.userId || '')}:${encodeURIComponent(environment.environment)}:${encodeURIComponent(threadId || '')}`;
}

export function readThreadTerminalRecovery(key, threadId) {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return { raw, record: null };
  if (raw.length > 8192) throw new Error('Saved terminal recovery is invalid. Review this tab’s saved data before opening a terminal.');
  const record = JSON.parse(raw);
  if (record?.version !== 1 || record.threadId !== threadId || typeof record.cwd !== 'string' || !record.cwd || record.cwd.length > 4096
    || !ID.test(record.operationId) || !['creating', 'created'].includes(record.phase)
    || (record.nonce !== undefined && (typeof record.nonce !== 'string' || record.nonce.length > 64))
    || (record.phase === 'created' && (typeof record.terminalId !== 'string' || !record.terminalId || record.terminalId.length > 200
      || typeof record.terminalCwd !== 'string' || !record.terminalCwd || record.terminalCwd.length > 4096))) {
    throw new Error('Saved terminal recovery is invalid. Review this tab’s saved data before opening a terminal.');
  }
  return { raw, record };
}

export function writeThreadTerminalRecovery(key, expectedRaw, record) {
  if (sessionStorage.getItem(key) !== expectedRaw) throw new Error('Terminal recovery changed. Review it before continuing.');
  const raw = JSON.stringify(record);
  sessionStorage.setItem(key, raw);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
  return raw;
}

export function clearThreadTerminalRecovery(key, expectedRaw) {
  if (sessionStorage.getItem(key) !== expectedRaw) throw new Error('Terminal recovery changed. Review it before continuing.');
  sessionStorage.removeItem(key);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

// The nonce makes every attempt's saved record unique, so a late response from an earlier attempt
// can never pass the compare-and-swap check of a newer attempt that shares the same operation id.
export function newThreadTerminalRecovery(threadId, cwd, operationId = createUuid()) {
  return { version: 1, threadId, cwd, operationId, nonce: createUuid(), phase: 'creating' };
}

// Every tab opening the same empty thread derives the same id, so the server can answer a second
// tab's first-terminal request with the terminal the first tab already created.
export function sharedThreadTerminalOperationId(auth, threadId) {
  const input = `thread-terminal:${auth.home}:${auth.userId || ''}:${threadId}`;
  const words = [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344];
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    for (let lane = 0; lane < 4; lane += 1) {
      words[lane] = Math.imul(words[lane] ^ code, 2654435761 + lane * 2) >>> 0;
      words[lane] = (words[lane] << 13 | words[lane] >>> 19) >>> 0;
    }
  }
  const hex = words.map(word => word.toString(16).padStart(8, '0')).join('');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function subscribeThreadTerminalRecovery(key, onChange) {
  const listener = event => { if (event.detail === key) onChange(); };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
