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
    import './src/components/SettingsModal.css';
    import { AppearanceSetting } from './src/components/AppearanceSetting';
    createRoot(document.getElementById('root')).render(<main className="session-settings-modal" style={{padding: 16}}><div className="session-settings-panel"><AppearanceSetting /></div></main>);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js' || req.url === '/fixture.css') {
      const ext = req.url.endsWith('.js') ? '.js' : '.css';
      res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : 'text/css');
      res.end(bundle.find(f => f.path.endsWith(ext)).text);
      return;
    }
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

describe('appearance resets in a browser', () => {
  it.each([{ width: 320, touch: true }, { width: 1280, touch: false }])('works at $width px', async ({ width, touch }) => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.getByRole('button', { name: 'Teal' }).click();
      await page.getByRole('button', { name: 'Wide', exact: true }).click();
      const reset = page.getByRole('button', { name: 'Reset accent colour' });
      await reset.focus();
      await page.keyboard.press('Enter');
      expect(await reset.isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Wide', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (touch) expect((await page.getByRole('button', { name: 'Reset conversation width' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await page.reload();
      expect(await page.getByRole('button', { name: 'Indigo' }).getAttribute('aria-pressed')).toBe('true');
      expect(await page.getByRole('button', { name: 'Wide', exact: true }).getAttribute('aria-pressed')).toBe('true');
    } finally { await context.close(); }
  }, 60000);
});
