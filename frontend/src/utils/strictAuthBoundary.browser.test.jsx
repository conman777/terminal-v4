import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let server, browser, origin;

beforeAll(async () => {
  const output = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    input: JSON.stringify({ root: process.cwd(), entry: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AuthProvider, useAuth } from './src/contexts/AuthContext.jsx';
      import LoginPage from './src/components/LoginPage.jsx';
      import { getAccessToken } from './src/utils/auth.js';
      import { apiFetch } from './src/utils/api.js';
      import { selectStrictAuth } from './src/utils/strictAuthBoundary.js';
      function Probe() { const auth = useAuth(); window.currentAuth = auth; window.visibleLegacy = getAccessToken(); return React.createElement('div', null, React.createElement('span', null, auth.strictStatus || 'legacy'), !auth.loading && !auth.isAuthenticated ? React.createElement(LoginPage) : null); }
      window.nativeFetch = window.fetch.bind(window); window.apiFetch = apiFetch; window.selectStrictAuth = selectStrictAuth;
      window.fetchCalls = 0;
      window.fetch = async () => { window.fetchCalls += 1; throw new Error('synthetic fetch'); };
      const props = new URL(location.href).searchParams.has('strict') ? { strictAuth: null } : {};
      createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, props, React.createElement(Probe)));
    ` }),
  });
  const script = JSON.parse(output).find(file => file.path.endsWith('.js')).text;
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(script); return; }
    if (req.url === '/api/synthetic-stream') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('synthetic-start'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<div id="root"></div><script src="/fixture.js"></script>');
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

async function setup(context) {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'synthetic-old-access');
    localStorage.setItem('terminal_refresh_token', 'synthetic-old-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-old-owner' }));
  });
}

async function expectHeld(page) {
  await page.waitForFunction(() => window.currentAuth && currentAuth.loading === false);
  expect(await page.evaluate(() => ({
    user: currentAuth.user, status: currentAuth.strictStatus, ready: currentAuth.strictReady,
    token: visibleLegacy, calls: fetchCalls, old: localStorage.getItem('terminal_access_token'),
    alert: document.querySelector('[role="alert"]')?.textContent,
    hasLoginButton: !!document.querySelector('form'),
  }))).toEqual({ user: null, status: 'unavailable', ready: false, token: null, calls: 0, old: 'synthetic-old-access',
    alert: expect.stringContaining('Check that browser session storage is enabled'), hasLoginButton: false });
}

describe('strict authentication tab fence in Chromium', () => {
  it('holds instead of falling back to legacy after a full reload', async () => {
    const context = await browser.newContext();
    try {
      await setup(context);
      const page = await context.newPage();
      await page.goto(`${origin}/?strict=1`);
      await expectHeld(page);
      expect(await page.evaluate(() => sessionStorage.getItem('terminal-v4-strict-auth-selection-v1'))).toBe('strict-v1');
      await page.evaluate(() => history.replaceState(null, '', '/'));
      await page.reload();
      await expectHeld(page);
    } finally { await context.close(); }
  }, 30000);

  it('copies the strict hold into a cloned tab without exposing legacy credentials', async () => {
    const context = await browser.newContext();
    try {
      await setup(context);
      const page = await context.newPage();
      await page.goto(`${origin}/?strict=1`);
      await expectHeld(page);
      const [child] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => window.open('/', '_blank'))]);
      await child.waitForLoadState();
      await expectHeld(child);
    } finally { await context.close(); }
  }, 30000);

  it.each(['unavailable', 'corrupt'])('holds normal bootstrap when marker storage is %s', async mode => {
    const context = await browser.newContext();
    try {
      await setup(context);
      await context.addInitScript(mode => {
        if (mode === 'unavailable') Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('synthetic denied'); } });
        else sessionStorage.setItem('terminal-v4-strict-auth-selection-v1', 'synthetic-corruption');
      }, mode);
      const page = await context.newPage();
      await page.goto(origin);
      await expectHeld(page);
    } finally { await context.close(); }
  }, 30000);

  it('aborts a previously opened legacy response stream on strict selection', async () => {
    const context = await browser.newContext();
    try {
      await setup(context);
      const page = await context.newPage();
      await page.goto(origin);
      await page.waitForFunction(() => window.currentAuth && currentAuth.loading === false);
      const result = await page.evaluate(async () => {
        window.fetch = window.nativeFetch;
        const response = await apiFetch('/api/synthetic-stream');
        const reader = response.body.getReader();
        await reader.read();
        const pending = reader.read().then(() => 'unexpected-data', () => 'cancelled');
        selectStrictAuth();
        return pending;
      });
      expect(result).toBe('cancelled');
    } finally { await context.close(); }
  }, 30000);
});
