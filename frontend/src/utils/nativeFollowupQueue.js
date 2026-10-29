import { getEnvironmentCacheScope, getEnvironmentSignal } from './remoteEnvironments';
import { resolveHomeApiUrl } from './apiBase';
import { createUuid } from './createUuid';

const stores = new WeakMap();
const empty = Object.freeze({ items: [], error: '' });
const emptyStore = { getSnapshot: () => empty, subscribe: () => () => {}, update: () => false, holdLocal: () => {} };
const saveError = 'The follow-up queue could not be saved on this device. Review the queue and your draft before continuing.';

function createStore(sessionId, signal, scope) {
  const home = new URL(resolveHomeApiUrl('/'), window.location.origin).href;
  const key = `nativeFollowupQueue:v1:${scope.identity}:${scope.environment}:${encodeURIComponent(home)}:${encodeURIComponent(sessionId)}`;
  let raw = null, snapshot = empty;
  const listeners = new Set();
  function publish(items, error = '') {
    snapshot = { items, error };
    listeners.forEach(listener => listener());
  }
  try {
    raw = sessionStorage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.some(item => !item || typeof item.id !== 'string' || typeof item.text !== 'string'
        || !['queued', 'waiting', 'sending', 'editing', 'held'].includes(item.status))) throw new Error('Invalid queue');
      publish(saved.map(item => item.status === 'sending' ? { ...item, status: 'held' }
        : item.status === 'queued' || item.status === 'waiting' ? { ...item, status: 'recovered' } : item));
    }
  } catch { publish([], 'The saved follow-up queue could not be read. Restore device storage before sending.'); }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(change) {
      if (signal.aborted || snapshot.error && !snapshot.error.startsWith('The follow-up queue could not be saved')) return false;
      const next = change(snapshot.items);
      if (next === snapshot.items) return false;
      try {
        if (sessionStorage.getItem(key) !== raw) throw new Error('Queue changed elsewhere');
        const encoded = JSON.stringify(next.map(item => item.status === 'recovered' ? { ...item, status: 'queued' } : item));
        sessionStorage.setItem(key, encoded);
        raw = encoded;
        publish(next);
        return true;
      } catch { publish(snapshot.items, saveError); return false; }
    },
    holdLocal(id) {
      if (!signal.aborted) publish(snapshot.items.map(item => item.id === id && item.status === 'sending' ? { ...item, status: 'held' } : item), snapshot.error);
    },
  };
}

export function getNativeFollowupQueue(sessionId) {
  if (!sessionId) return emptyStore;
  const signal = getEnvironmentSignal();
  let current = stores.get(signal);
  if (!current) { current = new Map(); stores.set(signal, current); }
  let store = current.get(sessionId);
  if (!store) { store = createStore(sessionId, signal, getEnvironmentCacheScope()); current.set(sessionId, store); }
  return store;
}

export function newNativeFollowup(text) { return { id: createUuid(), text, status: 'queued' }; }
