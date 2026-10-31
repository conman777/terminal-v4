import { createUuid } from './createUuid';
import { isAuthScopeCurrent } from './auth';
import { getEnvironmentSignal } from './remoteEnvironments';

const EVENT = 'tv4:file-transfer-review-changed';
const PREFIX = 'tv4:file-transfer-review:v1:';
const LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTransferReviewStore({ sessionId, auth, environment, signal }) {
  const scope = JSON.stringify([auth.home, auth.userId || '', environment.identity, environment.environment, sessionId]);
  const prefix = `${PREFIX}${encodeURIComponent(scope)}:`;
  const current = () => {
    try { return Boolean(sessionId) && !signal.aborted && getEnvironmentSignal() === signal && isAuthScopeCurrent(auth); }
    catch { return false; }
  };
  const notify = () => window.dispatchEvent(new Event(EVENT));

  function getSnapshot() {
    if (!sessionId || signal.aborted || getEnvironmentSignal() !== signal) return '[]';
    try {
      if (!isAuthScopeCurrent(auth)) return '[]';
      const ids = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length));
      }
      return JSON.stringify(ids.sort());
    } catch { return 'unavailable'; }
  }

  function subscribe(listener) {
    const onStorage = event => {
      try {
        if ((event.key === null || event.key?.startsWith(prefix)) && (!event.storageArea || event.storageArea === localStorage)) listener();
      } catch { listener(); }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT, listener);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(EVENT, listener); };
  }

  function mark(requestedId, kind = 'generic') {
    if (!current()) return null;
    try {
      if (!['generic', 'large-paste'].includes(kind)) return null;
      const snapshot = getSnapshot();
      if (snapshot === 'unavailable' || JSON.parse(snapshot).length >= LIMIT) return null;
      const id = requestedId || createUuid();
      if (!UUID.test(id)) return null;
      const key = prefix + id;
      if (localStorage.getItem(key) !== null) return null;
      const value = kind === 'generic' ? '1' : kind;
      localStorage.setItem(key, value);
      if (localStorage.getItem(key) !== value) return null;
      notify();
      return id;
    } catch { return null; }
  }

  function status(id) {
    if (!current() || !UUID.test(id)) return 'unavailable';
    try {
      const value = localStorage.getItem(prefix + id);
      return value === '1' || value === 'large-paste' || /^large-paste:[0-9a-f-]+$/i.test(value || '') ? 'present' : 'missing';
    }
    catch { return 'unavailable'; }
  }

  function kind(id) {
    if (!current() || !UUID.test(id)) return 'unavailable';
    try {
      const value = localStorage.getItem(prefix + id);
      return value === '1' ? 'generic' : value === 'large-paste' || /^large-paste:[0-9a-f-]+$/i.test(value || '') ? 'large-paste' : value === null ? 'missing' : 'unavailable';
    } catch { return 'unavailable'; }
  }

  function touch(id) {
    if (kind(id) !== 'large-paste') return false;
    try {
      localStorage.setItem(prefix + id, `large-paste:${createUuid()}`);
      notify();
      return true;
    } catch { return false; }
  }

  function clear(displayedIds) {
    if (!current() || !Array.isArray(displayedIds)) return false;
    try {
      for (const id of displayedIds) {
        if (typeof id !== 'string' || !current()) return false;
        localStorage.removeItem(prefix + id);
      }
      notify();
      return true;
    } catch { return false; }
  }

  return { getSnapshot, subscribe, mark, clear, status, kind, touch };
}
