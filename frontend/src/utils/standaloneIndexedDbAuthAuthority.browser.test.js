import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;

beforeAll(async () => {
  const out = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: process.cwd(), encoding: 'utf8',
    input: JSON.stringify({ root: process.cwd(), entry: `import { createBrowserAuthAuthority, createStandaloneIndexedDbAuthAuthority } from './src/utils/standaloneIndexedDbAuthAuthority.js'; window.authority = createStandaloneIndexedDbAuthAuthority({ verifyLogoutReceipt: async ({ receipt }) => receipt === 'synthetic-server-complete' }); window.browserAuthority = createBrowserAuthAuthority({ verifyLogoutReceipt: async ({ receipt }) => receipt === 'synthetic-server-complete', verifyLoginFailureReceipt: async ({ receipt }) => receipt === 'synthetic-no-session' }); window.unverifiedAuthority = createStandaloneIndexedDbAuthAuthority();` }),
  });
  const moduleSource = JSON.parse(out).find(file => file.path.endsWith('.js')).text;
  server = createServer((req, res) => {
    if (req.url === '/authority.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end(moduleSource);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<script src="/authority.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('standalone auth authority in independent browser tabs', () => {
  it('releases a newer login after an exact no-session receipt for an older attempt', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const old = await first.evaluate(() => browserAuthority.beginLogin('https://home.example/'));
      await first.evaluate(intent => browserAuthority.claimLogin(intent), old.intent);
      const fresh = await second.evaluate(() => browserAuthority.beginLogin('https://home.example/'));
      await second.evaluate(intent => browserAuthority.claimLogin(intent), fresh.intent);
      const pair = { session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', home: 'https://home.example/', logoutCapability: 'b'.repeat(64) };
      const waiting = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'fixture' }), { intent: fresh.intent, pair });
      expect(waiting.status).toBe('login-recovery-pending');
      await first.close();
      expect(await second.evaluate(intent => browserAuthority.completeLoginFailure(intent, 'unconfirmed'), old.intent)).toEqual({ status: 'unconfirmed' });
      expect((await second.evaluate(() => browserAuthority.read())).status).toBe('login-recovery-pending');
      expect(await second.evaluate(intent => browserAuthority.completeLoginFailure(intent, 'synthetic-no-session'), old.intent)).toEqual({ status: 'no-session' });
      expect(await second.evaluate(() => browserAuthority.read())).toMatchObject({ status: 'active', pair: { session: pair.session, owner: pair.owner } });
    } finally { await context.close(); }
  }, 30000);

  it('recovers a superseded dispatched login after its tab closes', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const oldPair = { session: 'old-session', accessToken: 'old-access', refreshToken: 'old-refresh', owner: 'old-owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const oldIntent = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      const oldClaim = await first.evaluate(intent => browserAuthority.claimLogin(intent), oldIntent.intent);
      const newPair = { session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', home: 'https://home.example/', logoutCapability: 'b'.repeat(64) };
      const next = await second.evaluate(home => browserAuthority.beginLogin(home), newPair.home);
      await second.evaluate(intent => browserAuthority.claimLogin(intent), next.intent);
      const waiting = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'new-user' }), { intent: next.intent, pair: newPair });
      expect(waiting.status).toBe('login-recovery-pending');
      await first.close();
      expect(await second.evaluate(intent => browserAuthority.resumeLogin(intent), oldIntent.intent)).toMatchObject({ status: 'unresolved', operationKey: oldClaim.operationKey });
      expect((await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, null), { intent: oldIntent.intent, pair: oldPair })).status).toBe('retirement-pending');
      const retirement = (await second.evaluate(() => browserAuthority.pendingRetirements())).retirements[0];
      expect(await second.evaluate(({ incarnation, operation }) => browserAuthority.completeRetirement(incarnation, operation, 'synthetic-server-complete'), retirement)).toEqual({ status: 'retired' });
      expect(await second.evaluate(() => browserAuthority.read())).toMatchObject({ status: 'active', pair: { session: newPair.session, owner: newPair.owner } });
    } finally { await context.close(); }
  }, 30000);

  it('rejects a stale logout after another tab starts a new login', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const oldPair = { session: 'old-session', accessToken: 'old-access', refreshToken: 'old-refresh', owner: 'old-owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const oldIntent = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      await first.evaluate(intent => browserAuthority.claimLogin(intent), oldIntent.intent);
      const old = await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'old-user' }), { intent: oldIntent.intent, pair: oldPair });
      const nextIntent = await second.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      expect(await first.evaluate(({ incarnation, controlRevision }) => browserAuthority.beginLogout(incarnation, controlRevision), old)).toEqual({ status: 'conflict' });
      const newPair = { ...oldPair, session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', logoutCapability: 'b'.repeat(64) };
      await second.evaluate(intent => browserAuthority.claimLogin(intent), nextIntent.intent);
      const next = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'new-user' }), { intent: nextIntent.intent, pair: newPair });
      expect(next.status).toBe('retirement-pending');
      expect(await first.evaluate(({ incarnation, controlRevision }) => browserAuthority.beginLogout(incarnation, controlRevision), next)).toEqual({ status: 'conflict' });
    } finally { await context.close(); }
  }, 30000);

  it('retains an old session retirement across tabs before exposing a replacement', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const oldPair = { session: 'old-session', accessToken: 'old-access', refreshToken: 'old-refresh', owner: 'old-owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const oldIntent = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      await first.evaluate(intent => browserAuthority.claimLogin(intent), oldIntent.intent);
      const old = await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'old-user' }), { intent: oldIntent.intent, pair: oldPair });
      const newPair = { session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', home: 'https://home.example/', logoutCapability: 'b'.repeat(64) };
      const nextIntent = await second.evaluate(home => browserAuthority.beginLogin(home), newPair.home);
      await second.evaluate(intent => browserAuthority.claimLogin(intent), nextIntent.intent);
      const next = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'new-user' }), { intent: nextIntent.intent, pair: newPair });
      expect(next.status).toBe('retirement-pending');
      expect(JSON.stringify(await first.evaluate(() => browserAuthority.read()))).not.toContain(newPair.accessToken);
      await first.close();
      const pending = await second.evaluate(() => browserAuthority.pendingRetirements());
      expect(pending.retirements).toMatchObject([{ incarnation: old.incarnation, session: oldPair.session, logoutCapability: oldPair.logoutCapability }]);
      const retired = await second.evaluate(({ incarnation, operation }) => browserAuthority.completeRetirement(incarnation, operation, 'synthetic-server-complete'), pending.retirements[0]);
      expect(retired).toEqual({ status: 'retired' });
      expect(await second.evaluate(() => browserAuthority.read())).toMatchObject({ status: 'active', pair: { session: newPair.session, owner: newPair.owner, accessToken: newPair.accessToken } });
    } finally { await context.close(); }
  }, 30000);

  it('resumes the same strict logout after its originating tab closes', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const pair = { session: 'session', accessToken: 'access', refreshToken: 'refresh', owner: 'owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const intent = await first.evaluate(home => browserAuthority.beginLogin(home), pair.home);
      await first.evaluate(value => browserAuthority.claimLogin(value), intent.intent);
      const login = await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'fixture' }), { intent: intent.intent, pair });
      const started = await first.evaluate(({ incarnation, controlRevision }) => browserAuthority.beginLogout(incarnation, controlRevision), login);
      await first.close();
      const visible = await second.evaluate(() => browserAuthority.read());
      expect(JSON.stringify(visible)).not.toContain(pair.logoutCapability);
      const resumed = await second.evaluate(incarnation => browserAuthority.resumeLogout(incarnation), login.incarnation);
      expect(resumed).toMatchObject({ operation: started.operation, logoutCapability: pair.logoutCapability, session: pair.session, owner: pair.owner, home: pair.home });
      const result = await second.evaluate(({ revision, incarnation, operation }) => browserAuthority.finishLogout(revision, incarnation, operation, 'synthetic-server-complete'), resumed);
      expect(result.status).toBe('tombstone');
    } finally { await context.close(); }
  }, 30000);

  it('isolates the strict browser session from the legacy prototype database', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      const pair = { session: 'legacy-session', accessToken: 'legacy-access', refreshToken: 'legacy-refresh', owner: 'legacy-owner', home: 'https://home.example/' };
      await first.evaluate(() => authority.provision());
      const initial = await first.evaluate(() => authority.read());
      await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      expect(await second.evaluate(() => browserAuthority.read())).toEqual({ status: 'unavailable' });
      await second.evaluate(() => browserAuthority.provision());
      const newPair = { ...pair, session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', logoutCapability: 'b'.repeat(64) };
      const intent = await second.evaluate(home => browserAuthority.beginLogin(home), newPair.home);
      await second.evaluate(value => browserAuthority.claimLogin(value), intent.intent);
      const current = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'new-user' }), { intent: intent.intent, pair: newPair });
      expect(await first.evaluate(() => browserAuthority.read())).toEqual(current);
      expect(await first.evaluate(() => authority.read())).toMatchObject({ pair });
    } finally { await context.close(); }
  }, 30000);

  it('does not silently recreate the strict authority after its storage disappears', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const pair = { session: 'session', accessToken: 'access', refreshToken: 'refresh', owner: 'owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const intent = await first.evaluate(home => browserAuthority.beginLogin(home), pair.home);
      await first.evaluate(value => browserAuthority.claimLogin(value), intent.intent);
      await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'fixture' }), { intent: intent.intent, pair });
      await first.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('terminal-v4-browser-auth-authority-v2'); request.onsuccess = resolve; request.onerror = () => reject(request.error); }));
      expect(await second.evaluate(() => browserAuthority.read())).toEqual({ status: 'unavailable' });
      expect(await second.evaluate(home => browserAuthority.beginLogin(home), pair.home)).toEqual({ status: 'unavailable' });
      expect(await second.evaluate(() => indexedDB.databases())).toEqual([]);
    } finally { await context.close(); }
  }, 30000);

  it('orders overlapping sign-in intents and cancels a late login on sign-out', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const oldPair = { session: 'old-session', accessToken: 'old-access', refreshToken: 'old-refresh', owner: 'old-owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const newPair = { session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', home: 'https://home.example/', logoutCapability: 'b'.repeat(64) };
      const oldIntent = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      const newIntent = await second.evaluate(home => browserAuthority.beginLogin(home), newPair.home);
      await second.evaluate(intent => browserAuthority.claimLogin(intent), newIntent.intent);
      const current = await second.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'new-user' }), { intent: newIntent.intent, pair: newPair });
      expect(await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'old-user' }), { intent: oldIntent.intent, pair: oldPair })).toEqual({ status: 'conflict' });
      expect(await first.evaluate(() => browserAuthority.readWithUser())).toEqual(current);
      const pending = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      const scope = await second.evaluate(() => browserAuthority.read());
      const closing = await second.evaluate(({ incarnation, controlRevision }) => browserAuthority.beginLogout(incarnation, controlRevision), scope);
      const tombstone = await second.evaluate(({ revision, incarnation, operation }) => browserAuthority.finishLogout(revision, incarnation, operation, 'synthetic-server-complete'), closing);
      expect(await first.evaluate(({ intent, pair }) => browserAuthority.loginWithUser(intent, pair, { id: pair.owner, username: 'old-user' }), { intent: pending.intent, pair: oldPair })).toEqual({ status: 'conflict' });
      expect(await first.evaluate(() => browserAuthority.readWithUser())).toEqual(tombstone);
    } finally { await context.close(); }
  }, 30000);

  it('keeps a new account and its credentials together when a stale refresh finishes', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.browserAuthority); }
      await first.evaluate(() => browserAuthority.provision());
      const oldPair = { session: 'old-session', accessToken: 'old-access', refreshToken: 'old-refresh', owner: 'old-owner', home: 'https://home.example/', logoutCapability: 'a'.repeat(64) };
      const oldUser = { id: 'old-owner', username: 'old-user', created_at: '2026-01-01' };
      const intent = await first.evaluate(home => browserAuthority.beginLogin(home), oldPair.home);
      await first.evaluate(value => browserAuthority.claimLogin(value), intent.intent);
      const login = await first.evaluate(({ intent, pair, user }) => browserAuthority.loginWithUser(intent, pair, user), { intent: intent.intent, pair: oldPair, user: oldUser });
      const reserved = await first.evaluate(revision => browserAuthority.reserveRefresh(revision), login.revision);
      const started = await second.evaluate(({ incarnation, controlRevision }) => browserAuthority.beginLogout(incarnation, controlRevision), login);
      await second.evaluate(({ revision, incarnation, operation }) => browserAuthority.finishLogout(revision, incarnation, operation, 'synthetic-server-complete'), started);
      const newPair = { session: 'new-session', accessToken: 'new-access', refreshToken: 'new-refresh', owner: 'new-owner', home: 'https://home.example/', logoutCapability: 'b'.repeat(64) };
      const newUser = { id: 'new-owner', username: 'new-user', created_at: '2026-02-01' };
      const newIntent = await second.evaluate(home => browserAuthority.beginLogin(home), newPair.home);
      await second.evaluate(value => browserAuthority.claimLogin(value), newIntent.intent);
      const current = await second.evaluate(({ intent, pair, user }) => browserAuthority.loginWithUser(intent, pair, user), { intent: newIntent.intent, pair: newPair, user: newUser });
      const late = await first.evaluate(({ revision, reservation, pair }) => browserAuthority.completeRefresh(revision, reservation, pair), { revision: reserved.revision, reservation: reserved.reservation, pair: { ...oldPair, accessToken: 'old-rotated', refreshToken: 'old-rotated-refresh' } });
      expect(late).toEqual({ status: 'conflict' });
      expect(await first.evaluate(() => browserAuthority.readWithUser())).toEqual(current);
      const { logoutCapability: _secret, ...visiblePair } = newPair;
      expect(current).toMatchObject({ status: 'active', pair: visiblePair, user: newUser });
      expect(JSON.stringify(current)).not.toContain(newPair.logoutCapability);
    } finally { await context.close(); }
  }, 30000);

  it('does not recreate deleted history during ordinary reads in another tab', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.authority); }
      expect(await first.evaluate(() => authority.read())).toEqual({ status: 'unavailable' });
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const initial = await first.evaluate(() => authority.read());
      const pair = { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' };
      const login = await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      expect((await first.evaluate(revision => authority.reserveRefresh(revision), login.revision)).status).toBe('reserved');
      await first.evaluate(() => new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('terminal-v4-standalone-auth-authority'); request.onsuccess = resolve; request.onerror = () => reject(request.error); }));
      expect(await second.evaluate(() => authority.read())).toEqual({ status: 'unavailable' });
      expect(await second.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair })).toEqual({ status: 'unavailable' });
      expect(await second.evaluate(() => indexedDB.databases())).toEqual([]);
    } finally { await context.close(); }
  }, 30000);

  it('serializes refresh reservations and rejects a late completion after logout', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) {
        await page.goto(origin);
        await page.waitForFunction(() => window.authority);
      }
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const initial = await first.evaluate(() => authority.read());
      const pair = { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' };
      const login = await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      const reservations = await Promise.all([first, second].map(page => page.evaluate(revision => authority.reserveRefresh(revision), login.revision)));
      expect(reservations.map(result => result.status).sort()).toEqual(['conflict', 'reserved']);
      const reserved = reservations.find(result => result.status === 'reserved');
      const started = await second.evaluate(incarnation => authority.beginLogout(incarnation), login.incarnation);
      expect(started.status).toBe('started');
      expect(await first.evaluate(({ revision, reservation, pair }) => authority.completeRefresh(revision, reservation, pair), {
        revision: reserved.revision, reservation: reserved.reservation, pair: { ...pair, accessToken: 'synthetic-rotated' },
      })).toEqual({ status: 'conflict' });
      const logout = await second.evaluate(({ revision, incarnation, operation }) => authority.finishLogout(revision, incarnation, operation, 'synthetic-server-complete'), started);
      expect(logout.status).toBe('tombstone');
      expect(await first.evaluate(() => authority.read())).toEqual(logout);
    } finally { await context.close(); }
  }, 30000);

  it('allows another reservation after a confirmed nonrotating refresh', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) {
        await page.goto(origin);
        await page.waitForFunction(() => window.authority);
      }
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const initial = await first.evaluate(() => authority.read());
      const pair = { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' };
      const login = await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      const reserved = await first.evaluate(revision => authority.reserveRefresh(revision), login.revision);
      const completed = await first.evaluate(({ revision, reservation, pair }) => authority.completeRefresh(revision, reservation, pair), {
        revision: reserved.revision, reservation: reserved.reservation, pair: { ...pair, accessToken: 'synthetic-updated-access' },
      });
      expect((await second.evaluate(revision => authority.reserveRefresh(revision), completed.revision)).status).toBe('reserved');
    } finally { await context.close(); }
  }, 30000);

  it('keeps the session bound during a cross-tab refresh', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.authority); }
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const initial = await first.evaluate(() => authority.read());
      const pair = { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' };
      const login = await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      const reserved = await first.evaluate(revision => authority.reserveRefresh(revision), login.revision);
      for (const change of [{ owner: 'other-owner' }, { home: 'https://other.example/' }]) {
        expect(await second.evaluate(({ revision, reservation, pair }) => authority.completeRefresh(revision, reservation, pair), {
          revision: reserved.revision, reservation: reserved.reservation, pair: { ...pair, ...change },
        })).toEqual({ status: 'conflict' });
      }
      const bad = { ...pair, session: 'other-session', accessToken: 'rotated-access', refreshToken: 'rotated-refresh' };
      expect(await second.evaluate(({ revision, reservation, pair }) => authority.completeRefresh(revision, reservation, pair), { revision: reserved.revision, reservation: reserved.reservation, pair: bad })).toEqual({ status: 'conflict' });
      const held = await first.evaluate(() => authority.read());
      expect(held).toMatchObject({ revision: reserved.revision, incarnation: login.incarnation, pair, refreshReserved: true });
      const rotated = { ...bad, session: pair.session };
      const completed = await first.evaluate(({ revision, reservation, pair }) => authority.completeRefresh(revision, reservation, pair), { revision: reserved.revision, reservation: reserved.reservation, pair: rotated });
      expect(completed).toMatchObject({ status: 'active', incarnation: login.incarnation, pair: rotated, refreshReserved: false });
      expect(await second.evaluate(() => authority.read())).toEqual(completed);
    } finally { await context.close(); }
  }, 30000);

  it('keeps an unfinished logout blocked after the initiating tab closes', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.authority); }
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const initial = await first.evaluate(() => authority.read());
      const pair = { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' };
      const login = await first.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: initial.revision, pair });
      const started = await first.evaluate(incarnation => authority.beginLogout(incarnation), login.incarnation);
      expect(started).toMatchObject({ status: 'started', accessToken: pair.accessToken });
      await first.close();
      const pending = await second.evaluate(() => authority.read());
      expect(pending).toEqual({ status: 'closing', revision: started.revision, incarnation: started.incarnation, operation: started.operation });
      expect(JSON.stringify(pending)).not.toContain(pair.accessToken);
      expect(await second.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: pending.revision, pair })).toEqual({ status: 'conflict' });
      expect(await second.evaluate(incarnation => authority.beginLogout(incarnation), login.incarnation)).toEqual({ status: 'conflict' });
      expect(await second.evaluate(({ revision, incarnation, operation }) => unverifiedAuthority.finishLogout(revision, incarnation, operation), started)).toEqual({ status: 'unavailable' });
      expect(await second.evaluate(({ revision, incarnation, operation }) => authority.finishLogout(revision, incarnation, operation, 'pending'), started)).toEqual({ status: 'unconfirmed' });
      expect(await second.evaluate(() => authority.read())).toEqual(pending);
      const done = await second.evaluate(({ revision, incarnation, operation }) => authority.finishLogout(revision, incarnation, operation, 'synthetic-server-complete'), started);
      expect(done.status).toBe('tombstone');
      expect((await second.evaluate(({ revision, pair }) => authority.login(revision, pair), { revision: done.revision, pair })).status).toBe('active');
    } finally { await context.close(); }
  }, 30000);

  it('rejects sparse history before accepting a refresh reservation', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.waitForFunction(() => window.authority);
      const result = await page.evaluate(async () => {
        await authority.provision();
        const initial = await authority.read();
        const login = await authority.login(initial.revision, { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' });
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); tx.objectStore('authority').put({ version: 1, entries: new Array(2) }, 'history'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        const read = await authority.read();
        const reservation = await authority.reserveRefresh(login.revision);
        const stored = await new Promise((resolve, reject) => { const tx = db.transaction('authority'); const request = tx.objectStore('authority').get('current'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        db.close();
        return { read, reservation, storedReservation: stored.reservation };
      });
      expect(result).toEqual({ read: { status: 'unavailable' }, reservation: { status: 'unavailable' }, storedReservation: null });
    } finally { await context.close(); }
  }, 30000);

  it('rejects a mismatched active reservation fingerprint', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.waitForFunction(() => window.authority);
      const result = await page.evaluate(async () => {
        await authority.provision();
        const initial = await authority.read();
        const login = await authority.login(initial.revision, { session: 'synthetic-session', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', owner: 'synthetic-owner', home: 'https://home.example/' });
        const reserved = await authority.reserveRefresh(login.revision);
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-standalone-auth-authority', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('authority', 'readwrite'); tx.objectStore('authority').put({ version: 1, entries: [{ fingerprint: 'a'.repeat(64), reservation: reserved.reservation }] }, 'history'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
        return [await authority.read(), await authority.beginLogout(login.incarnation)];
      });
      expect(result).toEqual([{ status: 'unavailable' }, { status: 'unavailable' }]);
    } finally { await context.close(); }
  }, 30000);
});
