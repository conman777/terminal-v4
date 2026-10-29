import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 684 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width <= 768, hasTouch: viewport.width <= 768 });
    test('server selection is a compact chooser with separate management', async ({ page }, testInfo) => {
      const errors: string[] = [];
      const mutations: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'fixture-model', label: 'Fixture model' }], reasoningLevels: [] }] } }));
      await page.route('**/api/environments*', route => {
        if (route.request().method() !== 'GET') mutations.push(route.request().method());
        return route.fulfill({ json: { environments: [{ id: 'build-server', label: 'Build machine', url: 'https://build.example.test', profile: 'observer' }], grants: [] } });
      });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`servers-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
      await composer.fill('Keep this draft when I inspect the server menu.');
      const trigger = page.getByRole('button', { name: 'Switch server, This server', exact: true });
      await expect(trigger).toBeInViewport({ ratio: 1 });
      if (viewport.width <= 768) {
        await expect(page.locator('.remote-environment-bar')).toHaveCount(0);
        await expect(page.locator('.mobile-header').getByRole('button', { name: 'Switch server, This server' })).toBeVisible();
      } else {
        await expect(page.locator('.remote-environment-kicker')).toHaveText('Server');
      }
      await trigger.click();
      const chooser = page.getByRole('dialog', { name: 'Switch server', exact: true });
      await expect(chooser).toBeInViewport({ ratio: 1 });
      await expect(chooser.getByRole('button', { name: 'Use this server', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(chooser.getByRole('button', { name: 'Use Build machine', exact: true })).toBeVisible();
      await expect(chooser.getByRole('textbox')).toHaveCount(0);
      await expect(chooser.getByRole('button', { name: 'Create pairing code', exact: true })).toHaveCount(0);
      await expect(chooser.getByText('Connect by device ID', { exact: true })).toHaveCount(0);
      const box = await chooser.boundingBox();
      const bar = await page.locator(viewport.width <= 768 ? '.mobile-header' : '.remote-environment-bar').boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
      expect(box!.width).toBeLessThanOrEqual(Math.min(360, viewport.width - 24));
      await page.screenshot({ path: testInfo.outputPath('server-chooser.png') });
      const close = chooser.getByRole('button', { name: 'Close server chooser', exact: true });
      const manage = chooser.getByRole('button', { name: 'Manage servers', exact: true });
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(manage).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await manage.click();
      const manager = page.getByRole('dialog', { name: 'Manage servers', exact: true });
      await expect(manager).toBeInViewport({ ratio: 1 });
      await expect(manager.getByRole('button', { name: 'Back to servers', exact: true })).toBeFocused();
      await expect(manager.getByRole('button', { name: 'Pair server', exact: true })).toBeVisible();
      await expect(manager.getByRole('button', { name: 'Additional remote tools', exact: true })).toHaveAttribute('aria-expanded', 'false');
      await page.screenshot({ path: testInfo.outputPath('server-management.png') });
      if (viewport.width <= 768) {
        await page.setViewportSize({ width: viewport.width, height: 402 });
        await expect(manager).toBeInViewport({ ratio: 1 });
        await expect(manager.getByRole('button', { name: 'Close server chooser', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(manager.getByRole('textbox', { name: 'Remote server URL' })).toHaveCSS('font-size', '16px');
      }
      await page.keyboard.press('Escape');
      await expect(chooser).toBeInViewport({ ratio: 1 });
      await expect(manage).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(chooser).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.locator('#root')).toHaveJSProperty('inert', false);
      await expect(composer).toHaveValue('Keep this draft when I inspect the server menu.');
      await trigger.click();
      await page.getByRole('dialog', { name: 'Switch server' }).getByRole('button', { name: 'Use this server', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await trigger.click();
      await page.locator('.server-switcher-overlay').click({ position: { x: viewport.width - 2, y: 2 } });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(mutations).toEqual([]);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    });
  });
}

test.describe('small server directory', () => {
  test.use({ viewport: { width: 320, height: 402 }, isMobile: true, hasTouch: true });
  test('a long directory scrolls inside the chooser and search remains usable', async ({ page }) => {
    await page.route('**/api/environments*', route => route.fulfill({ json: { environments: Array.from({ length: 20 }, (_, index) => ({ id: `host-${index}`, label: `Build machine ${index}`, url: `https://host-${index}.example.test` })), grants: [] } }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`servers-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Switch server, This server', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: 'Switch server', exact: true });
    await expect(chooser).toBeInViewport({ ratio: 1 });
    const search = chooser.getByRole('searchbox', { name: 'Find server' });
    await expect(search).toHaveCSS('font-size', '16px');
    const last = chooser.getByRole('button', { name: 'Use Build machine 19', exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport({ ratio: 1 });
    await expect(chooser.getByRole('button', { name: 'Manage servers', exact: true })).toBeInViewport({ ratio: 1 });
    await search.fill('machine 19');
    await expect(last).toBeVisible();
    await expect(chooser.getByRole('button', { name: 'Use Build machine 18', exact: true })).toHaveCount(0);
    await expect(chooser.getByRole('button', { name: 'Use this server', exact: true })).toBeVisible();
  });
});
