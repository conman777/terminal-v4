import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let browser, server, origin, context, first, second, requests, held, consumed, apiRequests;
const initial = { access: 'synthetic-expired-access', refresh: 'synthetic-original-refresh' };
const rotated = { access: 'synthetic-rotated-access', refresh: 'synthetic-rotated-refresh' };
const identity = { id: 'synthetic-owner' };
const json = (res, status, body = {}) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const snapshot = page => page.evaluate(() => ({ outcome, access: auth.getAccessToken(), refresh: auth.getRefreshToken(), user: auth.getUser() }));
const start = page => page.evaluate(() => { window.outcome = 'pending'; auth.refreshTokens().then(value => { window.outcome = { accessToken: value.accessToken }; }, error => { window.outcome = { error: error.message }; }); });
const finished = page => page.waitForFunction(() => outcome !== 'pending');
const release = (status = 200, body = { tokens: { accessToken: rotated.access, refreshToken: rotated.refresh } }) => { for (const res of held.splice(0)) json(res, status, body); };

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/api/auth/refresh') {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      if (consumed) return json(res, 401, { error: 'Synthetic single-use token consumed' });
      consumed = true; held.push(res); return;
    }
    if (req.url === '/api/preview/session') return json(res, 200);
    if (req.url === '/api/fixture') {
      let body = ''; for await (const chunk of req) body += chunk;
      apiRequests.push({ body, authorization: req.headers.authorization });
      return json(res, req.headers.authorization === `Bearer ${rotated.access}` ? 200 : 401);
    }
    res.setHeader('Content-Type', 'text/javascript');
    if (req.url === '/apiBase.js') return res.end('export const resolveHomeApiUrl=p=>(window.fixtureHome||location.origin)+p; export const resolveApiUrl=resolveHomeApiUrl; export const resolveApiBase=()=>window.fixtureHome||location.origin;');
    if (req.url === '/remoteEnvironments.js') return res.end('export const routeEnvironmentPath=p=>p; export const getEnvironmentSignal=()=>null; export const getEnvironmentStorage=()=>localStorage;');
    if (['/auth.js', '/api.js', '/terminalCommandDelivery.js'].includes(req.url)) {
      const source = await readFile(new URL('.' + req.url, import.meta.url), 'utf8');
      return res.end(source.replace(/from '\.\/(auth|apiBase|remoteEnvironments|terminalCommandDelivery)'/g, "from '/$1.js'"));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Synthetic auth fixture</title><script type="module">import * as auth from "/auth.js"; import {apiFetch} from "/api.js"; window.auth=auth; window.apiFetch=apiFetch;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });
beforeEach(async () => {
  requests = []; held = []; consumed = false; apiRequests = [];
  context = await browser.newContext();
  context.setDefaultTimeout(2000);
  first = await context.newPage(); second = await context.newPage();
  for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.auth); }
  await first.evaluate(({ initial, identity }) => { auth.setTokens(initial.access, initial.refresh); auth.setUser(identity); auth.setAuthInitializing(false); }, { initial, identity });
  await second.evaluate(() => auth.setAuthInitializing(false));
});
afterEach(async () => { await context?.close(); release(); });

describe('refreshTokens across independent same-origin browser tabs', () => {
  it('serializes rotating refresh tokens across tabs when HTTP has no Web Locks', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(); await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('fences logout while an HTTP tab is queued behind another refresh', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    await second.evaluate(() => auth.clearTokens(true));
    release(); await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(second)).toEqual({ outcome: { error: 'Authentication changed' }, access: null, refresh: null, user: null });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('does not publish tokens when HTTP coordination aborts as the refresh JSON settles', async () => {
    await first.evaluate(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        const request = open(...args);
        request.addEventListener('success', () => {
          const database = request.result, transaction = database.transaction.bind(database);
          database.transaction = (...args) => { const value = transaction(...args); window.refreshTransaction = value; return value; };
        });
        return request;
      };
      const nativeFetch = fetch;
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (String(args[0]).endsWith('/api/auth/refresh')) {
          const json = response.json.bind(response);
          response.json = async () => {
            const value = await json();
            refreshTransaction.abort();
            const deadline = performance.now() + 50;
            while (performance.now() < deadline) { /* Delay abort-event delivery. */ }
            return value;
          };
        }
        return response;
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Cross-tab token refresh coordination lost' }, ...initial, user: identity });
  });

  it('holds a competing tab until rotation is persisted, then both reuse one response', async () => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    await expect.poll(() => second.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
    expect(await snapshot(second)).toEqual({ outcome: 'pending', ...initial, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    release(); await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('retries both tabs with their exact serialized API bodies after one shared rotation', async () => {
    for (const [index, page] of [first, second].entries()) {
      await page.evaluate(index => {
        window.outcome = 'pending';
        apiFetch('/api/fixture', { method: 'POST', body: { requestId: `synthetic-${index}`, text: 'Keep exact bytes' } }).then(response => { window.outcome = { status: response.status }; }, error => { window.outcome = { error: error.message }; });
      }, index);
    }
    await expect.poll(() => second.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
    await expect.poll(() => requests.length).toBe(1);
    release(); await Promise.all([finished(first), finished(second)]);
    expect([(await snapshot(first)).outcome, (await snapshot(second)).outcome]).toEqual([{ status: 200 }, { status: 200 }]);
    for (const index of [0, 1]) {
      const body = JSON.stringify({ requestId: `synthetic-${index}`, text: 'Keep exact bytes' });
      expect(apiRequests.filter(request => request.body === body)).toEqual([{ body, authorization: `Bearer ${initial.access}` }, { body, authorization: `Bearer ${rotated.access}` }]);
    }
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('accepts initial refresh-only sessions when rotation also supplies the verified identity', async () => {
    await first.evaluate(() => { auth.clearTokens(true); auth.setTokens('', 'synthetic-original-refresh'); });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(200, { user: identity, tokens: { accessToken: rotated.access, refreshToken: rotated.refresh } }); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
  });

  it.each(['logout', 'account', 'same-account-login', 'home'])('fences %s while a tab is waiting for the lock', async change => {
    await start(first); await expect.poll(() => requests.length).toBe(1); await start(second);
    await expect.poll(() => second.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
    await second.evaluate(change => {
      if (change === 'logout') auth.clearTokens(true);
      if (change === 'account' || change === 'same-account-login') { auth.setTokens('synthetic-new-login-access', 'synthetic-new-login-refresh'); auth.setUser({ id: change === 'account' ? 'synthetic-other-owner' : 'synthetic-owner' }); }
      if (change === 'home') window.fixtureHome = location.origin + '/other-home';
    }, change);
    release(); await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ error: 'Authentication changed' });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    const stored = await snapshot(second);
    expect({ access: stored.access, refresh: stored.refresh }).toEqual(change === 'logout' ? { access: null, refresh: null } : change === 'home' ? rotated : { access: 'synthetic-new-login-access', refresh: 'synthetic-new-login-refresh' });
  });

  it.each([401, 200])('a late losing %s cannot clear or overwrite a newer same-session pair before storage events', async status => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await first.evaluate(() => {
      // Deliberately bypass session APIs and event delivery to isolate the response/storage fence.
      localStorage.setItem('terminal_access_token', 'synthetic-newer-access');
      localStorage.setItem('terminal_refresh_token', 'synthetic-newer-refresh');
    });
    release(status); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Authentication changed' }, access: 'synthetic-newer-access', refresh: 'synthetic-newer-refresh', user: identity });
  });

  it('rejects an old request scope when another realm changes account storage without a session marker', async () => {
    await first.evaluate(() => { window.oldScope = auth.captureAuthScope(); });
    await second.evaluate(() => { localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-other-owner' })); });
    expect(await first.evaluate(() => auth.isAuthScopeCurrent(oldScope))).toBe(false);
  });

  it.each(['missing', 'reject', 'cancel', 'throw'])('preserves credentials when Web Locks are %s and permits a later coordinated retry', async mode => {
    await first.evaluate(mode => {
      window.nativeLocks = navigator.locks;
      window.nativeIndexedDB = indexedDB;
      if (mode === 'missing') Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'locks', { configurable: true, value: mode === 'missing' ? undefined : { request: () => {
        const error = new DOMException('Synthetic lock request failure', mode === 'cancel' ? 'AbortError' : 'SecurityError');
        if (mode === 'throw') throw error;
        return Promise.reject(error);
      } } });
    }, mode);
    await start(first); await finished(first);
    const stored = await snapshot(first);
    expect({ access: stored.access, refresh: stored.refresh, requests }).toEqual({ ...initial, requests: [] });
    expect(stored.outcome.error).toBeTruthy();
    await first.evaluate(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: nativeLocks });
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: nativeIndexedDB });
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: rotated.access });
  });

  it('releases the lock after network rejection and permits another tab to retry', async () => {
    await first.route('**/api/auth/refresh', route => route.abort());
    await start(first); await finished(first);
    expect((await snapshot(first)).access).toBe(initial.access);
    await start(second); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
  });

  it('cancels one waiting API request without replaying it or canceling shared rotation', async () => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await second.evaluate(() => {
      window.controller = new AbortController(); window.outcome = 'pending';
      apiFetch('/api/fixture', { signal: controller.signal }).then(response => { window.outcome = { status: response.status }; }, error => { window.outcome = { name: error.name }; });
    });
    await expect.poll(() => second.evaluate(async () => (await navigator.locks.query()).pending.length)).toBe(1);
    await second.evaluate(() => controller.abort());
    release(); await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: rotated.access });
    expect((await snapshot(second)).outcome).toEqual({ name: 'AbortError' });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    expect(apiRequests).toEqual([{ body: '', authorization: `Bearer ${initial.access}` }]);
  });
});
