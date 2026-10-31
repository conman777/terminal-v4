import { resolveHomeApiUrl } from './apiBase';

const ACCESS_TOKEN_KEY = 'terminal_access_token';
const REFRESH_TOKEN_KEY = 'terminal_refresh_token';
const USER_KEY = 'terminal_user';
const SESSION_KEY = 'terminal_auth_session';

// Centralized auth state to prevent race conditions
// Start as true - AuthContext will set to false when validation completes
let isAuthInitializing = true;
let refreshPromise = null;
let authGeneration = 0;
const authListeners = new Set();
const authKeys = new Set([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY, SESSION_KEY]);
const notifyAuth = (reason = 'identity') => authListeners.forEach(listener => listener(reason));

export function beginAuthChange() {
  authGeneration += 1;
  refreshPromise = null;
  localStorage.setItem(SESSION_KEY, Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'));
  return captureAuthScope();
}

export function captureAuthScope() {
  return { generation: authGeneration, session: localStorage.getItem(SESSION_KEY), home: new URL(resolveHomeApiUrl('/'), window.location.origin).href, userId: getUser()?.id || null };
}

export function isAuthScopeCurrent(scope) {
  return scope?.generation === authGeneration
    && scope.session === localStorage.getItem(SESSION_KEY)
    && (!scope.userId || scope.userId === (getUser()?.id || null))
    && scope.home === new URL(resolveHomeApiUrl('/'), window.location.origin).href;
}

export function subscribeAuth(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || (event.key !== null && !authKeys.has(event.key))) return;
  // Rotation keeps the session epoch; explicit login/logout changes it before credentials.
  // Storage events may arrive after a waiting lock has already read the new pair.
  if (event.key === null || event.key === SESSION_KEY || event.newValue === null) {
    notifyAuth();
  } else {
    notifyAuth('rotation');
  }
});

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken, refreshToken) {
  beginAuthChange();
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  notifyAuth();
}

export function clearTokens(force = false) {
  // Don't clear tokens during initial auth validation unless forced
  if (isAuthInitializing && !force) {
    console.log('[Auth] Skipping clearTokens - auth is initializing');
    return;
  }
  beginAuthChange();
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  notifyAuth();
}

export function getUser() {
  const userJson = localStorage.getItem(USER_KEY);
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

export function setUser(user) {
  if ((getUser()?.id || null) !== (user?.id || null)) beginAuthChange();
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  notifyAuth();
}

export function isAuthenticated() {
  return !!getAccessToken();
}

// Mark auth as initializing (called by AuthContext on mount)
export function setAuthInitializing(value) {
  isAuthInitializing = value;
}

export function getAuthInitializing() {
  return isAuthInitializing;
}

function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, '=');
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function isAccessTokenExpired(token, skewSeconds = 30) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return true;
  }
  return Date.now() >= (payload.exp - skewSeconds) * 1000;
}

function withRefreshLock(name, run) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(name, { mode: 'exclusive' }, () => run(work => Promise.resolve().then(work)));
  if (!globalThis.indexedDB) return Promise.reject(new Error('Cross-tab token refresh unavailable'));
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const opening = indexedDB.open('terminal-v4-auth-coordination', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('refresh');
    opening.onerror = opening.onblocked = () => { abandoned = true; reject(new Error('Cross-tab token refresh unavailable')); };
    opening.onsuccess = () => {
      const database = opening.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => database.close();
      let transaction;
      try { transaction = database.transaction('refresh', 'readwrite'); }
      catch (error) { database.close(); reject(error); return; }
      let held = true, started = false, finished = false, result, failure;
      const workQueue = [];
      const lost = () => new Error('Cross-tab token refresh coordination lost');
      function fail() {
        held = false; database.close();
        for (const work of workQueue.splice(0)) work.reject(lost());
        reject(lost());
      }
      const owned = work => held ? new Promise((resolve, reject) => workQueue.push({ work, resolve, reject })) : Promise.reject(lost());
      transaction.onabort = transaction.onerror = fail;
      transaction.oncomplete = () => {
        held = false; database.close();
        if (!finished) reject(new Error('Cross-tab token refresh coordination lost'));
        else if (failure) reject(failure);
        else resolve(result);
      };
      const store = transaction.objectStore('refresh');
      function keepAlive() {
        if (!held || finished) return;
        // Overlapping readwrite transactions serialize tabs. Keep this transaction
        // alive until rotation is persisted; no token or expiring lease is stored.
        let ping;
        try { ping = store.get(name); }
        catch { fail(); return; }
        ping.onsuccess = () => {
          if (!started) {
            started = true;
            run(owned).then(
              value => { result = value; finished = true; },
              error => { failure = error; finished = true; },
            );
          }
          const work = workQueue.shift();
          if (work) {
            // Abort events are asynchronous; a fresh request proves this callback
            // still owns a live transaction before any token side effect.
            try { store.get(name); }
            catch { work.reject(lost()); fail(); return; }
            try { work.resolve(work.work()); }
            catch (error) { work.reject(error); }
          }
          keepAlive();
        };
      }
      keepAlive();
    };
  });
}

// Same-account rotation shares a promise locally and exclusive ownership across tabs.
export async function refreshTokens() {
  const scope = captureAuthScope();
  if (refreshPromise && isAuthScopeCurrent(refreshPromise.scope)) return refreshPromise.promise;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token');
  const accessToken = getAccessToken();
  const pending = { scope, promise: null };
  pending.promise = Promise.resolve().then(async () => {
    try {
      const result = await withRefreshLock(`terminal-auth-refresh:${JSON.stringify([scope.home, scope.userId])}`, async owned => {
        const started = await owned(() => {
          if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
          // Another tab may have rotated while this request was waiting for ownership.
          if (getRefreshToken() !== refreshToken) {
            // The captured access token may already be the new one: the two storage writes are separate.
            if (!getRefreshToken() || !getAccessToken()) throw new Error('Authentication changed');
            return { reused: { accessToken: getAccessToken(), user: getUser() } };
          }
          if (getAccessToken() !== accessToken) throw new Error('Authentication changed');
          return { response: fetch(scope.home.replace(/\/$/, '') + '/api/auth/refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken })
          }) };
        });
        if (started.reused) return started.reused;
        const response = await started.response;
        await owned(() => {
          if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken || getAccessToken() !== accessToken) throw new Error('Authentication changed');
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
              clearTokens(true);
              throw new Error('Token refresh failed');
            }
            throw new Error('Token refresh temporarily unavailable');
          }
        });
        const data = await response.json();
        return owned(() => {
          if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken || getAccessToken() !== accessToken) throw new Error('Authentication changed');
          const tokens = data?.tokens || data;
          if (!tokens?.accessToken || !tokens?.refreshToken) {
            clearTokens(true);
            throw new Error('Invalid token response');
          }
          localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
          localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
          if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
          notifyAuth(data.user ? 'identity' : 'rotation');
          return { accessToken: tokens.accessToken, user: data.user };
        });
      });
      await fetch(scope.home.replace(/\/$/, '') + '/api/preview/session', {
        method: 'POST', headers: { Authorization: `Bearer ${result.accessToken}` }
      }).catch(() => {});
      if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
      return result;
    } finally {
      if (refreshPromise === pending) refreshPromise = null;
    }
  });
  refreshPromise = pending;
  return pending.promise;
}
