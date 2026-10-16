let activeEnvironment = null;
let identityScope = '';

function abortEnvironmentRequests() {
  generation.abort();
  generation = new AbortController();
}

function selectionKey() { return identityScope + 'selectedEnvironment'; }

export function setEnvironmentIdentity(userId, homeOrigin = window.location.origin) {
  const nextScope = userId ? 'identity:' + encodeURIComponent(homeOrigin) + ':' + encodeURIComponent(userId) + ':' : '';
  if (nextScope === identityScope) return;
  abortEnvironmentRequests();
  identityScope = nextScope;
  activeEnvironment = null;
  listeners.forEach(listener => listener());
}

export function restoreActiveEnvironment(devices) {
  let id;
  try { id = identityScope ? localStorage.getItem(selectionKey()) : null; } catch { return null; }
  const selected = Array.isArray(devices)
    ? devices.find(device => device.id === id && !device.revoked && !device.revokedAt) : null;
  setActiveEnvironment(selected || null);
  return selected || null;
}

let generation = new AbortController();
const listeners = new Set();

export function getActiveEnvironment() { return activeEnvironment; }
export function getEnvironmentSignal() { return generation.signal; }
export function subscribeEnvironment(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setActiveEnvironment(environment) {
  const next = environment?.id ? { ...environment } : null;
  if (identityScope) {
    try {
      if (next) localStorage.setItem(selectionKey(), next.id);
      else localStorage.removeItem(selectionKey());
    } catch { /* Device selection can still work when browser storage is unavailable. */ }
  }
  if ((next?.id || '') === (activeEnvironment?.id || '')) {
    if (JSON.stringify(next) === JSON.stringify(activeEnvironment)) return;
    activeEnvironment = next;
    listeners.forEach(listener => listener());
    return;
  }
  abortEnvironmentRequests();
  activeEnvironment = next;
  listeners.forEach(listener => listener());
}

export function routeEnvironmentPath(path) {
  if (!activeEnvironment || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return path;
  if (/^\/api\/(auth|environments|vault)(?:[/?]|$)/.test(path)) return path;
  if (!path.startsWith('/api/') && !path.startsWith('/preview/')) return path;
  return '/api/environments/' + encodeURIComponent(activeEnvironment.id) + '/proxy' + path;
}

export function getEnvironmentStorage() {
  const prefix = identityScope + (activeEnvironment ? 'environment:' + activeEnvironment.id + ':' : '');
  return {
    getItem: key => localStorage.getItem(prefix + key),
    setItem: (key, value) => localStorage.setItem(prefix + key, value),
    removeItem: key => localStorage.removeItem(prefix + key),
  };
}
