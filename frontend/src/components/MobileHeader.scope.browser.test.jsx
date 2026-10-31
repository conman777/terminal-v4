import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/ProUI.css';
import './src/WorkspaceUI.css';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { MobileHeader } from './src/components/MobileHeader';
import { setUser } from './src/utils/auth';
import { setActiveEnvironment } from './src/utils/remoteEnvironments';

setUser({ id: 'synthetic-owner-a' });
let finish;
window.finishOldRequest = () => finish?.({ ok: false, error: new Error('Old scope failed') });
window.changeAccount = () => setUser({ id: 'synthetic-owner-b' });
window.changeAccountAgain = () => setUser({ id: 'synthetic-owner-c' });
window.changeEnvironment = () => setActiveEnvironment({ id: 'synthetic-server-b' });
const hold = () => new Promise(resolve => { finish = resolve; });
createRoot(document.getElementById('root')).render(<ThemeProvider><MobileHeader
  activeSessions={[{ id: 'synthetic-thread', title: 'A long synthetic workspace conversation', isActive: true }]}
  activeSessionId="synthetic-thread" currentPath="/synthetic/project"
  onCloseSession={hold} onPinSession={hold} onUnpinSession={() => {}} onRenameSession={hold}
  onCreateSession={() => {}} onToggleFileManager={() => {}} onOpenGit={() => {}}
  onViewChange={() => {}} onSelectSession={() => {}}
/></ThemeProvider>);`;

let browser, server, origin;
beforeAll(async () => {
  const output = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, root }),
  });
  const bundle = JSON.parse(output);
  server = createServer((request, response) => {
    const file = request.url === '/fixture.js' ? bundle.find(item => item.path.endsWith('.js'))
      : request.url === '/fixture.css' ? bundle.find(item => item.path.endsWith('.css')) : null;
    if (file) {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(file.text);
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
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

describe('mobile header actions across scope changes', () => {
  it.each([320, 390])('retains usable controls and clears old-scope feedback at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const menu = page.getByRole('button', { name: 'More actions', exact: true });
      const rect = await menu.boundingBox();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await menu.click();
      await page.getByRole('button', { name: 'Pin thread', exact: true }).click();
      await page.getByRole('status').waitFor({ state: 'visible' });
      await page.evaluate(() => window.changeAccount());
      await page.getByRole('status').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.finishOldRequest());
      expect(await page.getByRole('alert').count()).toBe(0);
      await menu.click();
      await page.getByRole('button', { name: 'Rename thread', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Rename thread' });
      await dialog.getByRole('textbox', { name: 'Thread title' }).fill('New title');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await dialog.getByRole('button', { name: 'Saving…' }).waitFor({ state: 'visible' });
      await page.evaluate(() => window.changeAccountAgain());
      await dialog.waitFor({ state: 'hidden' });
      await page.evaluate(() => window.finishOldRequest());
      expect(await page.getByRole('alert').count()).toBe(0);
      await menu.click();
      await page.getByRole('button', { name: 'Close thread', exact: true }).click();
      await page.getByRole('status').waitFor({ state: 'visible' });
      await page.evaluate(() => window.changeEnvironment());
      await page.getByRole('status').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.finishOldRequest());
      expect(await page.getByRole('alert').count()).toBe(0);
    } finally { await context.close(); }
  }, 90000);
});
