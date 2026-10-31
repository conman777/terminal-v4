import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/ProUI.css';
import './src/WorkspaceUI.css';
import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
import { DesktopStatusBar } from './src/components/DesktopStatusBar';
function App() {
  const [value, setValue] = useState('See @login before deploying');
  return <AutocorrectProvider><div className="mobile-shell" style={{ height: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}><DesktopStatusBar sessionId="fixture" compactInputOptions
    composerValue={value} onComposerChange={setValue} onComposerSubmit={() => {}} showMicButtons={false}
    mentionThreads={[{ id: 'thread-login', title: 'Fix login bug' }]} /></div></AutocorrectProvider>;
}
createRoot(document.getElementById('root')).render(<App />);`;

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

describe('mobile composer mentions in a draft', () => {
  it.each([320, 390])('preserves the draft and typing position at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      page.setDefaultTimeout(5000);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await input.focus();
      await input.evaluate(element => element.setSelectionRange(10, 10));
      await page.evaluate(() => document.dispatchEvent(new Event('selectionchange', { bubbles: true })));
      const option = page.getByRole('option', { name: /Fix login bug/ });
      await option.waitFor({ state: 'visible' });
      const bounds = await option.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await option.click();
      expect(await input.inputValue()).toBe('See before deploying');
      expect(await input.evaluate(element => [document.activeElement === element, element.selectionStart])).toEqual([true, 4]);
      expect(await page.getByRole('list', { name: 'Attached context' }).textContent()).toContain('Fix login bug');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    } finally { await context.close(); }
  }, 90000);
});
