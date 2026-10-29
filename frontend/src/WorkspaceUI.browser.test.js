import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser, css;
beforeAll(async () => {
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  const runtime = resolve(process.cwd(), '../.runtime/browser');
  const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
  browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe('shared workspace controls and portal appearance', () => {
  it.each([
    { theme: 'dark', touch: false }, { theme: 'light', touch: false },
    { theme: 'dark', touch: true }, { theme: 'light', touch: true }
  ])('keeps controls readable and reachable in $theme with touch=$touch', async ({ theme, touch }) => {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1440, height: 900 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      await page.setContent(`<style>${css}</style><section role="dialog" aria-label="Workspace settings" class="modal-content"><header class="modal-header"><h2>Workspace settings</h2><button class="modal-close" aria-label="Close">×</button></header><div class="modal-body"><p class="shared-description">Choose how your workspace looks.</p><div class="form-group"><label for="name">Workspace name</label><input id="name" value="My workspace"></div><button class="btn-primary">Save changes</button><button class="btn-secondary">Cancel</button></div></section>`);
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const appearance = await page.evaluate(() => {
        const root = document.querySelector('.modal-content'), button = document.querySelector('.btn-primary'), input = document.querySelector('input');
        const color = element => getComputedStyle(element).color.match(/[\d.]+/g).slice(0, 3).map(Number);
        const background = getComputedStyle(root).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const contrast = element => { const levels = [luminance(color(element)), luminance(background)].sort((a, b) => b - a); return (levels[0] + .05) / (levels[1] + .05); };
        return { buttonHeight: button.getBoundingClientRect().height, inputHeight: input.getBoundingClientRect().height, inputFont: parseFloat(getComputedStyle(input).fontSize), labelContrast: contrast(document.querySelector('label')), descriptionContrast: contrast(document.querySelector('p')), closeSize: document.querySelector('.modal-close').getBoundingClientRect().width, overflow: root.getBoundingClientRect().right > innerWidth };
      });
      expect(appearance.buttonHeight).toBe(touch ? 44 : 32);
      expect(appearance.inputHeight).toBe(touch ? 44 : 36);
      expect(appearance.inputFont).toBe(touch ? 16 : 13);
      expect(appearance.closeSize).toBe(touch ? 44 : 32);
      expect(appearance.labelContrast).toBeGreaterThanOrEqual(4.5);
      expect(appearance.descriptionContrast).toBeGreaterThanOrEqual(4.5);
      expect(appearance.overflow).toBe(false);
    } finally { await context.close(); }
  });
});
