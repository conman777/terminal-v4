import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, bundle;
beforeAll(async () => {
  const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { LightweightMarkdown } from './src/components/LightweightMarkdown';
    createRoot(document.getElementById('root')).render(<LightweightMarkdown content={'![First](/one.svg)\\n\\n![Second](/two.svg)'} />);`;
  bundle = JSON.parse(execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); });

describe('interactive image lightbox in Chromium', () => {
  it.each([320, 390, 1280])('supports navigation, zoom, focus and bounded layout at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 640 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.route('http://fixture.test/**', async route => {
        const url = route.request().url();
        if (url.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="blue"/></svg>' });
        if (url.endsWith('/fixture.js')) return route.fulfill({ contentType: 'text/javascript', body: bundle.find(f => f.path.endsWith('.js')).text });
        if (url.endsWith('/fixture.css')) return route.fulfill({ contentType: 'text/css', body: bundle.find(f => f.path.endsWith('.css')).text });
        return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
      });
      await page.goto('http://fixture.test/');
      const opener = page.getByRole('button', { name: 'View larger: First' });
      if (width < 500) await opener.tap(); else await opener.click();
      const dialog = page.getByRole('dialog');
      if (width < 500) await dialog.getByRole('button', { name: 'Zoom in' }).tap(); else await dialog.getByRole('button', { name: 'Zoom in' }).click();
      expect(await dialog.getByText('150%').count()).toBe(1);
      expect(await dialog.locator('.md-lightbox-viewport').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
      if (width < 500) await dialog.getByRole('button', { name: 'Next image' }).tap(); else await dialog.getByRole('button', { name: 'Next image' }).click();
      expect(await dialog.getByText('100%').count()).toBe(1);
      expect(await dialog.getByRole('img', { name: 'Second' }).count()).toBe(1);
      expect(await page.evaluate(() => { const r = document.querySelector('.md-lightbox-panel').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; })).toBe(true);
      await page.keyboard.press('Escape');
      expect(await opener.evaluate(el => document.activeElement === el)).toBe(true);
    } finally { await context.close(); }
  }, 60000);
});
