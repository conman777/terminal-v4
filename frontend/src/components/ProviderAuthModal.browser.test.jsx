import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from '../test/managedChromium';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderAuthModal } from './ProviderAuthModal';

vi.mock('../utils/api', () => ({
  apiGet: async () => ({ providers: Array.from({ length: 8 }, (_, index) => ({
    id: `fixture-${index}`, label: `Fixture provider ${index}`, methods: ['oauth', 'api-key'],
    command: `fixture login --provider=${'synthetic-provider-'.repeat(8)}`,
    status: 'auth-required', configured: false,
    help: 'Configure this synthetic provider in your terminal.',
  })) }),
  apiPut: vi.fn(), apiDelete: vi.fn(), apiPost: vi.fn(),
}));

let browser, markup, css;
const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeAll(async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  const view = render(<ProviderAuthModal isOpen onClose={() => {}} />);
  await screen.findByLabelText('Fixture provider 7 API key');
  markup = screen.getByRole('dialog', { name: 'Provider authentication' }).outerHTML;
  view.unmount();
  css = (await Promise.all([
    'styles.css', 'ProUI.css', 'WorkspaceShell.css', 'components/AccountAccess.css',
    'components/ProviderAuthModal.css', 'WorkspaceUI.css',
  ].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => {
  await browser?.close();
  for (const method of ['showModal', 'close']) {
    if (dialogMethods[method]) Object.defineProperty(HTMLDialogElement.prototype, method, dialogMethods[method]);
    else delete HTMLDialogElement.prototype[method];
  }
});

describe('ProviderAuthModal native top layer and responsive source markup', () => {
  it.each([
    { width: 390, height: 844, theme: 'dark', touch: true },
    { width: 390, height: 300, theme: 'light', touch: true },
    { width: 320, height: 568, theme: 'light', touch: true },
    { width: 1440, height: 900, theme: 'dark', touch: false },
  ])('keeps Close above workspace chrome at $width × $height in $theme', async ({ width, height, theme, touch }) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      // Use the actual component output and cascade, inside a hostile caller stacking context.
      await page.setContent(`<style>${css}</style><button style="position:fixed;inset:0 0 auto auto;width:80px;height:80px;z-index:999999" aria-label="More actions">More</button><main inert style="transform:translateZ(0);overflow:hidden;width:100px;height:100px">${markup}</main>`);
      await page.evaluate(value => {
        document.documentElement.setAttribute('data-theme', value);
        const dialog = document.querySelector('dialog');
        dialog.removeAttribute('open');
        dialog.showModal();
        dialog.focus();
      }, theme);
      const geometry = await page.evaluate(() => {
        const dialog = document.querySelector('dialog');
        const panel = dialog.querySelector('.modal-content');
        const close = dialog.querySelector('.modal-close');
        const body = dialog.querySelector('.modal-body');
        const box = close.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        document.querySelector('[aria-label="More actions"]').focus();
        return {
          modal: dialog.matches(':modal'),
          closeReachable: close.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
          closeSize: Math.min(box.width, box.height),
          headerHeight: dialog.querySelector('.modal-header').getBoundingClientRect().height,
          panelFits: bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          scrollable: body.scrollHeight > body.clientHeight,
          noHorizontalOverflow: body.scrollWidth === body.clientWidth,
          backgroundFocusBlocked: document.activeElement !== document.querySelector('[aria-label="More actions"]'),
          inputFont: parseFloat(getComputedStyle(dialog.querySelector('input')).fontSize),
        };
      });
      expect(geometry).toEqual({
        modal: true, closeReachable: true, closeSize: touch ? 44 : 28, headerHeight: 52,
        panelFits: true, scrollable: true, noHorizontalOverflow: true,
        backgroundFocusBlocked: true, inputFont: touch ? 16 : 13,
      });
      const close = page.getByRole('button', { name: 'Close', exact: true });
      await close.focus();
      await page.keyboard.press('Tab');
      expect(await page.getByRole('button', { name: 'Copy login command', exact: true }).first().evaluate(button => button === document.activeElement)).toBe(true);
      const before = await close.boundingBox();
      await page.locator('.modal-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
      expect(await close.boundingBox()).toEqual(before);
      await page.evaluate(() => {
        document.querySelector('dialog').addEventListener('click', event => { window.clickedClose = Boolean(event.target.closest('[aria-label="Close"]')); });
      });
      await close.click({ timeout: 2000 });
      expect(await page.evaluate(() => window.clickedClose)).toBe(true);
    } finally { await context.close(); }
  });
});
