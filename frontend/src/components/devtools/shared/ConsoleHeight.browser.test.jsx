import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const frontend = process.cwd();
const evidence = resolve(frontend, '../output/overnight-polish-20261025/console-height-completion');
const stage = process.env.CONSOLE_HEIGHT_STAGE || 'green';
const layouts = [
  ...[140, 220, 320].map(height => ({ width: 1440, height, hasTouch: false, theme: 'dark' })),
  ...[190, 280].map(height => ({ width: 980, height, hasTouch: false, theme: 'light' })),
  ...[140, 220, 320].map(height => ({ width: 1024, height, hasTouch: true, theme: 'light' })),
  ...[140, 190, 220, 280, 320].map(height => ({ width: 360, height, hasTouch: true, theme: 'dark' })),
].map(layout => ({ ...layout, label: `${layout.width}-${layout.height}-${layout.hasTouch ? 'coarse' : 'fine'}` }));
const makeLogs = (count, offset = 0) => Array.from({ length: count }, (_, index) => ({
  id: `height-${offset + index}`, timestamp: 1000 + offset + index,
  message: `Height row ${offset + index}`,
  level: ['log', 'warn', 'error', 'info', 'debug'][(offset + index) % 5],
}));

describe.runIf(process.env.E2E_CONSOLE_HEIGHT === '1')('live DevToolsPanel bounded Console height', () => {
  let browser, script, css, sourceHashes;

  beforeAll(async () => {
    function compileFixture() {
      const { build } = require('esbuild');
      build({
        stdin: {
          contents: `import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { flushSync } from 'react-dom';
            import { DevToolsPanel } from './DevToolsPanel.jsx';
            const root = createRoot(document.getElementById('fixture'));
            let logs = [];
            window.evaluatedExpressions = [];
            window.setConsoleLogs = next => {
              logs = next;
              flushSync(() => root.render(<>
                <div className="preview-logs-resize-handle" role="separator" tabIndex={0}
                  aria-label="Resize DevTools" aria-orientation="horizontal">
                  <span className="preview-logs-resize-label">Drag to resize DevTools</span>
                </div>
                <DevToolsPanel consoleLogs={logs} previewPort={4173}
                  onClearConsole={() => window.setConsoleLogs([])}
                  onEvaluate={expression => window.evaluatedExpressions.push(expression)} />
              </>));
            };
            window.appendConsoleLogs = next => window.setConsoleLogs([...logs, ...next]);
            window.rollConsoleLogs = next => window.setConsoleLogs([...logs, ...next].slice(-200));`,
          loader: 'jsx', resolveDir: process.argv[1],
        },
        bundle: true, write: false, format: 'iife', jsx: 'automatic',
        loader: { '.css': 'empty' },
        define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
      }).then(result => process.stdout.write(result.outputFiles[0].text));
    }
    script = execFileSync(process.execPath, ['-e', `(${compileFixture.toString()})()`, resolve(frontend, 'src/components/devtools')], {
      cwd: frontend, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    // PreviewPanel imports DevTools before its local CSS; helpers precede ConsoleTab.
    const styles = ['styles.css', 'WorkspaceUI.css', 'devtools.css',
      ...['FilterBar', 'LogViewer', 'JsonTreeView'].map(name => `components/devtools/shared/${name}.css`),
      'components/devtools/ConsoleTab.css', 'components/preview/PreviewPanel.css'];
    css = (await Promise.all(styles.map(name => readFile(resolve(frontend, 'src', name), 'utf8')))).join('\n');
    const sources = [...styles, 'components/devtools/DevToolsPanel.jsx', 'components/devtools/ConsoleTab.jsx',
      'components/devtools/shared/LogViewer.jsx', 'components/PreviewPanel.jsx'];
    sourceHashes = Object.fromEntries(await Promise.all(sources.map(async name => [name,
      createHash('sha256').update(await readFile(resolve(frontend, 'src', name))).digest('hex')])));
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, `browser-${stage}-sources.json`), JSON.stringify(sourceHashes, null, 2));
    const runtime = resolve(frontend, '../.runtime/browser');
    const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
    browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
  }, 30000);

  afterAll(async () => { await browser?.close(); });

  async function mount(layout, logs, run) {
    const context = await browser.newContext({ viewport: { width: layout.width, height: 620 },
      hasTouch: layout.hasTouch, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], requests = [], measurements = { layout };
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    page.setDefaultTimeout(3000);
    try {
      await page.setContent(`<!doctype html><html data-theme="${layout.theme}"><style>${css}</style>
        <style>body{margin:0}#height-host{height:620px}#fixture{height:${layout.height}px;max-height:none}</style>
        <div id="height-host" class="preview-panel"><div id="fixture" class="preview-logs expanded"></div></div></html>`);
      await page.addScriptTag({ content: script });
      await page.evaluate(value => window.setConsoleLogs(value), logs);
      await page.getByRole('button', { name: /^Console/ }).click();
      await page.locator('.console-tab').waitFor();
      await run(page, measurements);
      expect({ errors, requests }).toEqual({ errors: [], requests: [] });
    } finally {
      measurements.errors = errors;
      measurements.requests = requests;
      await writeFile(resolve(evidence, `browser-${stage}-${layout.label}.json`), JSON.stringify(measurements, null, 2));
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-${stage}-${layout.label}.png`) });
      await context.close();
    }
  }

  async function geometry(page) {
    return page.evaluate(() => {
      const rect = node => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, width: box.width };
      };
      const clipped = node => {
        const box = rect(node);
        const visible = { ...box, top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom),
          left: Math.max(0, box.left), right: Math.min(innerWidth, box.right) };
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
            visible.top = Math.max(visible.top, bounds.top + ancestor.clientTop);
            visible.bottom = Math.min(visible.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
          }
          if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
            visible.left = Math.max(visible.left, bounds.left + ancestor.clientLeft);
            visible.right = Math.min(visible.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
          }
        }
        return { ...visible, height: Math.max(0, visible.bottom - visible.top), width: Math.max(0, visible.right - visible.left) };
      };
      const viewer = document.querySelector('.log-viewer'), pane = document.querySelector('#fixture');
      const completeRows = [...document.querySelectorAll('.log-viewer-row')].flatMap(row => {
        const text = row.querySelector('.console-text');
        if (!text) return [];
        const box = rect(row), visible = clipped(row), range = document.createRange();
        range.selectNodeContents(text);
        const fragments = [...range.getClientRects()];
        return box.top >= visible.top - 0.5 && box.bottom <= visible.bottom + 0.5 && fragments.length &&
          fragments.every(fragment => fragment.top >= visible.top - 0.5 && fragment.bottom <= visible.bottom + 0.5 &&
            fragment.left >= visible.left - 0.5 && fragment.right <= visible.right + 0.5)
          ? [{ text: text.textContent, top: box.top, height: box.height }] : [];
      });
      const consoleTab = document.querySelector('.console-tab');
      return { viewer: viewer && { ...rect(viewer), visible: clipped(viewer), clientHeight: viewer.clientHeight,
        scrollTop: viewer.scrollTop, scrollHeight: viewer.scrollHeight,
        gap: viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop },
      completeRows, pane: rect(pane), coarse: matchMedia('(pointer: coarse)').matches,
      outer: { top: consoleTab.scrollTop, height: consoleTab.clientHeight, extent: consoleTab.scrollHeight,
        overflowY: getComputedStyle(consoleTab).overflowY },
      horizontalOverflow: [pane, consoleTab, viewer].filter(Boolean).some(node => node.scrollWidth > node.clientWidth),
      pageOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight || document.body.scrollHeight > innerHeight };
    });
  }

  async function revealReader(page) {
    const viewer = page.locator('.log-viewer');
    if (await viewer.getAttribute('tabindex') === '0') {
      await tabTo(page, viewer);
    } else {
      await viewer.scrollIntoViewIfNeeded();
    }
    await settleLayout(page);
  }

  async function tabTo(page, target) {
    for (let count = 0; count < 50; count++) {
      await page.keyboard.press('Tab');
      if (await target.evaluateAll(nodes => nodes.includes(document.activeElement))) return;
    }
    throw new Error('Native Tab did not reach the requested Console control');
  }

  async function settleLayout(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
      let previous, stable = 0, frames = 0;
      const sample = () => {
        const nodes = [document.querySelector('.console-tab'), document.querySelector('.console-content'),
          document.querySelector('.log-viewer'), document.activeElement];
        const state = JSON.stringify(nodes.map(node => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return [node.scrollTop, node.scrollHeight, node.clientHeight, box.top, box.bottom, box.left, box.right];
        }));
        stable = state === previous ? stable + 1 : 0;
        previous = state;
        frames++;
        if (stable >= 5) resolve({ frames, stableFrames: stable });
        else if (frames >= 60) reject(new Error(`Console geometry did not settle in 60 animation frames: ${state}`));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
  }

  async function pauseReader(page) {
    const viewer = page.locator('.log-viewer');
    await revealReader(page);
    const visible = (await geometry(page)).viewer.visible;
    await page.mouse.move((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2);
    await page.mouse.wheel(0, -700);
    await expect.poll(async () => (await geometry(page)).viewer.gap).toBeGreaterThan(300);
    await expect.poll(() => page.getByRole('button', { name: 'Jump to latest', exact: true }).count()).toBe(1);
    await revealReader(page);
  }

  it('keeps one complete row readable at the previous default 220px while paused', async () => {
    await mount({ width: 1440, height: 220, hasTouch: false, theme: 'dark', label: 'default-220' }, makeLogs(100), async (page, measured) => {
      await pauseReader(page);
      measured.paused = await geometry(page);
      expect(measured.paused.completeRows.length).toBeGreaterThanOrEqual(1);
      expect(measured.paused.pageOverflow).toBe(false);
    });
  });

  async function reachable(page, target) {
    const beforeFocus = await geometry(page);
    await tabTo(page, target);
    const settled = await settleLayout(page);
    const focused = await target.evaluate(node => {
      const box = node.getBoundingClientRect();
      const visible = { top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom),
        left: Math.max(0, box.left), right: Math.min(innerWidth, box.right) };
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          visible.top = Math.max(visible.top, bounds.top + parent.clientTop);
          visible.bottom = Math.min(visible.bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          visible.left = Math.max(visible.left, bounds.left + parent.clientLeft);
          visible.right = Math.min(visible.right, bounds.left + parent.clientLeft + parent.clientWidth);
        }
      }
      const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
      return { focused: node === document.activeElement,
        complete: box.top >= visible.top - 1 && box.bottom <= visible.bottom + 1 &&
          box.left >= visible.left - 1 && box.right <= visible.right + 1,
        hit: hit === node || node.contains(hit), width: box.width, height: box.height,
        tag: node.tagName, outerScroll: document.querySelector('.console-tab').scrollTop,
        bounds: { top: box.top, bottom: box.bottom, left: box.left, right: box.right }, visible };
    });
    if (!focused.focused || !focused.complete || !focused.hit) {
      const viewport = page.viewportSize();
      const paneHeight = await page.locator('#fixture').evaluate(node => node.getBoundingClientRect().height);
      await writeFile(resolve(evidence, `browser-${stage}-focus-failure-${viewport.width}-${paneHeight}.json`),
        JSON.stringify({ target: await target.getAttribute('aria-label'), beforeFocus, focused, settled, geometry: await geometry(page) }, null, 2));
    }
    expect(focused, 'Native focus must reveal the whole target within all clipping ancestors').toMatchObject({ focused: true, complete: true, hit: true });
    return { ...focused, settled };
  }

  async function activate(page, target, layout) {
    if (layout.hasTouch) await target.tap();
    else await target.click();
  }

  async function marker(page, text) {
    return page.getByText(text, { exact: true }).evaluate(node => {
      const viewer = document.querySelector('.log-viewer');
      const box = node.closest('.log-viewer-row').getBoundingClientRect();
      return { text: node.textContent, screenY: box.top,
        viewerY: box.top - viewer.getBoundingClientRect().top,
        scrollTop: viewer.scrollTop, outerScroll: document.querySelector('.console-tab').scrollTop };
    });
  }

  it.each(layouts)('keeps rows, reading position, controls and scrolling bounded ($label)', async layout => {
    await mount(layout, makeLogs(200), async (page, measured) => {
      const viewer = page.getByRole('region', { name: 'Console logs', exact: true });
      expect(await viewer.getAttribute('tabindex')).toBe('0');
      await revealReader(page);
      measured.following = await geometry(page);
      expect(measured.following.coarse).toBe(layout.hasTouch);
      expect(measured.following.viewer.gap).toBeLessThanOrEqual(1);
      expect(measured.following.completeRows.length).toBeGreaterThanOrEqual(1);
      expect(measured.following.pageOverflow).toBe(false);
      expect(measured.following.horizontalOverflow).toBe(false);

      await pauseReader(page);
      measured.paused = await geometry(page);
      expect(measured.paused.completeRows.length).toBeGreaterThanOrEqual(1);
      const text = measured.paused.completeRows[0].text;
      measured.beforeAppend = await marker(page, text);
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(3, 200));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(203);
      await settleLayout(page);
      measured.afterAppend = await marker(page, text);
      expect(Math.abs(measured.afterAppend.screenY - measured.beforeAppend.screenY)).toBeLessThanOrEqual(1);
      expect(Math.abs(measured.afterAppend.viewerY - measured.beforeAppend.viewerY)).toBeLessThanOrEqual(1);
      await page.evaluate(value => window.rollConsoleLogs(value), makeLogs(2, 203));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(200);
      await settleLayout(page);
      measured.afterRolling = await marker(page, text);
      expect(Math.abs(measured.afterRolling.screenY - measured.beforeAppend.screenY)).toBeLessThanOrEqual(1);
      expect(Math.abs(measured.afterRolling.viewerY - measured.beforeAppend.viewerY)).toBeLessThanOrEqual(1);

      const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
      measured.jumpTarget = await reachable(page, jump);
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await geometry(page)).viewer.gap).toBeLessThanOrEqual(1);
      await page.evaluate(value => window.rollConsoleLogs(value), makeLogs(1, 205));
      await expect.poll(async () => (await geometry(page)).viewer.gap).toBeLessThanOrEqual(1);
      await revealReader(page);
      measured.resumed = await geometry(page);
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowDown');
      measured.afterNativeEnd = await geometry(page);
      expect(measured.afterNativeEnd.completeRows.length).toBeGreaterThanOrEqual(1);
      expect(measured.afterNativeEnd.viewer.gap).toBeLessThanOrEqual(1);
      await pauseReader(page);
      await reachable(page, jump);
      await activate(page, jump, layout);
      await expect.poll(async () => (await geometry(page)).viewer.gap).toBeLessThanOrEqual(1);

      measured.controls = [];
      const filters = page.locator('.devtools-filter-btn');
      for (let index = 0; index < 6; index++) {
        const filter = filters.nth(index);
        measured.controls.push({ name: await filter.innerText(), ...await reachable(page, filter) });
        await page.keyboard.press(index % 2 ? 'Space' : 'Enter');
        expect(await filter.getAttribute('aria-pressed')).toBe('true');
        await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(index === 0 ? 200 : 40);
        await activate(page, filter, layout);
        expect(await filter.getAttribute('aria-pressed')).toBe('true');
      }
      await activate(page, filters.first(), layout);
      const search = page.getByPlaceholder('Filter console...');
      measured.controls.push({ name: 'Search', ...await reachable(page, search) });
      await activate(page, search, layout);
      await page.keyboard.type('Height row 19');
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(11);
      const clearSearch = page.getByTitle('Clear search', { exact: true });
      measured.controls.push({ name: 'Clear search', ...await reachable(page, clearSearch) });
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(200);
      await reachable(page, search);
      await page.keyboard.type('no matching height text');
      await expect.poll(() => page.getByText('No logs match filters', { exact: true }).count()).toBe(1);
      await activate(page, clearSearch, layout);
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(200);

      const expression = page.getByRole('textbox', { name: 'JavaScript expression', exact: true });
      measured.controls.push({ name: 'REPL input', ...await reachable(page, expression) });
      await activate(page, expression, layout);
      await page.keyboard.type('1 + 2');
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.evaluatedExpressions)).toEqual(['1 + 2']);
      await page.keyboard.type('3 + 4');
      const run = page.getByRole('button', { name: 'Run', exact: true });
      measured.controls.push({ name: 'Run', ...await reachable(page, run) });
      await activate(page, run, layout);
      await expect.poll(() => page.evaluate(() => window.evaluatedExpressions)).toEqual(['1 + 2', '3 + 4']);
      const clear = page.getByTitle('Clear console', { exact: true });
      measured.controls.push({ name: 'Clear console', ...await reachable(page, clear) });
      await activate(page, clear, layout);
      await expect.poll(() => page.getByText('No console logs', { exact: true }).count()).toBe(1);
      await reachable(page, expression);
      measured.empty = await geometry(page);
      expect(measured.empty.pageOverflow).toBe(false);
      await page.evaluate(value => window.setConsoleLogs(value), makeLogs(1000));
      await revealReader(page);
      measured.longList = await geometry(page);
      expect(measured.longList.completeRows.length).toBeGreaterThanOrEqual(1);
      expect(measured.longList.pageOverflow).toBe(false);
      expect(measured.longList.horizontalOverflow).toBe(false);
      expect(measured.longList.viewer.gap).toBeLessThanOrEqual(1);
      expect(measured.longList.outer.extent).toBeLessThan(650);
      expect(measured.longList.pane.height).toBeLessThanOrEqual(Math.max(150, layout.height));
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-${stage}-${layout.label}-reading.png`) });
    });
  }, 30000);

  async function textVisibility(target) {
    return target.evaluate(node => {
      const box = node.getBoundingClientRect();
      const visible = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          visible.top = Math.max(visible.top, bounds.top + parent.clientTop);
          visible.bottom = Math.min(visible.bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          visible.left = Math.max(visible.left, bounds.left + parent.clientLeft);
          visible.right = Math.min(visible.right, bounds.left + parent.clientLeft + parent.clientWidth);
        }
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const fragments = [...range.getClientRects()].map(fragment => ({
        top: fragment.top, bottom: fragment.bottom, left: fragment.left, right: fragment.right,
      }));
      return { text: node.textContent, top: box.top, bottom: box.bottom, visible, fragments,
        complete: fragments.length > 0 && fragments.every(fragment => fragment.top >= visible.top - 0.5 &&
          fragment.bottom <= visible.bottom + 0.5 && fragment.left >= visible.left - 0.5 && fragment.right <= visible.right + 0.5) };
    });
  }

  async function wheelToLeaf(page, target) {
    let settled = await settleLayout(page);
    for (let step = 0; step < 50; step++) {
      const leaf = await textVisibility(target);
      if (leaf.complete) return { ...leaf, nativeWheelSteps: step, settled };
      const visible = (await geometry(page)).viewer.visible;
      await page.mouse.move((visible.left + visible.right) / 2, (visible.top + visible.bottom) / 2);
      await page.mouse.wheel(0, leaf.top < visible.top ? -24 : 24);
      settled = await settleLayout(page);
    }
    throw new Error(`Native reader scrolling did not fully reveal leaf: ${JSON.stringify(await textVisibility(target))}`);
  }

  const objectLayouts = [
    { width: 1440, height: 140, hasTouch: false, theme: 'dark' },
    { width: 980, height: 220, hasTouch: false, theme: 'light' },
    { width: 1024, height: 140, hasTouch: true, theme: 'light' },
    { width: 360, height: 220, hasTouch: true, theme: 'dark' },
  ].map(layout => ({ ...layout, label: `objects-${layout.width}-${layout.height}-${layout.hasTouch ? 'coarse' : 'fine'}` }));

  it.each(objectLayouts)('reveals nested object and long-array leaves through native controls and scrolling ($label)', async layout => {
    const logs = makeLogs(200);
    logs[190] = { ...logs[190], message: JSON.stringify({
      details: { message: 'Nested detail leaf' },
      items: Array.from({ length: 24 }, (_, index) => `Array leaf ${index}`),
    }) };
    await mount(layout, logs, async (page, measured) => {
      const root = page.getByRole('button', { name: 'Expand object at root', exact: true });
      measured.root = await reachable(page, root);
      await page.keyboard.press('Enter');
      const details = page.getByRole('button', { name: 'Expand object at root.details', exact: true });
      measured.details = await reachable(page, details);
      await page.keyboard.press('Space');
      measured.objectLeaf = await wheelToLeaf(page, page.getByText('"Nested detail leaf"', { exact: true }));
      expect(measured.objectLeaf.complete).toBe(true);
      const array = page.getByRole('button', { name: 'Expand array at root.items', exact: true });
      measured.array = await reachable(page, array);
      await activate(page, array, layout);
      const collapseArray = page.getByRole('button', { name: 'Collapse array at root.items', exact: true });
      expect(await collapseArray.getAttribute('aria-expanded')).toBe('true');
      measured.arrayLeaf = await wheelToLeaf(page, page.getByText('"Array leaf 23"', { exact: true }));
      expect(measured.arrayLeaf.complete).toBe(true);
      expect(measured.arrayLeaf.nativeWheelSteps).toBeGreaterThan(0);
      const leaf = page.getByText('"Array leaf 23"', { exact: true });
      await page.evaluate(value => window.appendConsoleLogs(value), makeLogs(3, 200));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(203);
      measured.appendImmediate = { leaf: await textVisibility(leaf), geometry: await geometry(page) };
      measured.appendSettled = await settleLayout(page);
      measured.expandedAfterAppend = await textVisibility(leaf);
      expect(measured.expandedAfterAppend.complete).toBe(true);
      expect(Math.abs(measured.expandedAfterAppend.top - measured.arrayLeaf.top)).toBeLessThanOrEqual(1);
      await page.evaluate(value => window.rollConsoleLogs(value), makeLogs(2, 203));
      await expect.poll(() => page.locator('.log-viewer-row').count()).toBe(200);
      measured.rollingImmediate = { leaf: await textVisibility(leaf), geometry: await geometry(page) };
      measured.rollingSettled = await settleLayout(page);
      measured.expandedAfterRolling = await textVisibility(leaf);
      expect(measured.expandedAfterRolling.complete).toBe(true);
      expect(Math.abs(measured.expandedAfterRolling.top - measured.arrayLeaf.top)).toBeLessThanOrEqual(1);
      measured.expanded = await geometry(page);
      expect(measured.expanded.pageOverflow).toBe(false);
      expect(measured.expanded.horizontalOverflow).toBe(false);
      expect(measured.expanded.outer.extent).toBeLessThan(650);
      expect(measured.expanded.pane.height).toBeLessThanOrEqual(Math.max(150, layout.height));
      await page.locator('#fixture').screenshot({ path: resolve(evidence, `browser-${stage}-${layout.label}-leaf.png`) });
      await reachable(page, collapseArray);
      await page.keyboard.press('Space');
      expect(await array.getAttribute('aria-expanded')).toBe('false');
      await reachable(page, array);
      await page.keyboard.press('Enter');
      expect(await collapseArray.getAttribute('aria-expanded')).toBe('true');
      await reachable(page, page.getByRole('button', { name: 'Collapse object at root', exact: true }));
      await page.keyboard.press('Space');
      expect(await root.getAttribute('aria-expanded')).toBe('false');
      measured.collapsed = await geometry(page);
      expect(measured.collapsed.pageOverflow).toBe(false);
    });
  }, 15000);
});
