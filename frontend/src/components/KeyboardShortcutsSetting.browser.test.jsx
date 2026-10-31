import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let server, browser, origin;

beforeAll(async () => {
  const fixture = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { KeyboardShortcutsSetting } from './src/components/KeyboardShortcutsSetting';
    createRoot(document.getElementById('root')).render(<main style={{padding: '16px'}}><KeyboardShortcutsSetting /></main>);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.find(f => f.path.endsWith('.js')).text); return; }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(bundle.find(f => f.path.endsWith('.css')).text); return; }
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

describe('keyboard shortcut conflicts in a browser', () => {
  it.each([320, 1280])('rejects conflicts and saves a valid shortcut at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.getByRole('button', { name: 'Change Command palette shortcut' }).click();
      const mod = await page.evaluate(() => /mac/i.test(navigator.platform)) ? 'Meta' : 'Control';
      await page.keyboard.press(`${mod}+f`);
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('alert').textContent()).toContain('Find in thread');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.keyboard.press(`${mod}+j`);
      expect(await page.getByRole('alert').count()).toBe(0);
      await page.reload();
      expect(await page.locator('tr').first().locator('kbd').textContent()).toContain('J');
    } finally { await context.close(); }
  }, 60000);
});
