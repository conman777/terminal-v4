import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let server, browser, origin;
const fakeSession = `
import { useEffect, useState } from 'react';
export function useStructuredSession() {
  const [connectionState, setConnectionState] = useState('online');
  useEffect(() => { const stop = () => setConnectionState('unavailable'); window.addEventListener('fixture-unavailable', stop); return () => window.removeEventListener('fixture-unavailable', stop); }, []);
  return { messages: [], currentToolCalls: [], connectionState, reconnect: () => { window.fixtureReconnects++; setConnectionState('online'); }, sendMessage: () => { window.fixtureSends++; }, interrupt: () => {}, approve: () => {} };
}`;
const fakeContext = `
const noop = () => Promise.resolve({});
const value = { listSessionGitBranches: () => Promise.resolve({ branches: [] }), checkoutSessionGitBranch: noop, createSession: noop, sendRawToSession: noop, updateThreadMetadata: noop, restoreSession: noop };
export const useTerminalSession = () => value;`;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/WorkspaceUI.css';
import './src/ProUI.css';
import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
import { MobileShell } from './src/components/MobileShell';
const session = { id: 'ss-reconnect-fixture', runtime: 'codex', title: 'Conversation', cwd: '/synthetic' };
window.fixtureReconnects = 0; window.fixtureSends = 0;
createRoot(document.getElementById('root')).render(<AutocorrectProvider><div style={{height:'100vh',display:'flex',flexDirection:'column'}}><MobileShell visible sessions={[session]} activeSessionId={session.id} projectInfo={{cwd:session.cwd}} viewportHeight={640} mobileView="terminal" /></div></AutocorrectProvider>);`;

beforeAll(async () => {
  const out = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    input: JSON.stringify({ entry, root: process.cwd(), virtual: { 'hooks/useStructuredSession$': fakeSession, 'contexts/TerminalSessionContext$': fakeContext } }),
  });
  const bundle = JSON.parse(out);
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture.js' || pathname === '/fixture.css') {
      res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(bundle.find(file => file.path.endsWith(pathname.endsWith('.js') ? '.js' : '.css')).text);
    } else if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json'); res.end('[]');
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);

afterAll(async () => {
  await browser?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('phone conversation recovery', () => {
  it.each([320, 390])('keeps the draft and reconnect control usable at %spx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 640 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const draft = page.getByRole('textbox', { name: 'Command composer' });
      await draft.fill('Keep this draft');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-unavailable')));
      const reconnect = page.getByRole('button', { name: 'Reconnect conversation' });
      await reconnect.waitFor();
      expect(await draft.inputValue()).toBe('Keep this draft');
      expect(await draft.isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      const box = await reconnect.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x >= 0 && box.x + box.width <= width).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await reconnect.click();
      expect(await page.evaluate(() => [window.fixtureReconnects, window.fixtureSends])).toEqual([1, 0]);
      expect(await draft.inputValue()).toBe('Keep this draft');
    } finally { await context.close(); }
  });
});
