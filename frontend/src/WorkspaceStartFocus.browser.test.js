import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from './test/managedChromium';

const STYLESHEETS = ['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/DesktopComposer.css'];
const MARKUP = `<main class="environment-shell environment-workspace"><div class="workspace-start-composer-shell">
  <div class="desktop-status-bar workspace-composer"><form class="status-composer-shell"><textarea class="status-composer-input" aria-label="Command composer"></textarea></form></div>
</div></main>`;

let browser, css;
beforeAll(async () => {
  css = (await Promise.all(STYLESHEETS.map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe('new-thread composer focus indication', () => {
  it.each([
    { theme: 'dark', width: 320 }, { theme: 'light', width: 390 }, { theme: 'dark', width: 1280 }, { theme: 'light', width: 1280 },
  ])('changes the composer border to the accent colour when focused in $theme at $width px', async ({ theme, width }) => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${MARKUP}</body></html>`);
      const border = () => page.evaluate(() => getComputedStyle(document.querySelector('.status-composer-shell')).borderTopColor);
      const resting = await border();
      await page.locator('textarea').focus();
      const accent = await page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--accent-primary)';
        document.body.append(probe);
        return getComputedStyle(probe).color;
      });
      expect(resting).not.toBe(accent);
      await expect.poll(border, { timeout: 2000 }).toBe(accent);
    } finally { await context.close(); }
  });
});
