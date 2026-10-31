import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;

beforeAll(async () => {
  const fixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { TurnChangesCard } from './src/components/TurnChangesCard';
    const small = { from: 'a'.repeat(40), to: 'b'.repeat(40), added: 5, removed: 2, files: [
      { path: 'src/components/example.jsx', added: 4, removed: 2 },
      { path: 'README.md', added: 1, removed: 0 }
    ] };
    const changes = location.hash === '#large' ? { ...small, added: 300, removed: 0, files: Array.from({ length: 300 }, (_, i) => ({ path: 'src/file-' + String(i).padStart(3, '0') + '.js', added: 1, removed: 0 })) } : small;
    createRoot(document.getElementById('root')).render(<TurnChangesCard changes={changes} workspacePath="/synthetic/repo" />);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.VITE_API_URL':'""','import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.find(f => f.path.endsWith('.js')).text); return; }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(bundle.find(f => f.path.endsWith('.css')).text); return; }
    if (req.url.startsWith('/api/workspace/git/diff?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ patch: '@@ -1 +1 @@\n-old\n+new\n' })); return; }
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

describe('turn changes in a browser', () => {
  it.each([320, 390, 1280])('shows the directory tree and a selected diff at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.getByRole('button', { name: 'Open diff' }).click();
      await page.getByRole('button', { name: 'Collapse src/components' }).click();
      expect(await page.getByRole('button', { name: 'src/components/example.jsx' }).count()).toBe(0);
      await page.getByRole('button', { name: 'Expand src/components' }).click();
      const file = page.getByRole('button', { name: 'src/components/example.jsx' });
      if (width < 500) expect((await file.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await file.click();
      await page.getByLabel('Diff for src/components/example.jsx').waitFor();
      expect(await page.getByText('new', { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.V4_TURN_CHANGES_SCREENSHOT && width === 320) await page.screenshot({ path: process.env.V4_TURN_CHANGES_SCREENSHOT });
    } finally { await context.close(); }
  }, 60000);

  it.each([320, 1280])('keeps a large tree navigable with the keyboard at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/#large`);
      await page.getByRole('button', { name: 'Open diff' }).click();
      const tree = page.getByRole('tree', { name: 'Changed files' });
      await tree.waitFor({ timeout: 2000 });
      expect(await page.getByRole('treeitem').count()).toBeLessThan(50);
      await tree.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.getElementById(document.querySelector('[role="tree"]').getAttribute('aria-activedescendant'))?.getAttribute('aria-label') === 'src/file-299.js');
      await page.keyboard.press('Enter');
      await page.getByLabel('Diff for src/file-299.js').waitFor();
      expect(await page.getByText('new', { exact: true }).count()).toBe(1);
      await tree.focus();
      await tree.evaluate(element => { element.scrollTop = 0; });
      await page.waitForFunction(() => {
        const activeTree = document.querySelector('[role="tree"]');
        return document.getElementById(activeTree.getAttribute('aria-activedescendant'))?.getAttribute('aria-label') === 'src';
      });
      expect(await page.getByLabel('Diff for src/file-299.js').count()).toBe(1);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowLeft');
      expect(await page.getByRole('treeitem').count()).toBe(1);
      await page.keyboard.press('ArrowRight');
      expect(await page.getByRole('treeitem').count()).toBeGreaterThan(1);
      if (width < 500) {
        const first = page.getByRole('treeitem', { name: 'src/file-000.js' });
        expect((await first.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await first.tap();
        await page.getByLabel('Diff for src/file-000.js').waitFor();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (process.env.V4_TURN_CHANGES_LARGE_SCREENSHOT && width === 320) await page.screenshot({ path: process.env.V4_TURN_CHANGES_LARGE_SCREENSHOT });
    } finally { await context.close(); }
  }, 60000);
});
