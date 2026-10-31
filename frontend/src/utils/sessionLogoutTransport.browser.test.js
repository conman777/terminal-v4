import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const owner = 'synthetic-owner';
const session = '59d5fe7a-2b4c-467d-a11e-2bd1718ccf01';
const capability = 'a'.repeat(64);
let browser, server, origin, records, failFirstResponse, calls;

beforeAll(async () => {
  const output = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: process.cwd(), encoding: 'utf8',
    input: JSON.stringify({ root: process.cwd(), entry: `
      import { createSessionLogoutTransport } from './src/utils/sessionLogoutTransport.js';
      import { createBrowserAuthAuthority } from './src/utils/standaloneIndexedDbAuthAuthority.js';
      import { createBrowserAuthLifecycle } from './src/utils/browserAuthLifecycle.js';
      window.setup = () => {
        const home = location.origin + '/';
        const transport = createSessionLogoutTransport({ trustedHome: home });
        const authority = createBrowserAuthAuthority({ verifyLogoutReceipt: transport.verifyLogoutReceipt });
        const lifecycle = createBrowserAuthLifecycle({ authority, transport: { ...transport,
          login: async () => ({ kind: 'issued', user: { id: 'synthetic-owner', username: 'fixture' },
            session: '${session}', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', logoutCapability: '${capability}' })
        } });
        Object.assign(window, { transport, authority, lifecycle });
      };
    ` }),
  });
  const moduleSource = JSON.parse(output).find(file => file.path.endsWith('.js')).text;
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(moduleSource);
      return;
    }
    if (!req.url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<script src="/fixture.js"></script>');
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let value;
      try { value = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      calls.push({ path: req.url, operation: value.operation });
      const valid = value.owner === owner && value.session === session && value.logoutCapability === capability;
      if (!valid) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"status":"unconfirmed"}'); return; }
      const receipt = { status: 'revoked', owner: value.owner, session: value.session, operation: value.operation, incarnation: value.incarnation };
      if (req.url === '/api/auth/session-logout') {
        const previous = records.get(value.operation);
        if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) { res.writeHead(503); res.end(); return; }
        records.set(value.operation, receipt);
        if (failFirstResponse) { failFirstResponse = false; res.destroy(); return; }
      }
      const saved = records.get(value.operation);
      res.writeHead(saved ? 200 : 202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(saved || { status: 'unconfirmed' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);

beforeEach(() => { records = new Map(); failFirstResponse = false; calls = []; });
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('session logout transport in a real browser', () => {
  it('keeps a closing session after a lost response and verifies the exact retry from the server', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => window.setup());
      expect(await page.evaluate(() => authority.provision())).toEqual({ status: 'provisioned' });
      const active = await page.evaluate(() => lifecycle.login(`${location.origin}/`, {}));
      expect(active.status).toBe('active');
      failFirstResponse = true;
      expect((await page.evaluate(() => lifecycle.logout())).status).toBe('logout-unconfirmed');
      expect((await page.evaluate(() => authority.read())).status).toBe('closing');
      expect((await page.evaluate(incarnation => lifecycle.resumeLogout(incarnation), active.incarnation)).status).toBe('tombstone');
      expect(calls.map(call => call.path)).toEqual(['/api/auth/session-logout', '/api/auth/session-logout', '/api/auth/session-logout/receipt']);
      expect(new Set(calls.map(call => call.operation)).size).toBe(1);
    } finally { await context.close(); }
  }, 30000);

  it('does not accept a supplied receipt before the loopback server records it', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => window.setup());
      const result = await page.evaluate(async ({ owner, session, capability }) => {
        const scope = { home: `${location.origin}/`, owner, session, operation: crypto.randomUUID(), incarnation: crypto.randomUUID(), logoutCapability: capability };
        return transport.verifyLogoutReceipt({ ...scope, receipt: { ...scope, status: 'revoked' } });
      }, { owner, session, capability });
      expect(result).toBe(false);
      expect(calls.map(call => call.path)).toEqual(['/api/auth/session-logout/receipt']);
    } finally { await context.close(); }
  }, 30000);
});
