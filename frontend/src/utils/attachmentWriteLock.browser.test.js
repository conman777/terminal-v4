import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;
beforeAll(async () => {
  const entry = `import { withAttachmentWriteLock } from './src/utils/attachmentWriteLock';
    window.attempt = (expected, next) => withAttachmentWriteLock(() => {
      const saved = localStorage.getItem('selection');
      if (saved !== expected) return { conflict: saved };
      localStorage.setItem('selection', next);
      return { saved: next };
    });`;
  const bundle = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({ entry, root: process.cwd() }) });
  const script = JSON.parse(bundle).find(file => file.path.endsWith('.js')).text;
  server = createServer((request, response) => {
    if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });

describe('attachment write coordination', () => {
  it('waits while another tab holds the read-write transaction', async () => {
    const context = await browser.newContext();
    try {
      const first = await context.newPage(), second = await context.newPage();
      await Promise.all([first.goto(origin), second.goto(origin)]);
      await first.evaluate(() => new Promise((resolve, reject) => {
        const opening = indexedDB.open('terminal-v4-file-selection-lock', 1);
        opening.onupgradeneeded = () => opening.result.createObjectStore('lock');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const transaction = opening.result.transaction('lock', 'readwrite');
          const store = transaction.objectStore('lock');
          window.releaseFixtureLock = false;
          let announced = false;
          const keepAlive = () => {
            const request = store.get('selection');
            request.onsuccess = () => {
              if (!announced) { announced = true; resolve(); }
              if (!window.releaseFixtureLock) keepAlive();
            };
          };
          keepAlive();
        };
      }));
      await second.evaluate(() => { window.fixtureResult = 'pending'; window.attempt(null, 'second').then(value => { window.fixtureResult = value; }); });
      await second.waitForTimeout(150);
      expect(await second.evaluate(() => window.fixtureResult)).toBe('pending');
      expect(await second.evaluate(() => localStorage.getItem('selection'))).toBeNull();
      await first.evaluate(() => { window.releaseFixtureLock = true; });
      await expect.poll(() => second.evaluate(() => window.fixtureResult)).toEqual({ saved: 'second' });
    } finally { await context.close(); }
  }, 15000);

  it('serializes competing tabs and preserves the later conflicting selection', async () => {
    const context = await browser.newContext();
    try {
      const first = await context.newPage(), second = await context.newPage();
      await Promise.all([first.goto(origin), second.goto(origin)]);
      const results = await Promise.all([
        first.evaluate(() => window.attempt(null, 'first')),
        second.evaluate(() => window.attempt(null, 'second')),
      ]);
      expect(results.filter(result => result.saved)).toHaveLength(1);
      expect(results.filter(result => result.conflict)).toHaveLength(1);
      expect(results.find(result => result.conflict).conflict).toBe(results.find(result => result.saved).saved);
      expect(await first.evaluate(() => localStorage.getItem('selection'))).toBe(results.find(result => result.saved).saved);
    } finally { await context.close(); }
  }, 15000);

  it('refuses to run the write when IndexedDB is unavailable', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
      await page.goto(origin);
      const outcome = await page.evaluate(() => window.attempt(null, 'not-saved').then(() => 'unexpected', () => 'unavailable'));
      expect(outcome).toBe('unavailable');
      expect(await page.evaluate(() => localStorage.getItem('selection'))).toBeNull();
    } finally { await context.close(); }
  }, 15000);
});
