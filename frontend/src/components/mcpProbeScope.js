import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { resolveHomeApiUrl } from '../utils/apiBase';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';

const held = new Map();
const listeners = new Set();
const storagePrefix = 'terminal:mcp-probe:v1:';
const identity = (scope) => JSON.stringify([scope.auth.home, scope.auth.userId, scope.environment]);
const storageKey = (scope) => storagePrefix + encodeURIComponent(identity(scope));

export function captureMcpProbeScope() {
  const auth = captureAuthScope();
  return {
    auth: { ...auth, home: new URL(resolveHomeApiUrl('/'), window.location.origin).href },
    environment: getActiveEnvironment()?.id || null,
  };
}

export function mcpProbeScopeSnapshot() {
  const scope = captureMcpProbeScope();
  return JSON.stringify([identity(scope), scope.auth.generation, scope.auth.session]);
}

export function subscribeMcpProbeScope(listener) {
  const auth = subscribeAuth(listener);
  const environment = subscribeEnvironment(listener);
  return () => { auth(); environment(); };
}

export function getHeldMcpProbe(scope) {
  const key = identity(scope);
  if (held.has(key)) return held.get(key);
  let record = null;
  try {
    const saved = sessionStorage.getItem(storageKey(scope));
    if (saved) {
      const value = JSON.parse(saved);
      if (value.version !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.probeId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.serverId)
        || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 120) {
        throw new Error('Invalid MCP cleanup identity');
      }
      record = { version: 1, probeId: value.probeId, serverId: value.serverId, timeoutSeconds: value.timeoutSeconds };
    }
  } catch {
    // A damaged identity cannot safely authorize a new connection or a guessed DELETE.
    record = { invalid: true };
  }
  held.set(key, record);
  return record;
}

export function subscribeHeldMcpProbes(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function retainMcpProbe(scope, server, id) {
  if (!scope.auth.userId) throw new Error('Sign in before testing an MCP connection.');
  const previous = getHeldMcpProbe(scope);
  if (previous && previous.probeId !== id) throw new Error('Confirm the previous MCP connection cleanup before starting another test.');
  const record = { version: 1, probeId: id, serverId: server.id, timeoutSeconds: server.timeoutSeconds };
  held.set(identity(scope), record);
  try { sessionStorage.setItem(storageKey(scope), JSON.stringify(record)); } catch { /* Keep the in-memory owner when storage is unavailable. */ }
  listeners.forEach(listener => listener());
}

export function releaseMcpProbe(scope, id) {
  const record = getHeldMcpProbe(scope);
  if (!record || (record.invalid ? id !== null : record.probeId !== id)) return;
  held.set(identity(scope), null);
  try { sessionStorage.removeItem(storageKey(scope)); } catch { /* The in-memory receipt still releases this panel lifetime. */ }
  listeners.forEach(listener => listener());
}

export function scopedMcpProbeFetch(scope, path, options) {
  if (!scope.auth.userId || !isAuthScopeCurrent(scope.auth)) throw new Error('The originating MCP account or home changed. Return to that scope to retry cleanup.');
  const prefix = scope.environment ? `/api/environments/${encodeURIComponent(scope.environment)}/proxy` : '';
  const endpoint = prefix + path;
  // The auth guard fixes the home and owner; this saved prefix bypasses the
  // current environment. Refresh remains limited to that same auth session.
  return apiFetch(endpoint, { ...options, home: true });
}
