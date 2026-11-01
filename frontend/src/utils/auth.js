import { resolveHomeApiUrl } from './apiBase';
import { sha256 } from '@noble/hashes/sha256';
import { assertLegacyAuthAllowed, isStrictAuthSelected } from './strictAuthBoundary';

const ACCESS_TOKEN_KEY = 'terminal_access_token';
const REFRESH_TOKEN_KEY = 'terminal_refresh_token';
const USER_KEY = 'terminal_user';
const SESSION_KEY = 'terminal_auth_session';
const REFRESH_PUBLICATION_KEY = 'terminal_auth_refresh_publication';
const PAIR_SEQ_KEY = 'terminal_auth_pair_seq';

// Centralized auth state to prevent race conditions
// Start as true - AuthContext will set to false when validation completes
let isAuthInitializing = true;
let refreshPromise = null;
let authGeneration = 0;
const authListeners = new Set();
const authKeys = new Set([ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY, SESSION_KEY]);
// Latest value seen for each credential key from this tab's writes and other tabs' storage events.
const observedAuth = new Map();
function writeAuth(key, value) {
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  observedAuth.set(key, value);
}
const notifyAuth = (reason = 'identity') => authListeners.forEach(listener => listener(reason));

export function beginAuthChange() {
  assertLegacyAuthAllowed();
  authGeneration += 1;
  refreshPromise = null;
  writeAuth(SESSION_KEY, Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-'));
  return captureAuthScope();
}

export function captureAuthScope() {
  if (isStrictAuthSelected()) return { generation: -1, session: null, home: null, userId: null };
  return { generation: authGeneration, session: localStorage.getItem(SESSION_KEY), home: new URL(resolveHomeApiUrl('/'), window.location.origin).href, userId: getUser()?.id || null };
}

export function isAuthScopeCurrent(scope) {
  return !isStrictAuthSelected() && scope?.generation === authGeneration
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
  if (event.key === null) for (const key of authKeys) observedAuth.set(key, null);
  else observedAuth.set(event.key, event.newValue);
  // Rotation keeps the session epoch; explicit login/logout changes it before credentials.
  // Storage events may arrive after a waiting lock has already read the new pair.
  if (event.key === null || event.key === SESSION_KEY || event.newValue === null) {
    notifyAuth();
  } else {
    notifyAuth('rotation');
  }
});

export function getAccessToken() {
  if (isStrictAuthSelected()) return null;
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken() {
  if (isStrictAuthSelected()) return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

function storePairSeq(pairSeq) {
  if (Number.isSafeInteger(pairSeq) && pairSeq > 0) localStorage.setItem(PAIR_SEQ_KEY, String(pairSeq));
  else localStorage.removeItem(PAIR_SEQ_KEY);
}

export function getPairSeq() {
  if (isStrictAuthSelected()) return null;
  const value = Number(localStorage.getItem(PAIR_SEQ_KEY));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function setTokens(accessToken, refreshToken, pairSeq) {
  assertLegacyAuthAllowed();
  beginAuthChange();
  writeAuth(ACCESS_TOKEN_KEY, accessToken);
  writeAuth(REFRESH_TOKEN_KEY, refreshToken);
  storePairSeq(pairSeq);
  notifyAuth();
}

export function clearTokens(force = false) {
  assertLegacyAuthAllowed();
  // Don't clear tokens during initial auth validation unless forced
  if (isAuthInitializing && !force) {
    console.log('[Auth] Skipping clearTokens - auth is initializing');
    return;
  }
  beginAuthChange();
  writeAuth(ACCESS_TOKEN_KEY, null);
  writeAuth(REFRESH_TOKEN_KEY, null);
  writeAuth(USER_KEY, null);
  localStorage.removeItem(PAIR_SEQ_KEY);
  notifyAuth();
}

export function reportDamagedAuth(scope) {
  if (!isAuthScopeCurrent(scope)) return false;
  notifyAuth('damaged-history');
  return true;
}

export function getUser() {
  if (isStrictAuthSelected()) return null;
  const userJson = localStorage.getItem(USER_KEY);
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

export function setUser(user) {
  assertLegacyAuthAllowed();
  if ((getUser()?.id || null) !== (user?.id || null)) beginAuthChange();
  writeAuth(USER_KEY, JSON.stringify(user));
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
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(name, { mode: 'exclusive' }, run);
  return run();
}

function withRefreshTransaction(name, run) {
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
            try { work.resolve(work.work(store)); }
            catch (error) { work.reject(error); }
          }
          keepAlive();
        };
      }
      keepAlive();
    };
  });
}

const DAMAGED_HISTORY_ERROR = 'Local sign-in history is damaged; contact your administrator';
const CONSUMED_KEY = 'consumed';
const STORAGE_CATCH_UP_MS = 3000;

function fingerprint(value) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(16) + (a >>> 0).toString(16);
}

function accessDigest(value) {
  return Array.from(sha256(new TextEncoder().encode(value || '')), byte => byte.toString(16).padStart(2, '0')).join('');
}

function readConsumed(store) {
  return new Promise((resolve, reject) => {
    const request = store.get(CONSUMED_KEY);
    const keyRequest = store.getKey(CONSUMED_KEY);
    keyRequest.onsuccess = () => {
      if (keyRequest.result === undefined) return resolve([]);
      if (!Array.isArray(request.result) || Array.from(request.result).some(value => typeof value !== 'string')) {
        return reject(new Error(DAMAGED_HISTORY_ERROR));
      }
      return resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    keyRequest.onerror = () => reject(keyRequest.error);
  });
}

function readRefreshRecord(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    const keyRequest = store.getKey(key);
    keyRequest.onsuccess = () => {
      if (keyRequest.result !== undefined && request.result === undefined) return reject(new Error(DAMAGED_HISTORY_ERROR));
      return resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    keyRequest.onerror = () => reject(keyRequest.error);
  });
}

const PAIR_MISMATCH_ERROR = 'Token refresh pair mismatch; try again';
const UPGRADE_REQUIRED_ERROR = 'Upgrade required; sign in again';

async function readRejectionCode(response) {
  const body = await response.json().catch(() => null);
  return typeof body?.code === 'string' ? body.code : null;
}

async function awaitNewerPair(refreshToken, scope) {
  const deadline = Date.now() + STORAGE_CATCH_UP_MS;
  for (;;) {
    if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
    const refresh = getRefreshToken(), access = getAccessToken();
    if (refresh && refresh !== refreshToken && access) return { accessToken: access, user: getUser() };
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function awaitStorageCatchUp(refreshToken) {
  const deadline = Date.now() + STORAGE_CATCH_UP_MS;
  while (getRefreshToken() === refreshToken) {
    if (Date.now() >= deadline) throw new Error('Token refresh outcome uncertain; sign in again');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// localStorage has no cross-tab compare-and-set, so another tab can change the session between
// the scope check and these writes. Verify afterwards, once pending storage events have been
// delivered, and put back what that tab published so a stale pair is never left behind.
async function publishCredentials(scope, { tokens, user }) {
  const written = [[ACCESS_TOKEN_KEY, tokens.accessToken], [REFRESH_TOKEN_KEY, tokens.refreshToken]];
  if (user) written.push([USER_KEY, JSON.stringify(user)]);
  for (const [key, value] of written) localStorage.setItem(key, value);
  await new Promise(resolve => setTimeout(resolve, 0));
  if (isAuthScopeCurrent(scope)) return true;
  for (const [key, value] of written) {
    if (localStorage.getItem(key) !== value) continue;
    const current = observedAuth.get(key);
    if (typeof current === 'string' && current !== value) localStorage.setItem(key, current);
    else localStorage.removeItem(key);
  }
  return false;
}

// Same-account rotation shares a promise locally and exclusive ownership across tabs.
export async function refreshTokens() {
  assertLegacyAuthAllowed();
  const scope = captureAuthScope();
  if (refreshPromise && isAuthScopeCurrent(refreshPromise.scope)) return refreshPromise.promise;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token');
  const accessToken = getAccessToken();
  const publication = localStorage.getItem(REFRESH_PUBLICATION_KEY);
  const pending = { scope, promise: null };
  pending.promise = Promise.resolve().then(async () => {
    try {
      const name = `terminal-auth-refresh:${JSON.stringify([scope.home, scope.userId])}`;
      const result = await withRefreshLock(name, async () => {
        const tokenFingerprint = fingerprint(refreshToken);
        const inputAccessDigest = accessDigest(accessToken);
        const historyKey = `history:${accessDigest(refreshToken)}`;
        const recordKey = `publication:${JSON.stringify([scope.home, scope.userId, scope.session, accessDigest(refreshToken)])}`;
        // Persist the reservation before the request so an abort or restart cannot replay it.
        let deadline;
        let reserved;
        let restore;
        while (reserved === undefined) {
          const currentAccess = getAccessToken();
          const currentAccessDigest = accessDigest(currentAccess);
          const coordinationStarted = Date.now();
          const decision = await withRefreshTransaction(name, async owned => {
            const consumed = await owned(readConsumed);
            const record = await owned(store => readRefreshRecord(store, recordKey));
            const history = await owned(store => readRefreshRecord(store, historyKey));
            return owned(store => {
              if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
              if (history !== undefined && (!history || !['pending', 'non-rotating-success'].includes(history.state))) throw new Error(DAMAGED_HISTORY_ERROR);
              if (history?.state === 'pending' && !consumed.includes(tokenFingerprint)) throw new Error(DAMAGED_HISTORY_ERROR);
              if (getAccessToken() !== currentAccess) return 'wait';
              if (getRefreshToken() !== refreshToken) return 'rotated';
              if (consumed.includes(tokenFingerprint) && !(record == null && history?.state === 'non-rotating-success')) {
                if (record?.state !== 'success') return 'wait';
                const published = localStorage.getItem(REFRESH_PUBLICATION_KEY) === record.id;
                const matches = currentAccessDigest === record.access;
                if (!published || !matches) return 'wait';
                if (publication !== record.id) {
                  if (![record.inputAccess, record.access].includes(inputAccessDigest)) throw new Error('Authentication changed');
                  return 'reuse';
                }
              }
              if (getAccessToken() !== accessToken) throw new Error('Authentication changed');
              restore = { consumed: consumed.includes(tokenFingerprint), record, history };
              store.put({ state: 'pending' }, recordKey);
              store.put({ state: 'pending' }, historyKey);
              store.put(consumed.includes(tokenFingerprint) ? consumed : [tokenFingerprint, ...consumed], CONSUMED_KEY);
              return 'reserved';
            });
          });
          if (deadline !== undefined) deadline += Date.now() - coordinationStarted;
          if (decision === 'reuse') return { accessToken: currentAccess, user: getUser() };
          if (decision === 'reserved') reserved = true;
          else if (decision === 'rotated') reserved = false;
          else {
            deadline ??= Date.now() + STORAGE_CATCH_UP_MS;
            if (Date.now() >= deadline) throw new Error('Token refresh outcome uncertain; sign in again');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        if (!reserved && getRefreshToken() === refreshToken) await awaitStorageCatchUp(refreshToken);
        const result = await withRefreshTransaction(name, async owned => {
          const consumed = await owned(readConsumed);
          const rotation = await owned(store => readRefreshRecord(store, recordKey));
          const tokenFingerprint = fingerprint(refreshToken);
          // Cross-process localStorage can lag the lock hand-off; a ledger entry proves this token was already spent.
          if (!reserved && consumed.includes(tokenFingerprint) && getRefreshToken() === refreshToken) await awaitStorageCatchUp(refreshToken);
          const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
          const sendRefresh = access => fetch(scope.home.replace(/\/$/, '') + '/api/auth/refresh', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken, ...(access ? { accessToken: access } : {}), pairBinding: true, requestId })
          });
          let sentAccess = accessToken;
          let started;
          let pairDeadline;
          do {
            started = await owned(() => {
              if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
              const observedRefresh = getRefreshToken();
              const observedAccess = getAccessToken();
              if (observedRefresh !== refreshToken) {
                if (!observedRefresh || !observedAccess) throw new Error('Authentication changed');
                if (rotation?.state !== 'rotating-success'
                  || accessDigest(observedRefresh) !== rotation.refresh
                  || accessDigest(observedAccess) !== rotation.access) return { wait: true };
                if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
                return { reused: { accessToken: observedAccess, user: getUser() } };
              }
              if (observedAccess !== accessToken) throw new Error('Authentication changed');
              return { response: sendRefresh(observedAccess) };
            });
            if (started.wait) {
              pairDeadline ??= Date.now() + STORAGE_CATCH_UP_MS;
              if (Date.now() >= pairDeadline) throw new Error('Token refresh outcome uncertain; sign in again');
              await new Promise(resolve => setTimeout(resolve, 20));
            }
          } while (started.wait);
          if (started.reused) return started.reused;
          let response;
          try { response = await started.response; }
          catch {
            // A lost response is recoverable: the server returns the same pair for the same token and request id.
            const uncertain = () => new Error('Token refresh outcome uncertain; sign in again');
            response = await sendRefresh(sentAccess).catch(() => { throw uncertain(); });
            if (!response.ok) throw uncertain();
          }
          let rejection = null;
          if (!response.ok) rejection = await readRejectionCode(response);
          if (response.status === 428 && rejection === 'pair_required') {
            const retryAccess = await owned(() => {
              if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken) throw new Error('Authentication changed');
              return getAccessToken();
            });
            if (retryAccess) {
              sentAccess = retryAccess;
              response = await sendRefresh(retryAccess).catch(() => { throw new Error('Token refresh outcome uncertain; sign in again'); });
              rejection = response.ok ? null : await readRejectionCode(response);
            }
          }
          const release = () => owned(store => {
            if (!restore) return;
            if (restore.record === undefined) store.delete(recordKey); else store.put(restore.record, recordKey);
            if (restore.history === undefined) store.delete(historyKey); else store.put(restore.history, historyKey);
            store.put(restore.consumed ? consumed : consumed.filter(value => value !== tokenFingerprint), CONSUMED_KEY);
          });
          if (!response.ok) {
            if (response.status === 409 && rejection === 'pair_mismatch') {
              await release();
              const adopted = await awaitNewerPair(refreshToken, scope);
              if (adopted) return adopted;
              throw new Error(PAIR_MISMATCH_ERROR);
            }
            if (response.status === 401 && rejection === 'refresh_token_spent') {
              const adopted = await awaitNewerPair(refreshToken, scope);
              if (adopted) return adopted;
              throw new Error('Token refresh outcome uncertain; sign in again');
            }
            if (response.status === 426) {
              await release();
              throw new Error(UPGRADE_REQUIRED_ERROR);
            }
            if (response.status === 428 && rejection === 'pair_required') {
              await release();
              throw new Error('Token refresh temporarily unavailable');
            }
          }
          await owned(() => {
            if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken || getAccessToken() !== sentAccess) throw new Error('Authentication changed');
            if (!response.ok) {
              if (response.status === 401 || response.status === 403) {
                clearTokens(true);
                throw new Error('Token refresh failed');
              }
              throw new Error('Token refresh temporarily unavailable');
            }
          });
          let data;
          try { data = await response.json(); }
          catch { throw new Error('Token refresh outcome uncertain; sign in again'); }
          const outputAccessDigest = accessDigest((data?.tokens || data)?.accessToken);
          return owned(store => {
            if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken || getAccessToken() !== sentAccess) throw new Error('Authentication changed');
            const tokens = data?.tokens || data;
            if (!tokens?.accessToken || !tokens?.refreshToken) {
              clearTokens(true);
              throw new Error('Invalid token response');
            }
            let publicationId;
            if (tokens.refreshToken === refreshToken) {
              publicationId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('-');
              store.put({ state: 'success', id: publicationId, inputAccess: inputAccessDigest, access: outputAccessDigest }, recordKey);
              store.put({ state: 'non-rotating-success' }, historyKey);
            } else {
              store.put({ state: 'rotating-success', access: outputAccessDigest, refresh: accessDigest(tokens.refreshToken) }, recordKey);
            }
            store.put(consumed, CONSUMED_KEY);
            return { tokens, user: data.user, publicationId, pairSeq: data.session?.pairSeq, sentAccess };
          });
        });
        // Publish only after the transaction commits; a failed commit leaves the reservation.
        if (!result.tokens) return result;
        if (!isAuthScopeCurrent(scope) || getRefreshToken() !== refreshToken || getAccessToken() !== (result.sentAccess ?? accessToken)) throw new Error('Authentication changed');
        if (!await publishCredentials(scope, result)) throw new Error('Authentication changed');
        storePairSeq(result.pairSeq);
        if (result.publicationId) localStorage.setItem(REFRESH_PUBLICATION_KEY, result.publicationId);
        notifyAuth(result.user ? 'identity' : 'rotation');
        return { accessToken: result.tokens.accessToken, user: result.user };
      });
      if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
      await fetch(scope.home.replace(/\/$/, '') + '/api/preview/session', {
        method: 'POST', headers: { Authorization: `Bearer ${result.accessToken}` }
      }).catch(() => {});
      if (!isAuthScopeCurrent(scope)) throw new Error('Authentication changed');
      return result;
    } catch (error) {
      if (error?.message === DAMAGED_HISTORY_ERROR) reportDamagedAuth(scope);
      else if (['Token refresh outcome uncertain; sign in again', 'Token refresh temporarily unavailable'].includes(error?.message) && isAuthScopeCurrent(scope)) notifyAuth('refresh-uncertain');
      throw error;
    } finally {
      if (refreshPromise === pending) refreshPromise = null;
    }
  });
  refreshPromise = pending;
  return pending.promise;
}
