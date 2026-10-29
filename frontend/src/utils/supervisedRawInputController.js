import { apiFetch } from './api';
import { captureAuthScope, isAuthScopeCurrent } from './auth';
import { getActiveEnvironment, getEnvironmentCacheScope, getEnvironmentSignal } from './remoteEnvironments';
import { createSupervisedRawInputApi, supervisedInputAvailability, supervisedInputWatermark, supervisedSessionInputCapability } from './supervisedRawInputApi';
import { createSupervisedRawInputStore } from './supervisedRawInputStore';
import { sendSupervisedRawInput } from './supervisedRawInput';
import { supervisedInputTransaction } from './supervisedInputTransaction';

export const SUPERVISED_INPUT_CHANGED = 'supervised-raw-input-changed';
export const SUPERVISED_CAPABILITY_CHANGED = 'supervised-raw-input-capability-changed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localLocks = new Map();
const compactionAttempts = new WeakMap();

function inTabLock(key, callback) {
  const previous = localLocks.get(key) || Promise.resolve();
  const work = previous.catch(() => {}).then(callback);
  const tail = work.then(() => {}, () => {});
  localLocks.set(key, tail);
  tail.then(() => { if (localLocks.get(key) === tail) localLocks.delete(key); });
  return work;
}

export function supervisedInputScope(sessionId) {
  const auth = captureAuthScope(), signal = getEnvironmentSignal(), environment = getActiveEnvironment();
  const cache = getEnvironmentCacheScope();
  const expectedIdentity = auth.userId ? `identity:${encodeURIComponent(new URL(auth.home).origin)}:${encodeURIComponent(auth.userId)}:` : '';
  if (!auth.userId || cache.identity !== expectedIdentity) throw new Error('Input recovery scope is unavailable. No input was sent.');
  const prefix = `${cache.identity}${environment ? `environment:${environment.id}:` : ''}`;
  const storage = {
    getItem: key => localStorage.getItem(prefix + key),
    setItem: (key, value) => localStorage.setItem(prefix + key, value),
    removeItem: key => localStorage.removeItem(prefix + key),
    transaction: supervisedInputTransaction,
    listKeys: keyPrefix => {
      const keys = [];
      for (const key of Object.keys(localStorage)) {
        if (key?.startsWith(prefix + keyPrefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    },
  };
  const isCurrent = () => !signal.aborted && isAuthScopeCurrent(auth) && captureAuthScope().userId === auth.userId;
  const withLock = callback => {
    const key = `supervised-raw-input:${JSON.stringify([auth.home, auth.userId, environment?.id || null, sessionId])}`;
    if (navigator.locks?.request) return navigator.locks.request(key, { mode: 'exclusive' }, callback);
    return inTabLock(key, callback);
  };
  const store = createSupervisedRawInputStore(storage, sessionId, isCurrent);
  return { auth, signal, environment, cache, storage, isCurrent, withLock, store, api: createSupervisedRawInputApi(apiFetch, sessionId, signal) };
}

export async function listUnsettledSupervisedInputs(signal) {
  const receipts = [];
  let cursor = null;
  for (let page = 0; page < 100; page += 1) {
    const url = '/api/structured/input-receipts' + (cursor === null ? '' : `?after=${cursor}`);
    const response = await apiFetch(url, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Input recovery could not be checked.');
    const value = await response.json();
    if (!Array.isArray(value?.receipts) || value.receipts.length > 128 || receipts.length + value.receipts.length > 10_000 || value.receipts.some(item =>
      !item || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 256 || !UUID.test(item.requestId || '')
      || !['issued', 'uncertain', 'delivered'].includes(item.status)) || !Object.prototype.hasOwnProperty.call(value, 'nextCursor')
      || (value.nextCursor !== null && (!Number.isSafeInteger(value.nextCursor) || value.nextCursor < 0 || (cursor !== null && value.nextCursor <= cursor)))) {
      throw new Error('Input recovery response is invalid.');
    }
    receipts.push(...value.receipts);
    if (value.nextCursor === null) return receipts;
    cursor = value.nextCursor;
  }
  throw new Error('Input recovery response is invalid.');
}

export async function sendRawInput(sessionId, text, legacySend, { requireSupervision = false, requireLegacy = false } = {}) {
  const scope = supervisedInputScope(sessionId);
  const count = scope.store.count();
  if (count >= 512) {
    let attempts = compactionAttempts.get(scope.signal);
    if (!attempts) { attempts = new Map(); compactionAttempts.set(scope.signal, attempts); }
    const last = attempts.get(sessionId);
    if (count >= 10_000 || last === undefined || performance.now() - last >= 30_000) {
      attempts.set(sessionId, performance.now());
      try {
        const watermark = await supervisedInputWatermark(apiFetch, scope.signal);
        if (!scope.isCurrent()) throw new Error('The account or environment changed.');
        await scope.store.compactBefore(watermark);
      } catch (error) {
        if (count >= 10_000) throw new Error('Saved input recovery could not be compacted. No input was sent.');
      }
    }
    if (scope.store.count() >= 10_000) throw new Error('Too many saved input operations. No input was sent.');
  }
  const existing = scope.store.read();
  if (existing) {
    window.dispatchEvent(new Event(SUPERVISED_INPUT_CHANGED));
    throw new Error('A previous input needs review. Check the terminal before sending more.');
  }
  if (scope.environment) {
    if (requireSupervision) throw new Error('This server no longer supports supervised input. No input was sent.');
    return legacySend(sessionId, text);
  }
  const availability = await supervisedInputAvailability(apiFetch, scope.signal);
  if (!scope.isCurrent()) throw new Error('The account or environment changed. No input was sent.');
  if (availability === 'legacy') {
    if (requireSupervision) throw new Error('This server no longer supports supervised input. No input was sent.');
    return legacySend(sessionId, text);
  }
  const sessionSupported = availability === 'supervised' && await supervisedSessionInputCapability(apiFetch, scope.signal, sessionId);
  if (!scope.isCurrent()) throw new Error('The account or environment changed. No input was sent.');
  if (!sessionSupported) {
    if (requireSupervision) throw new Error('This server no longer supports supervised input. No input was sent.');
    return scope.withLock(async () => {
      if (!scope.isCurrent()) throw new Error('The account or environment changed. No input was sent.');
      const pending = await listUnsettledSupervisedInputs(scope.signal);
      if (!scope.isCurrent()) throw new Error('The account or environment changed. No input was sent.');
      if (scope.store.read() || pending.some(item => item.sessionId === sessionId)) {
        window.dispatchEvent(new Event(SUPERVISED_INPUT_CHANGED));
        throw new Error('A previous input needs review. Check the terminal before sending more.');
      }
      return legacySend(sessionId, text);
    });
  }
  if (requireLegacy) {
    window.dispatchEvent(new Event(SUPERVISED_CAPABILITY_CHANGED));
    throw new Error('The server input mode changed. No input was sent; try again.');
  }
  try {
    const result = await sendSupervisedRawInput({ sessionId, text, ...scope, withLock: callback => scope.withLock(async () => {
      if (!scope.isCurrent()) throw new Error('The account or environment changed. No input was sent.');
      const pending = await listUnsettledSupervisedInputs(scope.signal);
      if (pending.some(item => item.sessionId === sessionId)) throw new Error('A previous input needs review. Check the terminal before sending more.');
      return callback();
    }) });
    if (result.status !== 'delivered') {
      const error = new Error('Input delivery could not be confirmed. Check the terminal and review the pending input before continuing.');
      error.deliveryUncertain = result.status === 'uncertain';
      throw error;
    }
    return { accepted: true, requestId: result.requestId };
  } finally {
    if (scope.isCurrent()) window.dispatchEvent(new Event(SUPERVISED_INPUT_CHANGED));
  }
}
