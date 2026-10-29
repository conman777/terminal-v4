import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConsoleTab } from '../ConsoleTab';

describe.runIf(process.env.E2E_CONSOLE_LAYOUT === '1')('ConsoleTab expanded-log layout', () => {
  let browser, css;
  beforeAll(async () => {
    css = (await Promise.all(['../../../styles.css', '../../../WorkspaceUI.css', '../../../devtools.css', '../ConsoleTab.css'].map(path =>
      readFile(new URL(path, import.meta.url), 'utf8')
    ))).join('\n');
    const runtime = resolve(process.cwd(), '../.runtime/browser');
    const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
    browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it.each(['dark', 'light'].flatMap(theme => [980, 360].map(width => ({ theme, width }))))('keeps expanded logs separate and REPL reachable at $width px in $theme', async ({ theme, width }) => {
    const { container } = render(<ConsoleTab previewPort={4173} onEvaluate={() => {}} logs={[
      { id: 'object', message: JSON.stringify({ fixture: { nested: 'expanded content' }, other: 'visible value' }), timestamp: 1000, level: 'log' },
      { id: 'error', message: 'Synthetic error marker', stack: Array(8).fill('at synthetic.js:1:1').join('\n'), timestamp: 2000, level: 'error' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `log-${index}`, message: `Last marker ${index}`, timestamp: 3000 + index, level: 'log' })),
    ]} />);
    fireEvent.click(container.querySelector('.json-toggle'));
    fireEvent.click(screen.getByText('Stack trace'));
    const page = await browser.newPage({ viewport: { width, height: 440 }, hasTouch: width < 600 });
    try {
      await page.route('**/*', route => route.abort());
      await page.setContent(`<!doctype html><html data-theme="${theme}"><style>${css}</style><style>body{margin:0}#fixture{height:300px;overflow:hidden}</style><div id="fixture" class="devtools-panel"><div class="devtools-content">${container.innerHTML}</div></div></html>`);
      await page.locator('details').evaluate(node => { node.open = true; });
      const geometry = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.log-viewer-row')];
        const viewer = document.querySelector('.log-viewer');
        const repl = document.querySelector('.console-repl');
        return {
          overlaps: rows.slice(0, -1).some((row, index) => row.getBoundingClientRect().bottom > rows[index + 1].getBoundingClientRect().top + 1 || row.firstElementChild.getBoundingClientRect().bottom > rows[index + 1].getBoundingClientRect().top + 1),
          viewerBottom: viewer.getBoundingClientRect().bottom,
          replTop: repl.getBoundingClientRect().top,
          replBottom: repl.getBoundingClientRect().bottom,
          pageOverflow: document.body.scrollWidth > innerWidth,
          scrollable: viewer.scrollHeight > viewer.clientHeight,
        };
      });
      expect(geometry).toMatchObject({ overlaps: false, pageOverflow: false, scrollable: true });
      expect(geometry.viewerBottom).toBeLessThanOrEqual(geometry.replTop);
      expect(geometry.replBottom).toBeLessThanOrEqual(300);
      await page.getByText('Last marker 11', { exact: true }).scrollIntoViewIfNeeded();
      const last = await page.getByText('Last marker 11', { exact: true }).boundingBox();
      expect(last.y + last.height).toBeLessThanOrEqual(geometry.replTop + 1);
      if (process.env.E2E_CONSOLE_EVIDENCE) {
        await mkdir(process.env.E2E_CONSOLE_EVIDENCE, { recursive: true });
        await page.locator('#fixture').screenshot({ path: resolve(process.env.E2E_CONSOLE_EVIDENCE, `devtools-console-${theme}-${width}.png`) });
      }
    } finally { await page.close(); }
  });
});
