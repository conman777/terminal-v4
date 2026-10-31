import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, script;
beforeAll(async () => {
  const entry = `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AuthProvider, useAuth } from './src/contexts/AuthContext';
    import { createBrowserAuthAuthority } from './src/utils/standaloneIndexedDbAuthAuthority';
    import { createBrowserAuthLifecycle } from './src/utils/browserAuthLifecycle';
    import { createStrictAuthNotifications } from './src/utils/strictAuthNotifications';
    window.authority = createBrowserAuthAuthority({ verifyLogoutReceipt: async ({receipt}) => receipt === 'verified', verifyLoginFailureReceipt: async () => false });
    window.notifications = createStrictAuthNotifications();
    window.lifecycle = createBrowserAuthLifecycle({ authority, notifications, transport: {
      login: async () => { if (window.holdLogin) { window.loginStarted=true; return new Promise(resolve => { window.releaseLogin=resolve; }); }
        return {kind:'issued', user:{id:'owner',username:'synthetic'}, session:'session', accessToken:'access', refreshToken:'refresh', logoutCapability:'a'.repeat(64)}; },
      refresh: async () => { window.refreshStarted=true; return new Promise(resolve => { window.releaseRefresh=resolve; }); }, logout: async () => 'verified', recoverLogin: async () => ({kind:'unknown'})
    }});
    const strictAuth = { lifecycle, home:location.origin+'/', validateSession: async () => ({status:'valid'}), subscribe: notifications.subscribe };
    window.mount = () => createRoot(document.getElementById('root')).render(<AuthProvider strictAuth={strictAuth}><Gate /></AuthProvider>);
    function Gate() { const auth=useAuth(); window.currentAuth=auth; return <><output aria-label="ready">{String(auth.strictReady)}</output><output aria-label="notice">{auth.authNotice}</output>{auth.isAuthenticated && <label>Draft<textarea defaultValue="Unsent draft" /></label>}</>; }`;
  script = JSON.parse(execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, root: process.cwd() }) })).find(file => file.path.endsWith('.js')).text;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); });

describe('strict provider in independent browser tabs', () => {
  it('keeps unsaved text mounted when another tab signs out', async () => {
    const context = await browser.newContext();
    try {
      await context.route('http://localhost:45321/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/fixture.js"></script>' });
      });
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto('http://localhost:45321/'); await page.waitForFunction(() => window.lifecycle); }
      expect((await first.evaluate(() => authority.provision())).status).toBe('provisioned');
      expect((await first.evaluate(() => lifecycle.login(location.origin + '/', {}))).status).toBe('active');
      await first.evaluate(() => mount());
      await first.waitForFunction(() => document.querySelector('[aria-label="ready"]')?.textContent === 'true');
      await first.getByLabel('Draft').fill('Unsent browser draft');
      expect((await second.evaluate(() => lifecycle.logout())).status).toBe('tombstone');
      await first.waitForFunction(() => /signed out/i.test(document.querySelector('[aria-label="notice"]')?.textContent || ''));
      expect(await first.getByLabel('Draft').inputValue()).toBe('Unsent browser draft');
      expect(await first.getByLabel('ready').textContent()).toBe('false');
    } finally { await context.close(); }
  }, 30000);

  it.each(['login', 'refresh'])('invalidates the mounted workspace after an early %s transition', async operation => {
    const context = await browser.newContext();
    try {
      await context.route('http://localhost:45321/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/fixture.js"></script>' });
      });
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto('http://localhost:45321/'); await page.waitForFunction(() => window.lifecycle); }
      await first.evaluate(() => authority.provision());
      await first.evaluate(() => lifecycle.login(location.origin + '/', {}));
      await first.evaluate(() => mount());
      await first.waitForFunction(() => document.querySelector('[aria-label="ready"]')?.textContent === 'true');
      await first.getByLabel('Draft').fill('Unsent browser draft');
      await second.evaluate(operation => {
        if (operation === 'login') { window.holdLogin=true; void lifecycle.login(location.origin+'/', {}); }
        else void lifecycle.refresh();
      }, operation);
      await second.waitForFunction(operation => operation === 'login' ? window.loginStarted === true : window.refreshStarted === true, operation);
      await first.waitForFunction(() => document.querySelector('[aria-label="ready"]')?.textContent === 'false');
      await first.waitForFunction(operation => currentAuth.strictStatus === (operation === 'login' ? 'login-recovery-pending' : 'refresh-pending'), operation);
      expect(await first.getByLabel('Draft').inputValue()).toBe('Unsent browser draft');
      expect((await first.evaluate(() => currentAuth.strictStatus))).toBe(operation === 'login' ? 'login-recovery-pending' : 'refresh-pending');
    } finally { await context.close(); }
  }, 30000);
});
