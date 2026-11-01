import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from '../test/managedChromium';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let browser, server, origin, context, first, second, requests, rawRequests, script, held, heldBodies, consumed, apiRequests, previewRequests, disconnectAfterConsumption, dropAlways, managedPath;
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
      const parsed = JSON.parse(body);
      rawRequests.push(parsed);
      if (dropAlways) return req.socket.destroy();
      requests.push({ refreshToken: parsed.refreshToken });
      if (script.length) { const step = await script.shift()(); if (step.drop) return req.socket.destroy(); return json(res, step.status, step.body); }
      if (consumed) return json(res, 401, { error: 'Synthetic single-use token consumed' });
      consumed = true;
      if (disconnectAfterConsumption) {
        return json(res, 200, { tokens: { accessToken: rotated.access, refreshToken: rotated.refresh } });
      }
      held.push(res); return;
    }
    if (req.url === '/api/preview/session') { previewRequests.push(req.headers.authorization); return json(res, 200); }
    if (req.url === '/api/synthetic-delayed-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"owner":');
      heldBodies.push(res);
      return;
    }
    if (req.url === '/api/fixture') {
      let body = ''; for await (const chunk of req) body += chunk;
      apiRequests.push({ body, authorization: req.headers.authorization });
      return json(res, [`Bearer ${rotated.access}`, 'Bearer synthetic-new-access'].includes(req.headers.authorization) ? 200 : 401);
    }
    res.setHeader('Content-Type', 'text/javascript');
    if (/^\/noble\/[a-z0-9_]+\.js$/.test(req.url)) return res.end(await readFile(new URL('../../node_modules/@noble/hashes/esm/' + req.url.slice(7), import.meta.url), 'utf8'));
    if (req.url === '/apiBase.js') return res.end('export const resolveHomeApiUrl=p=>(window.fixtureHome||location.origin)+p; export const resolveApiUrl=resolveHomeApiUrl; export const resolveApiBase=()=>window.fixtureHome||location.origin;');
    if (req.url === '/remoteEnvironments.js') return res.end('export const routeEnvironmentPath=p=>p; export const getEnvironmentSignal=()=>null; export const getEnvironmentStorage=()=>localStorage;');
    if (['/auth.js', '/api.js', '/terminalCommandDelivery.js', '/strictAuthBoundary.js', '/strictAuthenticatedFetch.js'].includes(req.url)) {
      const source = await readFile(new URL('.' + req.url, import.meta.url), 'utf8');
      return res.end(source.replace(/from '\.\/(auth|apiBase|remoteEnvironments|terminalCommandDelivery|strictAuthBoundary|strictAuthenticatedFetch)'/g, "from '/$1.js'"));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Synthetic auth fixture</title><script type="importmap">{"imports":{"@noble/hashes/sha256":"/noble/sha256.js","@noble/hashes/crypto":"/noble/crypto.js"}}</script><script type="module">import * as auth from "/auth.js"; import {apiFetch} from "/api.js"; window.auth=auth; window.apiFetch=apiFetch;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  managedPath = await managedChromiumPath();
  browser = await chromium.launch({ executablePath: managedPath, headless: true });
});
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });
beforeEach(async () => {
  requests = []; rawRequests = []; script = []; held = []; heldBodies = []; consumed = false; apiRequests = []; previewRequests = []; disconnectAfterConsumption = false; dropAlways = false;
  context = await browser.newContext();
  context.setDefaultTimeout(10000);
  first = await context.newPage(); second = await context.newPage();
  for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.auth); }
  await first.evaluate(({ initial, identity }) => { auth.setTokens(initial.access, initial.refresh); auth.setUser(identity); auth.setAuthInitializing(false); }, { initial, identity });
  await second.evaluate(() => auth.setAuthInitializing(false));
});
afterEach(async () => { await context?.close(); release(); for (const res of heldBodies.splice(0)) res.end('"synthetic-owner"}'); });

describe('refreshTokens across independent same-origin browser tabs', () => {
  it('rejects a legacy API response after another browser tab signs in', async () => {
    let releaseResponse;
    const gate = new Promise(resolve => { releaseResponse = resolve; });
    let started = false;
    await first.route('**/api/fixture', async route => {
      started = true;
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"owner":"synthetic-owner"}' });
    });
    await first.evaluate(() => {
      window.apiOutcome = 'pending';
      apiFetch('/api/fixture', { method: 'POST', body: { action: 'synthetic-work' } })
        .then(response => response.json()).then(value => { window.apiOutcome = value; }, error => { window.apiOutcome = { message: error.message, uncertain: error.outcomeUncertain }; });
    });
    try {
      await expect.poll(() => started).toBe(true);
      await second.evaluate(() => { auth.setTokens('synthetic-new-access', 'synthetic-new-refresh'); auth.setUser({ id: 'synthetic-new-owner' }); });
    } finally { releaseResponse(); }
    await first.waitForFunction(() => window.apiOutcome !== 'pending');
    expect(await first.evaluate(() => window.apiOutcome)).toEqual({ message: 'Authentication changed; request outcome may be unconfirmed', uncertain: true });
  });

  it('rejects a legacy API response body when another tab signs out during decoding', async () => {
    await first.evaluate(() => {
      window.apiOutcome = 'pending';
      apiFetch('/api/synthetic-delayed-json').then(response => {
        window.decoding = true;
        return response.json();
      }).then(value => { window.apiOutcome = value; }, error => { window.apiOutcome = { message: error.message }; });
    });
    await first.waitForFunction(() => window.decoding === true);
    await second.evaluate(() => auth.clearTokens(true));
    for (const res of heldBodies.splice(0)) res.end('"synthetic-owner"}');
    await first.waitForFunction(() => window.apiOutcome !== 'pending');
    expect(await first.evaluate(() => window.apiOutcome)).toEqual({ message: 'Authentication changed' });
  });

  it('rejects a legacy API response stream chunk after another tab signs out', async () => {
    await first.evaluate(() => {
      window.apiOutcome = 'pending';
      apiFetch('/api/synthetic-delayed-json').then(async response => {
        const reader = response.body.getReader();
        try {
          await reader.read();
          window.readingNext = true;
          return await reader.read();
        } finally { reader.releaseLock(); }
      }).then(value => { window.apiOutcome = value; }, error => { window.apiOutcome = { message: error.message }; });
    });
    await first.waitForFunction(() => window.readingNext === true);
    await second.evaluate(() => auth.clearTokens(true));
    for (const res of heldBodies.splice(0)) res.end('"synthetic-owner"}');
    await first.waitForFunction(() => window.apiOutcome !== 'pending');
    expect(await first.evaluate(() => window.apiOutcome)).toEqual({ message: 'Authentication changed' });
  });

  it('supports byte-oriented readers through the legacy response guard', async () => {
    await first.evaluate(() => {
      window.apiOutcome = 'pending';
      apiFetch('/api/synthetic-delayed-json').then(async response => {
        const reader = response.body.getReader({ mode: 'byob' });
        let text = '';
        try {
          for (;;) {
            const part = await reader.read(new Uint8Array(64));
            if (part.done) break;
            text += new TextDecoder().decode(part.value);
            window.readingNext = true;
          }
        } finally { reader.releaseLock(); }
        return text;
      }).then(value => { window.apiOutcome = value; }, error => { window.apiOutcome = { message: error.message }; });
    });
    await first.waitForFunction(() => window.readingNext === true);
    for (const res of heldBodies.splice(0)) res.end('"synthetic-owner"}');
    await first.waitForFunction(() => window.apiOutcome !== 'pending');
    expect(await first.evaluate(() => window.apiOutcome)).toBe('{"owner":"synthetic-owner"}');
  });
  it.each([429, 503])('warns and does not replay after an unconfirmed %s response', async status => {
    await first.evaluate(() => { auth.subscribeAuth(reason => { if (reason === 'refresh-uncertain') window.refreshWarning = true; }); });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(status); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh temporarily unavailable' });
    expect(await first.evaluate(() => window.refreshWarning)).toBe(true);
    await start(first); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  }, 15000);
  it.each([null, 'corrupt', ['valid', 42]])('refuses refresh when consumed-token history is malformed: %s', async value => {
    await first.evaluate(async value => {
      const request = indexedDB.open('terminal-v4-auth-coordination', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('refresh');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('refresh', 'readwrite');
        tx.objectStore('refresh').put(value, 'consumed');
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, value);
    await start(first);
    await expect.poll(async () => requests.length > 0 || (await snapshot(first)).outcome !== 'pending').toBe(true);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Local sign-in history is damaged; contact your administrator' });
    expect(requests).toEqual([]);
  });
  it.each(['undefined', 'sparse'])('refuses a stored %s consumed-token history', async kind => {
    await first.evaluate(async kind => {
      const request = indexedDB.open('terminal-v4-auth-coordination', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('refresh');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('refresh', 'readwrite');
        tx.objectStore('refresh').put(kind === 'sparse' ? new Array(2) : undefined, 'consumed');
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, kind);
    await start(first);
    await expect.poll(async () => requests.length > 0 || (await snapshot(first)).outcome !== 'pending').toBe(true);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Local sign-in history is damaged; contact your administrator' });
    expect(requests).toEqual([]);
  });

  it('accepts a valid legacy history without token-specific records', async () => {
    await first.evaluate(async () => {
      const request = indexedDB.open('terminal-v4-auth-coordination', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('refresh');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('refresh', 'readwrite');
        tx.objectStore('refresh').put(['older-token-fingerprint'], 'consumed');
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: rotated.access });
  });

  it.each([{ state: 'pending' }, { state: 'invalid' }, null, undefined])('rejects token history %j when the aggregate key is missing', async history => {
    await first.evaluate(async ({ refreshToken, history }) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken));
      const key = `history:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const request = indexedDB.open('terminal-v4-auth-coordination', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('refresh');
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('refresh', 'readwrite');
        tx.objectStore('refresh').put(history, key);
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { refreshToken: initial.refresh, history });
    await start(first);
    await expect.poll(async () => requests.length > 0 || (await snapshot(first)).outcome !== 'pending').toBe(true);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Local sign-in history is damaged; contact your administrator' });
    expect(requests).toEqual([]);
  });
  it('does not create a preview session after auth changes during refresh publication', async () => {
    await first.evaluate(() => {
      const unsubscribe = auth.subscribeAuth(() => { unsubscribe(); auth.clearTokens(true); });
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Authentication changed' });
    expect(previewRequests).toEqual([]);
  });

  it('does not replay an uncertain token after a new login with the same token', async () => {
    await first.route('**/api/auth/refresh', route => route.abort());
    await start(first); await finished(first);
    await first.evaluate(({ initial, identity }) => { auth.setTokens('synthetic-login-access', initial.refresh); auth.setUser(identity); }, { initial, identity });
    await first.unroute('**/api/auth/refresh');
    await start(first); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
    expect(requests).toEqual([]);
  }, 15000);

  it('does not restore credentials when logout interleaves with publication', async () => {
    await first.evaluate(() => {
      const set = Storage.prototype.setItem; let armed = true;
      Storage.prototype.setItem = function (key, value) {
        if (armed && String(value).includes('synthetic-rotated-access')) {
          armed = false; auth.clearTokens(true);
        }
        return set.call(this, key, value);
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Authentication changed' }, access: null, refresh: null, user: null });
  });

  it.each([
    ['Web Locks', 'signs out', null],
    ['IndexedDB fallback', 'signs out', null],
    ['Web Locks', 'starts another session for the same account', { access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', user: identity }],
    ['IndexedDB fallback', 'starts another session for the same account', { access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', user: identity }],
    ['Web Locks', 'signs in as another account', { access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', user: { id: 'synthetic-new-owner' } }],
    ['IndexedDB fallback', 'signs in as another account', { access: 'synthetic-new-access', refresh: 'synthetic-new-refresh', user: { id: 'synthetic-new-owner' } }],
  ])('preserves the current session with %s when another tab %s before a refresh write', async (mode, _description, replacement) => {
    const debuggerSession = await context.newCDPSession(first);
    await debuggerSession.send('Debugger.enable');
    try {
      await first.evaluate(mode => {
        if (mode === 'IndexedDB fallback') Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        const set = Storage.prototype.setItem; let armed = true;
        Storage.prototype.setItem = function (key, value) {
          if (armed && key === 'terminal_access_token' && value === 'synthetic-rotated-access') {
            armed = false;
            debugger;
          }
          return set.call(this, key, value);
        };
      }, mode);
      const paused = new Promise(resolve => debuggerSession.once('Debugger.paused', resolve));
      await start(first); await expect.poll(() => requests.length).toBe(1);
      release();
      let pauseTimeout;
      await Promise.race([
        paused,
        new Promise((_, reject) => { pauseTimeout = setTimeout(() => reject(new Error('Refresh did not reach the publication barrier')), 5000); }),
      ]).finally(() => clearTimeout(pauseTimeout));
      let timeout;
      const changed = await Promise.race([
        second.evaluate(value => {
          if (value) { auth.setTokens(value.access, value.refresh); auth.setUser(value.user); }
          else auth.clearTokens(true);
          return true;
        }, replacement),
        new Promise(resolve => { timeout = setTimeout(() => resolve(false), 3000); }),
      ]).finally(() => clearTimeout(timeout));
      await debuggerSession.send('Debugger.resume');
      expect(changed).toBe(true);
      await finished(first);
      const expected = replacement || { access: null, refresh: null, user: null };
      const observed = await Promise.all([
        snapshot(first),
        second.evaluate(() => ({ access: auth.getAccessToken(), refresh: auth.getRefreshToken(), user: auth.getUser() })),
      ]);
      if (replacement) {
        await second.evaluate(() => apiFetch('/api/fixture', { method: 'POST', body: { action: 'synthetic-new-owner-work' } }));
      }
      expect({ observed, authorizations: apiRequests.map(request => request.authorization) }).toEqual({
        observed: [{ outcome: { error: 'Authentication changed' }, ...expected }, expected],
        authorizations: replacement ? [`Bearer ${replacement.access}`] : [],
      });
    } finally {
      await debuggerSession.send('Debugger.resume').catch(() => {});
      await debuggerSession.send('Debugger.disable').catch(() => {});
      await debuggerSession.detach().catch(() => {});
    }
  }, 15000);

  it('waits for the access token to catch up with a rotated refresh token', async () => {
    await second.evaluate(() => {
      const get = Storage.prototype.getItem;
      window.staleAccessReadsAfterRotation = 0;
      Storage.prototype.getItem = function (key) {
        if (key !== 'terminal_access_token') return get.call(this, key);
        if (get.call(this, 'terminal_refresh_token') === 'synthetic-rotated-refresh') {
          window.staleAccessReadsAfterRotation += 1;
          if (window.staleAccessReadsAfterRotation > 3) return get.call(this, key);
        }
        return 'synthetic-expired-access';
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second); release(); await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(await second.evaluate(() => window.staleAccessReadsAfterRotation)).toBeGreaterThan(3);
    expect(requests.length).toBe(1);
  });

  it('never returns an old access token when a rotated pair stays stale', async () => {
    await second.evaluate(() => {
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        return key === 'terminal_access_token' ? 'synthetic-expired-access' : get.call(this, key);
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second); release(); await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
    expect(requests.length).toBe(1);
  }, 15000);

  it('reuses a rotated pair once the access-token view catches up', async () => {
    await second.evaluate(() => {
      const get = Storage.prototype.getItem;
      window.thawAccess = () => { window.accessThawed = true; };
      Storage.prototype.getItem = function (key) {
        if (key === 'terminal_refresh_token' && get.call(this, key) === 'synthetic-rotated-refresh') window.observedRotatedRefresh = true;
        return key === 'terminal_access_token' && !window.accessThawed ? 'synthetic-expired-access' : get.call(this, key);
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second); release(); await finished(first);
    await second.waitForFunction(() => window.observedRotatedRefresh);
    await second.evaluate(() => thawAccess());
    await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(requests.length).toBe(1);
  });

  it('allows a lagging access view to catch up after a slow refresh', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await second.evaluate(() => {
      const get = Storage.prototype.getItem;
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => { window.coordinationStarted = true; return open(...args); };
      window.thawAccess = () => { window.accessThawed = true; };
      Storage.prototype.getItem = function (key) {
        if (key === 'terminal_refresh_token' && get.call(this, key) === 'synthetic-rotated-refresh') window.observedRotatedRefresh = true;
        return key === 'terminal_access_token' && !window.accessThawed ? 'synthetic-expired-access' : get.call(this, key);
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second); await second.waitForFunction(() => window.coordinationStarted);
    await new Promise(resolve => setTimeout(resolve, 3200));
    release(); await finished(first);
    await second.waitForFunction(() => window.observedRotatedRefresh);
    await second.evaluate(() => thawAccess());
    await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(requests.length).toBe(1);
  }, 15000);

  it('refreshes a new login after a proven non-rotating success with the same token', async () => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(200, { tokens: { accessToken: rotated.access, refreshToken: initial.refresh } }); await finished(first);
    await first.evaluate(({ initial, identity }) => { auth.setTokens('synthetic-login-access', initial.refresh); auth.setUser(identity); }, { initial, identity });
    consumed = false;
    await start(first); await expect.poll(() => requests.length).toBe(2);
    release(200, { tokens: { accessToken: 'synthetic-next-access', refreshToken: initial.refresh } }); await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: 'synthetic-next-access' });
  });

  it.each(['fallback', 'web-locks', 'first-fallback', 'second-fallback'])('shares concurrent non-rotating refresh under %s', async mode => {
    if (mode === 'fallback' || mode === 'first-fallback') await first.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    if (mode === 'fallback' || mode === 'second-fallback') await second.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(200, { tokens: { accessToken: rotated.access, refreshToken: initial.refresh } });
    await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it.each(['fallback', 'web-locks'])('shares an explicitly published unchanged token pair under %s', async mode => {
    if (mode === 'fallback') for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(200, { tokens: { accessToken: initial.access, refreshToken: initial.refresh } });
    await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: initial.access });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it.each(['first-fallback', 'second-fallback'])('waits for a non-rotating publication in a lagging view under %s', async mode => {
    const fallback = mode === 'first-fallback' ? first : second;
    await fallback.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await second.evaluate(() => {
      const keys = ['terminal_access_token', 'terminal_refresh_token', 'terminal_auth_refresh_publication'], getItem = Storage.prototype.getItem, view = {};
      for (const key of keys) view[key] = getItem.call(localStorage, key);
      window.thaw = () => { window.thawed = true; };
      Storage.prototype.getItem = function (key) { return !window.thawed && key in view ? view[key] : getItem.call(this, key); };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second); release(200, { tokens: { accessToken: rotated.access, refreshToken: initial.refresh } });
    await finished(first);
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    await second.evaluate(() => thaw()); await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('keeps the reservation when publication fails after a non-rotating success', async () => {
    await first.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'terminal_auth_refresh_publication') throw new Error('Synthetic publication failure');
        return setItem.call(this, key, value);
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(200, { tokens: { accessToken: initial.access, refreshToken: initial.refresh } });
    await finished(first); await start(second); await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  }, 15000);

  it('allows a later refresh after an unchanged pair was published', async () => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(200, { tokens: { accessToken: initial.access, refreshToken: initial.refresh } }); await finished(first);
    consumed = false;
    await start(second); await expect.poll(() => requests.length).toBe(2);
    release(200, { tokens: { accessToken: rotated.access, refreshToken: initial.refresh } }); await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ accessToken: rotated.access });
    expect(requests).toEqual([{ refreshToken: initial.refresh }, { refreshToken: initial.refresh }]);
  });
  it.each(['fallback', 'web-locks'])('does not replay after the consumed-ledger transaction aborts under %s', async mode => {
    if (mode === 'fallback') for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await second.evaluate(() => {
      const getItem = Storage.prototype.getItem, view = {};
      for (const key of ['terminal_access_token', 'terminal_refresh_token']) view[key] = getItem.call(localStorage, key);
      Storage.prototype.getItem = function (key) { return key in view ? view[key] : getItem.call(this, key); };
    });
    await first.evaluate(() => {
      const put = IDBObjectStore.prototype.put; let writes = 0;
      IDBObjectStore.prototype.put = function (value, key) {
        const request = put.call(this, value, key);
        if (key === 'consumed' && ++writes === 2) this.transaction.abort();
        return request;
      };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Cross-tab token refresh coordination lost' }, ...initial, user: identity });
    await second.reload(); await second.waitForFunction(() => window.auth);
    await start(second);
    await expect.poll(async () => requests.length > 1 || (await snapshot(second)).outcome !== 'pending', { timeout: 5000 }).toBe(true);
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });
  it('reuses a rotation when a waiting tab captured its access token before its refresh token', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    // Simulate observing the access write in the middle of another tab's two-key rotation.
    await second.evaluate(access => localStorage.setItem('terminal_access_token', access), rotated.access);
    await start(second);
    // The waiting tab has captured the mixed pair; let the owner finish its normal guarded write.
    await second.evaluate(access => localStorage.setItem('terminal_access_token', access), initial.access);
    release(); await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('serializes rotating refresh tokens across tabs when HTTP has no Web Locks', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(); await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('does not replay a consumed refresh token while another tab\'s rotation has not reached this tab\'s storage view', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await second.evaluate(() => {
      const lagging = new Set(['terminal_access_token', 'terminal_refresh_token']), getItem = Storage.prototype.getItem, view = {};
      for (const key of lagging) view[key] = getItem.call(localStorage, key);
      window.thaw = () => { window.thawed = true; };
      Storage.prototype.getItem = function (key) { return !window.thawed && lagging.has(key) ? view[key] : getItem.call(this, key); };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(); await finished(first);
    await second.waitForTimeout(300);
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    await second.evaluate(() => thaw()); await finished(second);
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it.each(['web-locks', 'first-fallback', 'second-fallback'])('does not replay a consumed token with a stale storage view under %s', async mode => {
    if (mode === 'first-fallback') await first.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    if (mode === 'second-fallback') await second.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await second.evaluate(() => {
      const lagging = new Set(['terminal_access_token', 'terminal_refresh_token']), getItem = Storage.prototype.getItem, view = {};
      for (const key of lagging) view[key] = getItem.call(localStorage, key);
      window.thaw = () => { window.thawed = true; };
      Storage.prototype.getItem = function (key) { return !window.thawed && lagging.has(key) ? view[key] : getItem.call(this, key); };
    });
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(); await finished(first);
    await second.waitForTimeout(300);
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
    await second.evaluate(() => thaw()); await finished(second);
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it('fails closed when IndexedDB is unavailable even if Web Locks exists', async () => {
    await first.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
    await start(first);
    await expect.poll(async () => requests.length > 0 || (await snapshot(first)).outcome !== 'pending').toBe(true);
    if (requests.length) { release(); await finished(first); }
    expect(requests).toEqual([]);
    expect((await snapshot(first)).outcome.error).toBeTruthy();
  });

  it('reuses a completed rotation when the provider keeps the same access token', async () => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    release(200, { tokens: { accessToken: initial.access, refreshToken: rotated.refresh } });
    await Promise.all([finished(first), finished(second)]);
    expect(await snapshot(second)).toEqual({ outcome: { accessToken: initial.access }, access: initial.access, refresh: rotated.refresh, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }]);
  });

  it.each(['account', 'same-account-login'])('fences %s while an HTTP tab waits for the refresh transaction', async change => {
    for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    await start(second);
    await second.evaluate(change => {
      auth.setTokens('synthetic-new-login-access', 'synthetic-new-login-refresh');
      auth.setUser({ id: change === 'account' ? 'synthetic-other-owner' : 'synthetic-owner' });
    }, change);
    release(); await Promise.all([finished(first), finished(second)]);
    expect((await snapshot(second)).outcome).toEqual({ error: 'Authentication changed' });
    expect(await second.evaluate(() => ({ access: auth.getAccessToken(), refresh: auth.getRefreshToken() }))).toEqual({ access: 'synthetic-new-login-access', refresh: 'synthetic-new-login-refresh' });
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

  it.each(['fallback', 'web-locks'])('does not publish tokens when %s coordination aborts as the refresh JSON settles', async mode => {
    await first.evaluate(mode => {
      if (mode === 'fallback') Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
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
    }, mode);
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

  it.each(['fallback', 'web-locks'])('keeps the reservation after route abort under %s', async mode => {
    if (mode === 'fallback') for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await first.route('**/api/auth/refresh', route => route.abort());
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Token refresh outcome uncertain; sign in again' }, ...initial, user: identity });
    await start(second); await finished(second);
    expect((await snapshot(second)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
    expect(requests).toEqual([]);
  }, 15000);

  it.each(['fallback', 'web-locks'])('does not replay after server consumption and disconnect across tabs and browser restart under %s', async mode => {
    const profile = await mkdtemp(join(tmpdir(), 'auth-refresh-'));
    await context.close();
    const open = () => chromium.launchPersistentContext(profile, { executablePath: managedPath, headless: true });
    try {
      context = await open();
      first = await context.newPage(); second = await context.newPage();
      for (const page of [first, second]) {
        await page.goto(origin); await page.waitForFunction(() => window.auth);
        if (mode === 'fallback') await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
      }
      await first.evaluate(({ initial, identity }) => { auth.setTokens(initial.access, initial.refresh); auth.setUser(identity); auth.setAuthInitializing(false); }, { initial, identity });
      disconnectAfterConsumption = true;
      await first.route('**/api/auth/refresh', async route => { await route.fetch(); await route.abort(); });
      await first.evaluate(() => {
        const nativeFetch = window.fetch;
        window.fetch = (...args) => nativeFetch(...args).catch(error => { window.fetchRejected = true; throw error; });
      });
      await start(first); await finished(first);
      expect(await first.evaluate(() => window.fetchRejected)).toBe(true);
      expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
      await start(second); await finished(second);
      expect((await snapshot(second)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
      await context.close();
      context = await open();
      first = await context.newPage(); await first.goto(origin); await first.waitForFunction(() => window.auth);
      if (mode === 'fallback') await first.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
      await start(first); await finished(first);
      expect(await snapshot(first)).toEqual({ outcome: { error: 'Token refresh outcome uncertain; sign in again' }, ...initial, user: identity });
      expect(requests).toEqual([{ refreshToken: initial.refresh }, { refreshToken: initial.refresh }]);
      await first.evaluate(() => auth.setTokens('synthetic-new-access', 'synthetic-new-refresh'));
      consumed = false; disconnectAfterConsumption = false;
      await start(first); await expect.poll(() => requests.length).toBe(3);
      release(); await finished(first);
      expect((await snapshot(first)).outcome).toEqual({ accessToken: rotated.access });
      expect(requests).toEqual([{ refreshToken: initial.refresh }, { refreshToken: initial.refresh }, { refreshToken: 'synthetic-new-refresh' }]);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  }, 25000);

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

  it.each(['fallback', 'web-locks'])('does not lock a session out under %s when a server returns the same refresh token', async mode => {
    if (mode === 'fallback') for (const page of [first, second]) await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(200, { tokens: { accessToken: rotated.access, refreshToken: initial.refresh } });
    await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: rotated.access });
    consumed = false;
    await start(first); await expect.poll(() => requests.length).toBe(2);
    release(200, { tokens: { accessToken: 'synthetic-second-access', refreshToken: initial.refresh } });
    await finished(first);
    expect((await snapshot(first)).outcome).toEqual({ accessToken: 'synthetic-second-access' });
    expect(requests).toEqual([{ refreshToken: initial.refresh }, { refreshToken: initial.refresh }]);
  });
});

const PAIR_KEY = 'terminal_auth_pair_seq';
const pairSeq = page => page.evaluate(key => localStorage.getItem(key), PAIR_KEY);
const newerPair = { access: 'synthetic-other-tab-access', refresh: 'synthetic-other-tab-refresh' };
const publishFromOtherTab = (page, pair = newerPair) => page.evaluate(pair => { localStorage.setItem('terminal_access_token', pair.access); localStorage.setItem('terminal_refresh_token', pair.refresh); }, pair);
const rotatedBody = (seq) => ({ tokens: { accessToken: rotated.access, refreshToken: rotated.refresh }, ...(seq === undefined ? {} : { session: { id: 's', pairSeq: seq, pairBinding: true } }) });

describe('refreshTokens session-pair protocol', () => {
  it('sends the current access token and opts in to pair binding', async () => {
    await start(first); await expect.poll(() => requests.length).toBe(1);
    release(); await finished(first);
    expect(rawRequests).toEqual([{ refreshToken: initial.refresh, accessToken: initial.access, pairBinding: true, requestId: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
  });

  it('stores the returned pairSeq with the rotated tokens', async () => {
    script.push(async () => ({ status: 200, body: rotatedBody(4) }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(await pairSeq(first)).toBe('4');
  });

  it('keeps today\'s behaviour and stores no pairSeq when the server omits session', async () => {
    await first.evaluate(key => localStorage.setItem(key, '9'), PAIR_KEY);
    script.push(async () => ({ status: 200, body: rotatedBody() }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(await pairSeq(first)).toBe(null);
  });

  it('adopts the newer pair from another tab on pair_mismatch without clearing', async () => {
    script.push(async () => { await publishFromOtherTab(second); return { status: 409, body: { error: 'mismatch', code: 'pair_mismatch' } }; });
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: newerPair.access }, access: newerPair.access, refresh: newerPair.refresh, user: identity });
    expect(requests.length).toBe(1);
  });

  it('does not consume the token on pair_mismatch when no newer pair appears', async () => {
    script.push(async () => ({ status: 409, body: { error: 'mismatch', code: 'pair_mismatch' } }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Token refresh pair mismatch; try again' }, ...initial, user: identity });
    script.push(async () => ({ status: 200, body: rotatedBody(2) }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
    expect(requests).toEqual([{ refreshToken: initial.refresh }, { refreshToken: initial.refresh }]);
  }, 15000);

  it('retries once with the current access token on pair_required', async () => {
    await first.evaluate(() => localStorage.removeItem('terminal_access_token'));
    script.push(async () => { await first.evaluate(() => localStorage.setItem('terminal_access_token', 'synthetic-late-access')); return { status: 428, body: { error: 'required', code: 'pair_required' } }; });
    script.push(async () => ({ status: 200, body: rotatedBody(3) }));
    await start(first); await finished(first);
    expect(rawRequests).toEqual([
      { refreshToken: initial.refresh, pairBinding: true, requestId: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { refreshToken: initial.refresh, accessToken: 'synthetic-late-access', pairBinding: true, requestId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
  });

  it('retries a lost response once with the same request id so the server can replay it', async () => {
    script.push(async () => ({ drop: true }));
    script.push(async () => ({ status: 200, body: rotatedBody(2) }));
    await start(first); await finished(first);
    expect(rawRequests.map(({ requestId }) => requestId)).toEqual([rawRequests[0].requestId, rawRequests[0].requestId]);
    expect(rawRequests[0].requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: rotated.access }, ...rotated, user: identity });
  });

  it('gives up as uncertain when the retry of a lost response also fails', async () => {
    dropAlways = true;
    await start(first); await finished(first);
    expect(rawRequests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rawRequests.map(({ requestId }) => requestId)).size).toBe(1);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh outcome uncertain; sign in again' });
  });

  it('retries pair_required only once and keeps the tokens', async () => {
    await first.evaluate(() => localStorage.removeItem('terminal_access_token'));
    const again = async () => { await first.evaluate(() => localStorage.setItem('terminal_access_token', 'synthetic-late-access')); return { status: 428, body: { code: 'pair_required' } }; };
    script.push(again, async () => ({ status: 428, body: { code: 'pair_required' } }));
    await start(first); await finished(first);
    expect(requests.length).toBe(2);
    expect((await snapshot(first)).refresh).toBe(initial.refresh);
    expect((await snapshot(first)).outcome).toEqual({ error: 'Token refresh temporarily unavailable' });
  });

  it('reuses the newer pair on refresh_token_spent without clearing tokens', async () => {
    script.push(async () => { await publishFromOtherTab(second); return { status: 401, body: { error: 'spent', code: 'refresh_token_spent' } }; });
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { accessToken: newerPair.access }, access: newerPair.access, refresh: newerPair.refresh, user: identity });
    expect(requests.length).toBe(1);
  });

  it('keeps the tokens when refresh_token_spent has no newer pair', async () => {
    script.push(async () => ({ status: 401, body: { error: 'spent', code: 'refresh_token_spent' } }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Token refresh outcome uncertain; sign in again' }, ...initial, user: identity });
  }, 15000);

  it('clears tokens on invalid_refresh_token', async () => {
    script.push(async () => ({ status: 401, body: { error: 'invalid', code: 'invalid_refresh_token' } }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Token refresh failed' }, access: null, refresh: null, user: null });
  });

  it('reports upgrade required on 426 without clearing or looping', async () => {
    script.push(async () => ({ status: 426, body: { error: 'upgraded client required' } }));
    await start(first); await finished(first);
    expect(await snapshot(first)).toEqual({ outcome: { error: 'Upgrade required; sign in again' }, ...initial, user: identity });
    expect(requests.length).toBe(1);
  });
});
