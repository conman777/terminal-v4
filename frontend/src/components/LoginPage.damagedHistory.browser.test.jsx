import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, bundle;
beforeAll(async () => {
  const entry = `import React from 'react'; import { createRoot } from 'react-dom/client';
    import './src/styles.css'; import './src/ProUI.css';
    import { AuthProvider, useAuth } from './src/contexts/AuthContext'; import LoginPage from './src/components/LoginPage'; import { AuthRecoveryNotice } from './src/components/AuthRecoveryNotice';
    localStorage.setItem('terminal_access_token', 'fixture-access'); localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    if (location.hash.startsWith('#workspace')) localStorage.setItem('terminal_user', JSON.stringify({id:'fixture-user',username:'fixture-user'}));
    const open = indexedDB.open('terminal-v4-auth-coordination', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('refresh');
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('refresh','readwrite'); if (location.hash !== '#workspace-uncertain') tx.objectStore('refresh').put('damaged','consumed');
      tx.oncomplete = () => { db.close(); createRoot(document.getElementById('root')).render(<AuthProvider><Gate /></AuthProvider>); }; };
    function Gate() { const auth = useAuth(); return auth.loading ? <p>Loading</p> : auth.isAuthenticated ? <><AuthRecoveryNotice message={auth.authNotice} onDismiss={auth.dismissAuthNotice} /><label>Draft<textarea defaultValue="Keep unsaved draft" /></label></> : <LoginPage />; }`;
  bundle = JSON.parse(execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, root: process.cwd() }) }));
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

describe('damaged sign-in history in the actual login view', () => {
  it.each([320, 390, 1280])('shows a readable recovery notice at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('http://fixture.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.find(file => file.path.endsWith('.js')).text });
        if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: bundle.find(file => file.path.endsWith('.css')).text });
        if (path === '/api/auth/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
        if (path.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
        return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
      });
      await page.goto('http://fixture.test/');
      const notice = page.getByRole('alert');
      await notice.waitFor().catch(async error => { throw new Error(`${error.message}; page errors: ${errors.join(', ')}; body: ${await page.locator('body').innerText()}`); });
      expect(await notice.textContent()).toMatch(/sign-in history is damaged/i);
      expect(await page.getByLabel('Username').isVisible()).toBe(true);
      expect(await page.locator('.pro-login-container').count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const scroll = await page.locator('.pro-login-wrapper').evaluate(element => ({ height: element.clientHeight, viewport: innerHeight, scrollable: element.scrollHeight > element.clientHeight }));
      expect(scroll.height).toBeLessThanOrEqual(scroll.viewport);
      if (width < 500) {
        if (width === 320) expect(scroll.scrollable).toBe(true);
        await page.locator('.pro-login-wrapper').evaluate(element => { element.scrollTop = element.scrollHeight; });
        const rect = await page.getByRole('button', { name: 'Authenticate with Passkey' }).boundingBox();
        expect(rect.y + rect.height).toBeLessThanOrEqual(scroll.viewport);
      }
    } finally { await context.close(); }
  }, 60000);

  it.each([[320, 'workspace'], [1280, 'workspace'], [320, 'workspace-uncertain']])('keeps the workspace and draft available behind the notice at %ipx (%s)', async (width, scenario) => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.route('http://fixture.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.find(file => file.path.endsWith('.js')).text });
        if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: bundle.find(file => file.path.endsWith('.css')).text });
        if (path === '/api/auth/me') return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
        if (path === '/api/auth/refresh') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        if (path.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
        return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
      });
      await page.goto(`http://fixture.test/#${scenario}`);
      const notice = page.getByRole('alert');
      await notice.waitFor();
      expect(await notice.textContent()).toMatch(/save (?:any )?unsaved drafts/i);
      if (scenario === 'workspace-uncertain') expect(await notice.textContent()).toMatch(/refresh could not be confirmed/i);
      const box = await notice.boundingBox();
      expect(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 800).toBe(true);
      await notice.getByRole('button', { name: 'Dismiss' }).click();
      expect(await page.getByLabel('Draft').inputValue()).toBe('Keep unsaved draft');
      expect(await page.getByRole('alert').count()).toBe(0);
    } finally { await context.close(); }
  }, 60000);
});
