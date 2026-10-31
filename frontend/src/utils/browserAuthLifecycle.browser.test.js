import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;

beforeAll(async () => {
  const bundled = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({ root: process.cwd(), entry: `
      import { createBrowserAuthAuthority } from './src/utils/standaloneIndexedDbAuthAuthority.js';
      import { createBrowserAuthLifecycle } from './src/utils/browserAuthLifecycle.js';
      import { apiFetch } from './src/utils/api.js';
      window.strictApiFetch = apiFetch;
      window.authority = createBrowserAuthAuthority({ verifyLogoutReceipt: async ({ receipt }) => receipt === 'synthetic-confirmed', verifyLoginFailureReceipt: async ({ receipt }) => receipt === 'synthetic-no-session' });
      window.loginResponse = { kind:'issued', user:{id:'owner-one',username:'first'}, session:'session-one', accessToken:'access-one', refreshToken:'refresh-one', logoutCapability:'a'.repeat(64) };
      window.createLifecycle = createBrowserAuthLifecycle;
      window.syntheticTransport = {
        login: async () => window.loginResponse,
        refresh: async () => { window.refreshStarted = true; return new Promise(resolve => { window.releaseRefresh = resolve; }); },
        logout: async () => 'synthetic-confirmed',
        recoverLogin: async () => ({ kind:'no-session', receipt:'synthetic-no-session' }),
      };
      window.lifecycle = createBrowserAuthLifecycle({ authority, transport: syntheticTransport });
    ` }),
  });
  const source = JSON.parse(bundled).find(file => file.path.endsWith('.js')).text;
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(source); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script src="/fixture.js"></script>');
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

describe('strict browser auth lifecycle across independent tabs', () => {
  it.each(['abort', 'unclaimed-login'])('releases only an undispatched reservation after %s', async action => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.lifecycle); }
      await first.evaluate(() => authority.provision());
      await first.evaluate(() => lifecycle.login('https://synthetic.example/', {}));
      await first.evaluate(() => {
        window.abortRefresh = new AbortController();
        const delayed = { ...authority, reserveRefresh: async revision => {
          const result = await authority.reserveRefresh(revision);
          window.reserved = true;
          await new Promise(resolve => { window.releaseReserve = resolve; });
          return result;
        } };
        window.refreshOutcome = 'pending';
        createLifecycle({ authority: delayed, transport: syntheticTransport }).refresh(undefined, { signal: abortRefresh.signal })
          .then(result => { window.refreshOutcome = result.status; });
      });
      await first.waitForFunction(() => window.reserved === true);
      let intent;
      if (action === 'abort') await first.evaluate(() => abortRefresh.abort());
      else intent = (await second.evaluate(() => authority.beginLogin('https://synthetic.example/'))).intent;
      await first.evaluate(() => releaseReserve());
      await first.waitForFunction(() => window.refreshOutcome !== 'pending');
      expect(await first.evaluate(() => window.refreshOutcome)).toBe(action === 'abort' ? 'cancelled' : 'conflict');
      expect(await first.evaluate(() => window.refreshStarted === true)).toBe(false);
      if (intent) expect(await second.evaluate(intent => authority.cancelUnclaimedLogin(intent), intent)).toEqual({ status: 'cancelled' });
      expect(await second.evaluate(() => authority.read())).toMatchObject({ status: 'active', refreshReserved: false, pair: { refreshToken: 'refresh-one' } });
    } finally { await context.close(); }
  }, 30000);

  it('keeps a dispatched write unconfirmed after another tab signs out', async () => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.lifecycle); }
      expect((await first.evaluate(() => authority.provision())).status).toBe('provisioned');
      expect((await first.evaluate(() => lifecycle.login(`${location.origin}/`, {}))).status).toBe('active');
      let release;
      const entered = new Promise(resolve => { release = resolve; });
      let requestRoute;
      await first.route('**/api/strict-fixture', route => { requestRoute = route; release(); });
      await first.evaluate(() => {
        window.writeResult = 'pending';
        strictApiFetch('/api/strict-fixture', { method: 'POST', body: { draft: 'preserve' }, authLifecycle: lifecycle })
          .then(() => { window.writeResult = 'unexpected-success'; }, error => { window.writeResult = error.outcomeUncertain ? 'unconfirmed' : 'rejected'; });
      });
      await entered;
      expect((await second.evaluate(() => lifecycle.logout())).status).toBe('tombstone');
      await requestRoute.fulfill({ status: 204 });
      await first.waitForFunction(() => window.writeResult !== 'pending');
      expect(await first.evaluate(() => window.writeResult)).toBe('unconfirmed');
      expect((await second.evaluate(() => lifecycle.read())).status).toBe('tombstone');
    } finally { await context.close(); }
  }, 30000);

  it.each(['logout', 'same-owner-login', 'different-owner-login'])('preserves %s when an old refresh returns late', async action => {
    const context = await browser.newContext();
    try {
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto(origin); await page.waitForFunction(() => window.lifecycle); }
      expect(await first.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      expect((await first.evaluate(() => lifecycle.login('https://synthetic.example/', {}))).status).toBe('active');
      await first.evaluate(() => {
        localStorage.setItem('identity:synthetic:composerDraft:v1:thread', 'unchanged draft');
        window.refreshOutcome = 'pending';
        lifecycle.refresh().then(result => { window.refreshOutcome = result.status; });
      });
      await first.waitForFunction(() => window.refreshStarted === true);
      if (action === 'logout') {
        expect((await second.evaluate(() => lifecycle.logout())).status).toBe('tombstone');
      } else {
        expect((await second.evaluate(action => {
          const id = action === 'same-owner-login' ? 'owner-one' : 'owner-two';
          window.loginResponse = { kind:'issued', user:{id,username:'replacement'}, session:'session-two', accessToken:'access-two', refreshToken:'refresh-two', logoutCapability:'b'.repeat(64) };
          return lifecycle.login('https://synthetic.example/', {});
        }, action)).status).toBe('retirement-pending');
        expect((await second.evaluate(() => lifecycle.recoverRetirements())).status).toBe('active');
      }
      await first.evaluate(() => releaseRefresh({ accessToken:'stale-access', refreshToken:'stale-refresh' }));
      await first.waitForFunction(() => window.refreshOutcome !== 'pending');
      expect(await first.evaluate(() => window.refreshOutcome)).toBe('conflict');
      const current = await second.evaluate(() => lifecycle.read());
      if (action === 'logout') expect(current.status).toBe('tombstone');
      else expect(current).toMatchObject({ status:'active', pair:{ session:'session-two', accessToken:'access-two', owner:action === 'same-owner-login' ? 'owner-one' : 'owner-two' } });
      expect(await first.evaluate(() => localStorage.getItem('identity:synthetic:composerDraft:v1:thread'))).toBe('unchanged draft');
    } finally { await context.close(); }
  }, 30000);
});
