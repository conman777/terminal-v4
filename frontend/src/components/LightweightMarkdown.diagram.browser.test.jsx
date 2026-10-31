import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
const flow = 'graph LR\n' + Array.from({ length: 12 }, (_, index) => `N${index} --> N${index + 1}`).join('\n');
const sequence = 'sequenceDiagram\n' + Array.from({ length: 16 }, (_, index) => `A->>B: Message ${index}`).join('\n');
const content = [flow, sequence].map(source => `\`\`\`mermaid\n${source}\n\`\`\``).join('\n\n');
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import { LightweightMarkdown } from './src/components/LightweightMarkdown';
createRoot(document.getElementById('root')).render(<main style={{padding: '12px'}}><button id="outside" onClick={() => document.body.dataset.clicked = 'yes'}>Outside</button><LightweightMarkdown content={${JSON.stringify(content)}} /></main>);`;

let browser, server, origin;
beforeAll(async () => {
  const bundle = JSON.parse(execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, root }),
  }));
  server = createServer((request, response) => {
    const file = request.url === '/fixture.js' ? bundle.find(item => item.path.endsWith('.js'))
      : request.url === '/fixture.css' ? bundle.find(item => item.path.endsWith('.css')) : null;
    if (file) {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/css');
      return response.end(file.text);
    }
    if (request.url !== '/') { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
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

describe('expanded Mermaid diagrams in a browser', () => {
  it.each([320, 390, 1280])('fits the viewport and supports scroll and keyboard dismissal at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 640 }, isMobile: width < 500, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      for (const [index, regionName] of ['Mermaid flowchart', 'Mermaid sequence diagram'].entries()) {
        const opener = page.getByRole('button', { name: 'Expand diagram' }).nth(index);
        await opener.click();
        const dialog = page.getByRole('dialog', { name: 'Expanded diagram' });
        const close = dialog.getByRole('button', { name: 'Close diagram' });
        expect(await dialog.getAttribute('aria-modal')).toBe('true');
        expect(await close.evaluate(element => element === document.activeElement)).toBe(true);
        const box = await dialog.boundingBox();
        const closeBox = await close.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(640);
        expect(closeBox.height).toBeGreaterThanOrEqual(44);
        const region = dialog.getByRole('region', { name: regionName });
        const scroll = await region.evaluate(element => {
          element.scrollTo(element.scrollWidth, element.scrollHeight);
          return { horizontal: element.scrollLeft, vertical: element.scrollTop, width: element.scrollWidth, height: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight };
        });
        if (scroll.width > scroll.clientWidth) expect(scroll.horizontal).toBeGreaterThan(0);
        if (scroll.height > scroll.clientHeight) expect(scroll.vertical).toBeGreaterThan(0);
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
        await page.keyboard.press('Escape');
        expect(await dialog.count()).toBe(0);
        expect(await opener.evaluate(element => element === document.activeElement)).toBe(true);
      }
      await page.getByRole('button', { name: 'Expand diagram' }).first().click();
      await page.mouse.click(1, 1);
      expect(await page.getByRole('dialog', { name: 'Expanded diagram' }).count()).toBe(0);
      expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  }, 90000);
});
