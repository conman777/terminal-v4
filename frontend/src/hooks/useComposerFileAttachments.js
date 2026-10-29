import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, getEnvironmentStorage, subscribeEnvironment } from '../utils/remoteEnvironments';

const scopes = new WeakMap();
const empty = Object.freeze([]);
const emptySnapshot = Object.freeze({ items: empty, error: '', restored: false, conflict: null });
const emptyStore = { getSnapshot: () => emptySnapshot, subscribe: () => () => {}, set: () => {}, retry: () => {}, useSaved: () => false, validate: () => false, selectionToken: () => null, isSelectionCurrent: () => false };
const authKey = () => JSON.stringify(captureAuthScope());

function attachmentStore(environment, account, sessionId) {
  if (!sessionId) return emptyStore;
  let accounts = scopes.get(environment);
  if (!accounts) { accounts = new Map(); scopes.set(environment, accounts); }
  let sessions = accounts.get(account);
  if (!sessions) { sessions = new Map(); accounts.set(account, sessions); }
  let store = sessions.get(sessionId);
  if (!store) {
    const auth = captureAuthScope();
    const storage = getEnvironmentStorage();
    const key = `composerFiles:v1:${encodeURIComponent(auth.home)}:${encodeURIComponent(auth.userId || '')}:${encodeURIComponent(sessionId)}`;
    const current = () => getEnvironmentSignal() === environment && authKey() === account;
    const persistent = Boolean(auth.userId);
    let raw = null, snapshot = emptySnapshot, corrupt = false, conflictRaw = null, selectionToken = {};
    const listeners = new Set();
    const restoredPaths = new Set();
    const publish = next => { snapshot = next; listeners.forEach(listener => listener()); };
    function readItems(value) {
      if (value === null) return empty;
      if (value.length > 100_000) throw new Error('Attachment draft is too large');
      const saved = JSON.parse(value);
      if (saved.version !== 1 || saved.sessionId !== sessionId || !Array.isArray(saved.items) || saved.items.length > 100
        || saved.items.some(item => !item || typeof item.name !== 'string' || typeof item.path !== 'string' || !item.path)) throw new Error('Invalid attachment draft');
      return saved.items.map(({ name, path }) => ({ name, path }));
    }
    function showConflict(items, restored, value) {
      try {
        const saved = readItems(value);
        conflictRaw = value;
        publish({ items, restored, error: 'File selections changed in another tab. Review the saved files before sending.', conflict: { items: saved } });
      } catch {
        conflictRaw = null;
        publish({ items, restored, error: 'Saved file selections changed in another tab but could not be read. Check device storage before sending.', conflict: null });
      }
    }
    try {
      if (persistent) raw = storage.getItem(key);
      if (raw !== null) {
        const saved = readItems(raw);
        saved.forEach(item => restoredPaths.add(item.path));
        snapshot = { items: saved, error: '', restored: saved.length > 0, conflict: null };
      }
    } catch {
      corrupt = true;
      snapshot = { items: empty, error: 'Saved file selections could not be read. Check device storage before sending.', restored: false, conflict: null };
    }
    function save(items, restored = false) {
      if (!current()) return;
      if (!persistent) { publish({ items, error: '', restored, conflict: null }); return; }
      try {
        const saved = storage.getItem(key);
        if (corrupt && saved === null) { raw = null; corrupt = false; }
        if (!corrupt && saved !== raw) { showConflict(items, restored, saved); return; }
        if (corrupt) throw new Error('Attachment draft cannot be read');
        const next = JSON.stringify({ version: 1, sessionId, items: items.map(({ name, path }) => ({ name, path })) });
        if (next.length > 100_000 || items.length > 100) throw new Error('Attachment draft is too large');
        storage.setItem(key, next); raw = next;
        publish({ items, error: '', restored, conflict: null });
      } catch {
        publish({ items, error: 'File selections could not be saved on this device. Keep this tab open and check device storage before sending.', restored, conflict: null });
      }
    }
    function checkStorage() {
      if (!persistent || !current()) return;
      try {
        const saved = storage.getItem(key);
        if (saved !== raw && (snapshot.conflict === null || saved !== conflictRaw)) showConflict(snapshot.items, snapshot.restored, saved);
      } catch {
        const error = 'File selections could not be read on this device. Check device storage before sending.';
        if (snapshot.error !== error) publish({ ...snapshot, error, conflict: null });
      }
    }
    function onStorage(event) {
      if (event.storageArea === localStorage) checkStorage();
    }
    store = {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        if (!listeners.size) window.addEventListener('storage', onStorage);
        listeners.add(listener);
        checkStorage();
        return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', onStorage); };
      },
      set(update) {
        if (!current()) return;
        const next = typeof update === 'function' ? update(snapshot.items) : update;
        if (next === snapshot.items) return;
        save(next.length ? next : empty, snapshot.restored && next.some(item => restoredPaths.has(item.path)));
      },
      retry() { save(snapshot.items, snapshot.restored); },
      selectionToken() { return selectionToken; },
      isSelectionCurrent(token) { return current() && token === selectionToken; },
      validate() {
        if (!current()) return false;
        if (!persistent) return !snapshot.error;
        try {
          const saved = storage.getItem(key);
          if (!corrupt && saved !== raw) { showConflict(snapshot.items, snapshot.restored, saved); return false; }
          return !corrupt && !snapshot.error;
        } catch {
          publish({ ...snapshot, error: 'File selections could not be read on this device. Check device storage before sending.', conflict: null });
          return false;
        }
      },
      useSaved(reviewed) {
        if (!current() || !persistent || !reviewed || snapshot.conflict !== reviewed) return false;
        try {
          const saved = storage.getItem(key);
          if (saved !== conflictRaw) { showConflict(snapshot.items, snapshot.restored, saved); return false; }
          raw = saved;
          corrupt = false;
          selectionToken = {};
          restoredPaths.clear();
          reviewed.items.forEach(item => restoredPaths.add(item.path));
          publish({ items: reviewed.items, error: '', restored: reviewed.items.length > 0, conflict: null });
          return true;
        } catch {
          publish({ ...snapshot, error: 'File selections could not be read on this device. Check device storage before sending.', conflict: null });
          return false;
        }
      },
    };
    sessions.set(sessionId, store);
  }
  return store;
}

export function useComposerFileAttachments(sessionId) {
  const environment = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const account = useSyncExternalStore(subscribeAuth, authKey);
  const store = useMemo(() => attachmentStore(environment, account, sessionId), [environment, account, sessionId]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const setAttachments = useCallback(update => store.set(update), [store]);
  return [snapshot.items, setAttachments, snapshot.error, store.retry, snapshot.restored, snapshot.conflict, store.useSaved, store.validate, store.selectionToken, store.isSelectionCurrent];
}
