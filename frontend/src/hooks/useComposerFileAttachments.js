import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentCacheScope, getEnvironmentSignal, getEnvironmentStorage, subscribeEnvironment } from '../utils/remoteEnvironments';
import { withAttachmentWriteLock } from '../utils/attachmentWriteLock';

const scopes = new WeakMap();
const empty = Object.freeze([]);
const emptySnapshot = Object.freeze({ items: empty, error: '', restored: false, conflict: null, pending: false });
const emptyStore = { getSnapshot: () => emptySnapshot, subscribe: () => () => {}, set: () => {}, retry: () => {}, useSaved: () => false, validate: () => false, selectionToken: () => null, isSelectionCurrent: () => false, dispatch: async () => ({ started: false }), waitForSaves: async () => false };
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
    const cacheScope = getEnvironmentCacheScope();
    const tabKey = `composerFileTab:v1:${encodeURIComponent(auth.home)}:${encodeURIComponent(auth.userId || '')}:${encodeURIComponent(cacheScope.identity)}:${encodeURIComponent(cacheScope.environment)}:${encodeURIComponent(sessionId)}`;
    const current = () => getEnvironmentSignal() === environment && authKey() === account;
    const persistent = Boolean(auth.userId);
    let raw = null, snapshot = emptySnapshot, corrupt = false, conflictRaw = null, selectionToken = {};
    let pendingSaves = 0, saveGeneration = 0, saveQueue = Promise.resolve();
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
        publish({ items, restored, error: 'File selections differ from the saved version. They may have changed in another tab; review the saved files before sending.', conflict: { items: saved }, pending: pendingSaves > 0 });
      } catch {
        conflictRaw = null;
        publish({ items, restored, error: 'Saved file selections changed in another tab but could not be read. Check device storage before sending.', conflict: null, pending: pendingSaves > 0 });
      }
    }
    let recoveredItems = empty;
    try {
      if (persistent) raw = storage.getItem(key);
      const tabRaw = persistent ? sessionStorage.getItem(tabKey) : null;
      if (tabRaw !== null) recoveredItems = readItems(tabRaw);
      const saved = readItems(raw);
      if (tabRaw !== null && JSON.stringify(recoveredItems) !== JSON.stringify(saved)) {
        recoveredItems.forEach(item => restoredPaths.add(item.path));
        const currentSaved = raw;
        raw = tabRaw;
        showConflict(recoveredItems, recoveredItems.length > 0, currentSaved);
      } else if (raw !== null) {
        saved.forEach(item => restoredPaths.add(item.path));
        snapshot = { items: saved, error: '', restored: saved.length > 0, conflict: null };
      }
    } catch {
      corrupt = true;
      snapshot = { items: recoveredItems, error: 'Saved file selections could not be read. Check device storage before sending.', restored: recoveredItems.length > 0, conflict: null };
    }
    function save(items, restored = false) {
      if (!current()) return;
      if (!persistent) { publish({ items, error: '', restored, conflict: null }); return; }
      const generation = ++saveGeneration;
      try {
        if (corrupt && storage.getItem(key) === null && sessionStorage.getItem(tabKey) === null) { raw = null; corrupt = false; }
        if (corrupt) throw new Error('Attachment draft cannot be read');
        const next = JSON.stringify({ version: 1, sessionId, items: items.map(({ name, path }) => ({ name, path })) });
        if (next.length > 100_000 || items.length > 100) throw new Error('Attachment draft is too large');
        sessionStorage.setItem(tabKey, next);
        pendingSaves += 1;
        publish({ ...snapshot, items, restored, pending: true });
        const operation = saveQueue.then(() => withAttachmentWriteLock(() => {
          if (!current()) return { stale: true };
          const saved = storage.getItem(key);
          if (saved !== raw) return { conflict: saved };
          storage.setItem(key, next);
          raw = next;
          return { saved: true };
        }));
        saveQueue = operation.catch(() => {});
        operation.then(outcome => {
          pendingSaves -= 1;
          if (!current()) return;
          if (generation !== saveGeneration || outcome.stale) {
            if (!pendingSaves && snapshot.pending) publish({ ...snapshot, pending: false });
            return;
          }
          if (Object.hasOwn(outcome, 'conflict')) { showConflict(snapshot.items, snapshot.restored, outcome.conflict); return; }
          try {
            const saved = storage.getItem(key);
            if (saved !== raw) { showConflict(snapshot.items, snapshot.restored, saved); return; }
            publish({ ...snapshot, error: '', conflict: null, pending: false });
          } catch {
            publish({ ...snapshot, error: 'File selections could not be read on this device. Check device storage before sending.', conflict: null, pending: false });
          }
        }, () => {
          pendingSaves -= 1;
          if (!current()) return;
          if (generation === saveGeneration) publish({ ...snapshot, error: 'File selections could not be saved on this device. Keep this tab open and check device storage before sending.', conflict: null, pending: false });
          else if (!pendingSaves && snapshot.pending) publish({ ...snapshot, pending: false });
        });
      } catch {
        publish({ items, error: 'File selections could not be saved on this device. Keep this tab open and check device storage before sending.', restored, conflict: null, pending: pendingSaves > 0 });
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
        if (next === snapshot.items || (next.length === snapshot.items.length && next.every((item, index) => item === snapshot.items[index]))) return;
        save(next.length ? next : empty, snapshot.restored && next.some(item => restoredPaths.has(item.path)));
      },
      retry() { save(snapshot.items, snapshot.restored); },
      selectionToken() { return selectionToken; },
      isSelectionCurrent(token) { return current() && token === selectionToken; },
      validate() {
        if (!current() || pendingSaves > 0) return false;
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
      async dispatch(expectedItems, allowed, action) {
        let completion, invoked = false;
        const start = () => {
          if (!current() || snapshot.items !== expectedItems || !allowed() || !store.validate()) return false;
          invoked = true;
          try { completion = Promise.resolve(action()); }
          catch (error) { completion = Promise.reject(error); }
          completion.catch(() => {});
          return true;
        };
        try {
          const started = persistent && expectedItems.length ? await withAttachmentWriteLock(start) : start();
          return started ? { started: true, completion } : { started: false };
        } catch {
          if (invoked) return { started: true, completion };
          if (current()) publish({ ...snapshot, error: 'File selections could not be verified on this device. Keep this draft and check storage before sending.', conflict: null });
          return { started: false };
        }
      },
      async waitForSaves() {
        while (current()) {
          const pending = saveQueue;
          await pending;
          if (pending === saveQueue) return store.validate();
        }
        return false;
      },
      useSaved(reviewed) {
        if (!current() || !persistent || pendingSaves > 0 || !reviewed || snapshot.conflict !== reviewed) return false;
        try {
          const saved = storage.getItem(key);
          if (saved !== conflictRaw) { showConflict(snapshot.items, snapshot.restored, saved); return false; }
          if (saved === null) sessionStorage.removeItem(tabKey);
          else sessionStorage.setItem(tabKey, JSON.stringify({ version: 1, sessionId, items: reviewed.items.map(({ name, path }) => ({ name, path })) }));
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
  return [snapshot.items, setAttachments, snapshot.error, store.retry, snapshot.restored, snapshot.conflict, store.useSaved, store.validate, store.selectionToken, store.isSelectionCurrent, Boolean(snapshot.pending), store.dispatch, store.waitForSaves];
}
