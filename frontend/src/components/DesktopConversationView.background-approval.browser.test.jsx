import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;
beforeAll(async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { DesktopConversationView } from './src/components/DesktopConversationView';
    const input = 'hello\\n' + 'x'.repeat(480);
    const command = 'read input; printf synthetic';
    const closing = location.hash === '#close';
    const binary = location.hash === '#binary';
    const bytes = [0, 255, 128, 65, ...Array(508).fill(255)];
    const encoded = btoa(String.fromCharCode(...bytes));
    const hexadecimal = bytes.map(value => value.toString(16).padStart(2, '0')).join(' ');
    const description = (closing ? 'Close interactive input (send end-of-file)' : binary ? 'Write binary input' : 'Write interactive input') + '\\nWorkspace (escaped): "/synthetic/project"\\nAction ID: ' + 'a'.repeat(64) + '\\nCommand (escaped):\\n' + JSON.stringify(command) + (closing ? '' : binary ? '\\nExact bytes (hexadecimal):\\n' + hexadecimal : '\\nExact text (escaped):\\n' + JSON.stringify(input));
    function App() {
      const [decision, setDecision] = useState('');
      const approval = { approvalId: 'review', toolName: closing ? 'background_close_input' : binary ? 'background_write_bytes' : 'background_write', description, toolInput: closing ? { actionId: 'a'.repeat(64) } : binary ? { actionId: 'a'.repeat(64), base64: encoded } : { actionId: 'a'.repeat(64), text: input } };
      return <main style={{height: '100dvh', display: 'flex', flexDirection: 'column'}}><DesktopConversationView turns={[]} mode="structured" aiType="deepseek" connectionState="online" isSendReady showHeader={false} isStreaming pendingApproval={approval} allowApprovalForSession onApprove={value => setDecision(value ? 'approved' : 'rejected')} /><output>{decision}</output></main>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.VITE_API_URL':'""','import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.find(f => f.path.endsWith('.js')).text); return; }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(bundle.find(f => f.path.endsWith('.css')).text); return; }
    if (req.url.startsWith('/api/')) { res.statusCode = 404; res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 60000);
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

describe('background input approval in a browser', () => {
  it.each([320, 390, 1280])('keeps the exact request and decision usable at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin);
      const review = page.getByLabel('Background action review');
      await review.waitFor();
      const text = await review.textContent();
      expect(text).toContain('Command (escaped):\n"read input; printf synthetic"');
      expect(text).toContain('hello\\n');
      expect(await review.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
      expect(await page.getByRole('button', { name: 'Allow for this session' }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await approve.scrollIntoViewIfNeeded();
      if (width < 500) expect((await approve.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await approve.click();
      expect(await page.locator('output').textContent()).toBe('approved');
      if (process.env.V4_BACKGROUND_APPROVAL_SCREENSHOT && width === 320) await page.screenshot({ path: process.env.V4_BACKGROUND_APPROVAL_SCREENSHOT });
    } finally { await context.close(); }
  }, 60000);
  it.each([320, 1280])('shows the end-of-file decision at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/#close`);
      const review = page.getByLabel('Background action review');
      await review.waitFor();
      expect(await review.textContent()).toContain('send end-of-file');
      expect(await review.textContent()).toContain('read input; printf synthetic');
      expect(await page.getByRole('button', { name: 'Allow for this session' }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      expect(await page.locator('output').textContent()).toBe('approved');
    } finally { await context.close(); }
  }, 60000);
  it.each([320, 1280])('shows exact binary bytes for review at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(`${origin}/#binary`);
      const review = page.getByLabel('Background action review');
      await review.waitFor();
      expect(await review.textContent()).toContain('00 ff 80 41');
      expect(await page.getByRole('button', { name: 'Allow for this session' }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      expect(await page.locator('output').textContent()).toBe('approved');
    } finally { await context.close(); }
  }, 60000);
});
