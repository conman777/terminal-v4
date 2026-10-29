import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const frontend = process.cwd();
const evidence = resolve(frontend, '../output/overnight-polish-20261025/console-completion');
const layouts = [
  { theme: 'dark', width: 980, hasTouch: false, label: 'dark-fine' },
  { theme: 'light', width: 360, hasTouch: true, label: 'light-coarse' },
];
const makeLogs = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  id: `synthetic-${offset + index}`, timestamp: 1000 + offset + index,
  message: `Synthetic console row ${offset + index}`,
  level: (offset + index) % 7 === 0 ? 'error' : 'log',
}));

describe.runIf(process.env.E2E_CONSOLE_HELPERS === '1')('live React ConsoleTab shared helpers in managed Chromium', () => {
  let browser, script, css;

  beforeAll(async () => {
    function compileFixture() {
      const { build } = require('esbuild');
      build({
        stdin: {
          contents: `import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { ConsoleTab } from './ConsoleTab.jsx';
          const root = createRoot(document.getElementById('fixture'));
          let logs = [];
          window.setConsoleLogs = next => {
            logs = next;
            flushSync(() => root.render(<ConsoleTab logs={logs} previewPort={4173}
              onClear={() => window.setConsoleLogs([])} onEvaluate={() => {}} />));
          };
          window.appendConsoleLogs = next => window.setConsoleLogs([...logs, ...next]);
          window.rollConsoleLogs = next => window.setConsoleLogs([...logs, ...next].slice(-200));`,
          loader: 'jsx', resolveDir: process.argv[1],
        },
        bundle: true, write: false, format: 'iife', jsx: 'automatic',
        loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
      }).then(result => process.stdout.write(result.outputFiles[0].text));
    }
    // Match the existing browser fixtures: esbuild runs in Node's typed-array realm.
    script = execFileSync(process.execPath, ['-e', `(${compileFixture.toString()})()`, resolve(frontend, 'src/components/devtools')], {
      cwd: frontend, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    css = (await Promise.all(['styles.css', 'WorkspaceUI.css', 'devtools.css', 'components/devtools/ConsoleTab.css',
      ...['JsonTreeView', 'LogViewer', 'FilterBar'].map(name => `components/devtools/shared/${name}.css`)]
      .map(name => readFile(resolve(frontend, 'src', name), 'utf8')))).join('\n');
    const runtime = resolve(frontend, '../.runtime/browser');
    const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
    browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
    await mkdir(evidence, { recursive: true });
  }, 30000);

  afterAll(async () => { await browser?.close(); });

  async function mount(layout, logs, run) {
    const context = await browser.newContext({ viewport: { width: layout.width, height: 520 }, hasTouch: layout.hasTouch, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    page.setDefaultTimeout(2000);
    try {
      await page.setContent(`<!doctype html><html data-theme="${layout.theme}"><style>${css}</style>
        <style>body{margin:0}#fixture{height:360px;overflow:hidden}</style>
        <div class="devtools-panel"><div class="devtools-content"><div id="fixture"></div></div></div></html>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(value => window.setConsoleLogs(value), logs);
      await page.locator('.console-tab').waitFor();
      await run(page);
      expect({ errors, requests }).toEqual({ errors: [], requests: [] });
    } finally { await context.close(); }
  }

  async function tabTo(page, target) {
    for (let count = 0; count < 40; count++) {
      await page.keyboard.press('Tab');
      if (await target.evaluateAll(nodes => nodes.some(node => node === document.activeElement))) return;
    }
    throw new Error(`Native Tab never reached ${await target.count()} matching disclosure buttons`);
  }

  async function scrollState(page) {
    return page.locator('.log-viewer').evaluate(node => ({
      top: node.scrollTop, height: node.clientHeight, extent: node.scrollHeight,
      gap: node.scrollHeight - node.clientHeight - node.scrollTop,
    }));
  }

  it.each(layouts)('uses native Tab, Enter and Space for root/nested objects and arrays ($label)', async layout => {
    await mount(layout, [
      { id: 'object', timestamp: 1000, level: 'log', message: JSON.stringify({ items: [{ leaf: 'array leaf' }], details: { label: 'object leaf' } }) },
      { id: 'array', timestamp: 2000, level: 'log', message: JSON.stringify(['root array leaf']) },
    ], async page => {
      const root = page.getByRole('button', { name: 'Expand object at root', exact: true });
      await tabTo(page, root);
      await page.keyboard.press('Enter');
      const openRoot = page.getByRole('button', { name: 'Collapse object at root', exact: true });
      expect(await openRoot.getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Space');
      expect(await root.getAttribute('aria-expanded')).toBe('false');
      await page.keyboard.press('Enter');

      const items = page.getByRole('button', { name: 'Expand array at root.items', exact: true });
      await tabTo(page, items);
      await page.keyboard.press('Space');
      expect(await page.getByRole('button', { name: 'Collapse array at root.items', exact: true }).getAttribute('aria-expanded')).toBe('true');
      await page.keyboard.press('Enter');
      expect(await items.getAttribute('aria-expanded')).toBe('false');
      await page.keyboard.press('Space');
      const item = page.getByRole('button', { name: 'Expand object at root.items[0]', exact: true });
      await tabTo(page, item);
      await page.keyboard.press('Enter');
      expect(await page.getByText('"array leaf"', { exact: true }).isVisible()).toBe(true);
      await page.keyboard.press('Space');
      expect(await page.getByText('"array leaf"', { exact: true }).count()).toBe(0);

      const details = page.getByRole('button', { name: 'Expand object at root.details', exact: true });
      await tabTo(page, details);
      await page.keyboard.press('Space');
      expect(await page.getByText('"object leaf"', { exact: true }).isVisible()).toBe(true);
      await page.keyboard.press('Enter');
      expect(await page.getByText('"object leaf"', { exact: true }).count()).toBe(0);

      const array = page.getByRole('button', { name: 'Expand array at root', exact: true });
      await tabTo(page, array);
      await page.keyboard.press('Enter');
      expect(await page.getByText('"root array leaf"', { exact: true }).isVisible()).toBe(true);
      await page.keyboard.press('Space');
      expect(await array.getAttribute('aria-expanded')).toBe('false');
      const targets = await page.locator('.json-toggle').evaluateAll(nodes => nodes.map(node => ({
        native: node.tagName === 'BUTTON', width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height, name: node.getAttribute('aria-label'),
      })));
      expect(targets.every(target => target.native && target.name && target.width >= (layout.hasTouch ? 44 : 24) && target.height >= (layout.hasTouch ? 44 : 24))).toBe(true);
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-keyboard-${layout.label}.png`) });
      await writeFile(resolve(evidence, `browser-keyboard-${layout.label}.json`), JSON.stringify({ targets, nativeKeys: ['Tab', 'Enter', 'Space'] }, null, 2));
    });
  }, 15000);

  it.each(layouts)('retains a reader on append, resumes following and resets filters safely ($label)', async layout => {
    await mount(layout, makeLogs(160), async page => {
      const viewer = page.locator('.log-viewer');
      await viewer.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await viewer.hover();
      await page.mouse.wheel(0, -700);
      await expect.poll(async () => (await scrollState(page)).gap).toBeGreaterThan(500);
      const before = await scrollState(page);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(3, 160));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(163);
      const retained = await scrollState(page);
      await writeFile(resolve(evidence, `browser-scroll-${layout.label}.json`), JSON.stringify({ before, retained }, null, 2));
      expect(Math.abs(retained.top - before.top)).toBeLessThanOrEqual(1);
      const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
      expect(await jump.isVisible()).toBe(true);
      await jump.click();
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(2, 163));
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);

      await viewer.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 24; });
      await expect.poll(async () => Math.round((await scrollState(page)).gap)).toBe(24);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(2, 165));
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await viewer.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 33; });
      await expect.poll(() => jump.isVisible()).toBe(true);
      const outsideThreshold = await scrollState(page);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(1, 167));
      expect(Math.abs((await scrollState(page)).top - outsideThreshold.top)).toBeLessThanOrEqual(1);
      await jump.click();
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await viewer.hover();
      await page.mouse.wheel(0, -700);
      await expect.poll(async () => (await scrollState(page)).gap).toBeGreaterThan(500);
      await page.getByRole('button', { name: /Errors/ }).click();
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(24);
      expect((await scrollState(page)).top).toBe(0);
      expect(await page.locator('.console-log').evaluateAll(nodes => nodes.every(node => node.classList.contains('console-error')))).toBe(true);
      expect(await page.getByRole('button', { name: /Errors/ }).getAttribute('aria-pressed')).toBe('true');
      await page.getByRole('button', { name: /^All/ }).click();
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(168);
      expect((await scrollState(page)).top).toBe(0);
      await viewer.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await expect.poll(() => jump.count()).toBe(0);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(1, 168));
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      const search = page.getByPlaceholder('Filter console...');
      await search.fill('no matching synthetic message');
      expect(await page.getByText('No logs match filters', { exact: true }).isVisible()).toBe(true);
      await page.getByTitle('Clear search', { exact: true }).click();
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(169);
      await viewer.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(1, 169));
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await writeFile(resolve(evidence, `browser-scroll-${layout.label}.json`), JSON.stringify({ before, retained, outsideThreshold, final: await scrollState(page) }, null, 2));
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-scroll-${layout.label}.png`) });
    });
  }, 15000);

  it.each(layouts)('retains the visible marker and follows the bottom through a rolling 200-log cap ($label)', async layout => {
    await mount(layout, makeLogs(200), async page => {
      const viewer = page.locator('.log-viewer');
      await viewer.hover();
      await page.mouse.wheel(0, -1700);
      await expect.poll(async () => (await scrollState(page)).gap).toBeGreaterThan(1500);
      await expect.poll(() => page.getByRole('button', { name: 'Jump to latest', exact: true }).isVisible()).toBe(true);
      const marker = await viewer.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const row = [...node.querySelectorAll('.log-viewer-row')].find(row => {
          const box = row.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        return { text: row.querySelector('.console-text').textContent, y: row.getBoundingClientRect().top - bounds.top, scrollTop: node.scrollTop };
      });
      await page.evaluate(value => window.rollConsoleLogs(value), makeLogs(1, 200));
      const retained = await page.getByText(marker.text, { exact: true }).evaluate(node => ({
        y: node.closest('.log-viewer-row').getBoundingClientRect().top - document.querySelector('.log-viewer').getBoundingClientRect().top,
        scrollTop: document.querySelector('.log-viewer').scrollTop,
      }));
      await writeFile(resolve(evidence, `browser-rolling-${layout.label}.json`), JSON.stringify({ marker, retained }, null, 2));
      expect(Math.abs(retained.y - marker.y)).toBeLessThanOrEqual(1);
      expect(await page.getByText('Synthetic console row 0', { exact: true }).count()).toBe(0);
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(200);
      await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      await page.evaluate(value => window.rollConsoleLogs(value), makeLogs(1, 201));
      await expect.poll(async () => (await scrollState(page)).gap).toBeLessThanOrEqual(1);
      expect(await page.getByText('Synthetic console row 201', { exact: true }).isVisible()).toBe(true);
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-rolling-${layout.label}.png`) });
      await writeFile(resolve(evidence, `browser-rolling-${layout.label}.json`), JSON.stringify({ marker, retained, final: await scrollState(page) }, null, 2));
    });
  }, 15000);

  it.each(layouts)('keeps empty and long-list controls inside the pane ($label)', async layout => {
    await mount(layout, [], async page => {
      expect(await page.getByText('No console logs', { exact: true }).isVisible()).toBe(true);
      expect(await page.locator('.log-viewer-latest').count()).toBe(0);
      await page.evaluate(value => window.setConsoleLogs(value), makeLogs(1000));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(1000);
      await page.getByText('Synthetic console row 999', { exact: true }).scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const fixture = document.querySelector('#fixture');
        const bounds = fixture.getBoundingClientRect();
        const viewer = document.querySelector('.log-viewer');
        const repl = document.querySelector('.console-repl').getBoundingClientRect();
        const rows = [...document.querySelectorAll('.log-viewer-row')];
        const minTarget = matchMedia('(pointer: coarse)').matches ? 44 : 32;
        return {
          coarse: matchMedia('(pointer: coarse)').matches,
          overflow: fixture.scrollWidth > fixture.clientWidth || document.body.scrollWidth > innerWidth,
          scrollable: viewer.scrollHeight > viewer.clientHeight,
          replFits: repl.top >= bounds.top && repl.bottom <= bounds.bottom + 1,
          viewerFits: viewer.getBoundingClientRect().bottom <= repl.top + 1,
          overlapping: rows.slice(0, -1).some((row, index) => row.getBoundingClientRect().bottom > rows[index + 1].getBoundingClientRect().top + 1),
          filterTargets: [...document.querySelectorAll('.devtools-filter-btn')].every(node => node.getBoundingClientRect().height >= minTarget),
        };
      });
      expect(geometry).toEqual({ coarse: layout.hasTouch, overflow: false, scrollable: true, replFits: true, viewerFits: true, overlapping: false, filterTargets: true });
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-long-list-${layout.label}.png`) });
      await writeFile(resolve(evidence, `browser-long-list-${layout.label}.json`), JSON.stringify(geometry, null, 2));
      await page.getByTitle('Clear console', { exact: true }).click();
      expect(await page.getByText('No console logs', { exact: true }).isVisible()).toBe(true);
    });
  }, 15000);
});
