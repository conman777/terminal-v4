import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PerformanceTab } from '../PerformanceTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({ apiFetch: vi.fn() }));

describe.runIf(process.env.E2E_PERFORMANCE_LAYOUT === '1')('PerformanceTab actual CSS in bounded Chromium pane', () => {
  let browser, css;
  beforeAll(async () => {
    css = (await Promise.all(['../../../styles.css', '../../../WorkspaceUI.css', '../../../devtools.css', '../PerformanceTab.css'].map(path =>
      readFile(new URL(path, import.meta.url), 'utf8')
    ))).join('\n');
    const runtime = resolve(process.cwd(), '../.runtime/browser');
    const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
    browser = await chromium.launch({ executablePath: process.env.E2E_LOCAL_BROWSER || resolve(runtime, manifest.chromium), headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  const cases = ['dark', 'light'].flatMap(theme => [980, 520, 360, 280].flatMap(width => [false, true].map(touch => ({ theme, width, touch }))));
  it.each(cases)('makes every metric reachable at $width px, $theme, coarse=$touch', async ({ theme, width, touch }) => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ metrics: {
      coreWebVitals: [{ data: { lcp: 2100, fid: 150, cls: 0.3 } }],
      loadMetrics: [{ data: { domContentLoaded: 600, fullPageLoad: 900, timeToInteractive: 1200 } }],
      runtimeMetrics: Array.from({ length: 60 }, (_, index) => ({ data: {
        fps: 30 + index / 2,
        memory: { usedJSHeapSize: 10485760, totalJSHeapSize: 20971520 },
        longTasks: Array.from({ length: 80 }, (_, task) => ({ startTime: task * 100, duration: 75 + task })),
      } })),
    } }) });
    const { container } = render(<PerformanceTab port={4173} />);
    await screen.findByText('7900.00ms');
    const context = await browser.newContext({ viewport: { width: 1280, height: 500 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<!doctype html><html data-theme="${theme}"><style>${css}</style><style>body{margin:0}#fixture{height:280px;width:${width}px;overflow:hidden}.fixture-tabs{flex:0 0 36px}</style><div id="fixture"><div class="devtools-panel"><div class="fixture-tabs">Performance</div><div class="devtools-content">${container.innerHTML}</div></div></div></html>`);
      const geometry = await page.evaluate(() => {
        const root = document.querySelector('.devtools-content').firstElementChild;
        const grid = root.querySelector('h3').nextElementSibling;
        const rect = root.getBoundingClientRect();
        return {
          top: rect.top, bottom: rect.bottom, height: rect.height,
          overflowY: getComputedStyle(root).overflowY,
          gridDisplay: getComputedStyle(grid).display,
          columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(track => parseFloat(track) > 0).length,
          scrollable: root.scrollHeight > root.clientHeight,
          horizontalOverflow: root.scrollWidth > root.clientWidth,
          background: getComputedStyle(root).backgroundColor,
          statuses: [...grid.children].map(card => getComputedStyle(card.children[1]).color),
          expectedStatuses: ['--success', '--warning', '--error'].map(token => {
            const probe = document.createElement('span');
            probe.style.color = `var(${token})`;
            root.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          }),
          buttons: [...root.querySelectorAll('button')].map(button => ({
            native: button.type === 'button',
            target: Math.min(button.getBoundingClientRect().height, button.getBoundingClientRect().width),
          })),
          coarse: matchMedia('(pointer: coarse)').matches,
        };
      });
      console.info(JSON.stringify({ theme, width, touch, geometry }));
      expect(geometry).toMatchObject({ top: 36, bottom: 280, height: 244, overflowY: 'auto', gridDisplay: 'grid', scrollable: true, horizontalOverflow: false, coarse: touch });
      expect(geometry.columns).toBe(width === 980 ? 3 : width === 520 ? 2 : 1);
      expect(geometry.background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(31, 31, 31)');
      expect(geometry.statuses).toEqual(geometry.expectedStatuses);
      for (const button of geometry.buttons) {
        expect(button.native).toBe(true);
        expect(button.target).toBeGreaterThanOrEqual(touch ? 44 : 32);
      }
      const toggle = page.getByRole('button', { name: 'Start Live', exact: true });
      await toggle.focus();
      await toggle.click({ trial: true });
      expect(await toggle.evaluate(button => getComputedStyle(button).outlineStyle)).toBe('solid');
      for (const name of ['Refresh', 'Export', 'Clear']) {
        await page.keyboard.press('Tab');
        expect(await page.getByRole('button', { name, exact: true }).evaluate(button => button === document.activeElement)).toBe(true);
      }
      const targets = page.locator('.performance-tab__metric, .performance-tab__chart, tbody tr:last-child');
      expect(await targets.count()).toBe(10);
      if (process.env.E2E_PERFORMANCE_EVIDENCE) {
        await mkdir(process.env.E2E_PERFORMANCE_EVIDENCE, { recursive: true });
        await page.locator('#fixture').screenshot({ path: resolve(process.env.E2E_PERFORMANCE_EVIDENCE, `${theme}-${width}-${touch}-top.png`) });
      }
      for (const target of await targets.all()) {
        await target.scrollIntoViewIfNeeded();
        const box = await target.boundingBox();
        expect(box.y, await target.textContent()).toBeGreaterThanOrEqual(35);
        expect(box.y + box.height, await target.textContent()).toBeLessThanOrEqual(281);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      const region = page.getByRole('region', { name: 'Performance metrics', exact: true });
      await region.focus();
      await region.evaluate(root => { root.scrollTop = 0; });
      await page.keyboard.press('End');
      await expect.poll(() => region.evaluate(root => root.scrollTop + root.clientHeight >= root.scrollHeight - 1)).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const graph = await page.locator('.performance-tab__chart-bars').evaluate(chart => ({
        height: chart.clientHeight, bars: chart.children.length,
        firstHeight: chart.firstElementChild.getBoundingClientRect().height,
      }));
      expect(graph).toEqual({ height: 128, bars: 60, firstHeight: 64 });
      if (process.env.E2E_PERFORMANCE_EVIDENCE) {
        await page.locator('#fixture').screenshot({ path: resolve(process.env.E2E_PERFORMANCE_EVIDENCE, `${theme}-${width}-${touch}-bottom.png`) });
      }
    } finally { await context.close(); }
  });

  it.each(['empty', 'unavailable'])('keeps the %s state readable and keyboard-scrollable in a narrow coarse pane', async state => {
    apiFetch.mockResolvedValue(state === 'unavailable' ? { status: 404 } : {
      ok: true, json: async () => ({ metrics: { coreWebVitals: [], loadMetrics: [], runtimeMetrics: [] } }),
    });
    const { container } = render(<PerformanceTab port={4173} />);
    const message = state === 'unavailable' ? 'Performance monitoring not available' : 'No performance metrics available.';
    await screen.findByText(new RegExp(message));
    const context = await browser.newContext({ viewport: { width: 320, height: 400 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<html data-theme="light"><style>${css}</style><div style="height:280px;overflow:hidden" class="devtools-panel"><div class="devtools-content">${container.innerHTML}</div></div></html>`);
      const region = page.getByRole('region', { name: 'Performance metrics' });
      await region.focus();
      await page.getByText(message, { exact: false }).scrollIntoViewIfNeeded();
      expect(await region.evaluate(root => ({
        bounded: root.getBoundingClientRect().bottom <= 288,
        noHorizontalOverflow: root.scrollWidth === root.clientWidth,
        keyboard: root === document.activeElement,
        overflowY: getComputedStyle(root).overflowY,
      }))).toEqual({ bounded: true, noHorizontalOverflow: true, keyboard: true, overflowY: 'auto' });
    } finally { await context.close(); }
  });
});
