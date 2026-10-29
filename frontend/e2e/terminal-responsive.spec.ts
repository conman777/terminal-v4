import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
let fixtureTitle: string;

test.beforeEach(async ({ page }) => {
  fixtureTitle = `Responsive terminal fixture ${randomUUID()}`;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`layout-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
  await page.evaluate(async ({ cwd, title }) => {
    const response = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` },
      body: JSON.stringify({ cwd, title }),
    });
    if (!response.ok) throw new Error(`Terminal fixture creation failed: ${response.status}`);
  }, { cwd: process.env.E2E_TERMINAL_WORKSPACE || process.cwd(), title: fixtureTitle });
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Command composer', exact: true })).toBeVisible();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && await page.locator('.composer-input-options-menu').count()) {
    await page.screenshot({ path: testInfo.outputPath('failed-layout.png') });
    console.log(JSON.stringify(await page.locator('.composer-input-options-menu').evaluate(element => {
      const css = getComputedStyle(element); const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, left: css.left, right: css.right, maxHeight: css.maxHeight, parent: element.parentElement?.getBoundingClientRect().toJSON() };
    })));
  }
  await page.evaluate(async title => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
    const response = await fetch('/api/terminal', { headers });
    if (!response.ok) return;
    const inventory = await response.json();
    for (const session of inventory.sessions) {
      if (session.title !== title) continue;
      const closed = await fetch(`/api/terminal/${session.id}`, { method: 'DELETE', headers });
      if (!closed.ok) throw new Error(`Terminal fixture cleanup failed: ${closed.status}`);
    }
  }, fixtureTitle);
});

for (const width of [320, 390]) {
  test(`mobile navigation and keyboard bar fit the single header at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
    await expect(drawer.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.locator('.remote-environment-bar')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Close menu', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('mobile-drawer.png') });
    await drawer.getByRole('button', { name: 'Close menu', exact: true }).click();
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('button', { name: 'Show keyboard bar', exact: true }).click();
    const header = await page.locator('.mobile-header').boundingBox();
    await expect.poll(async () => (await page.locator('.mobile-keybar').boundingBox())!.y)
      .toBeGreaterThanOrEqual(header!.y + header!.height);
    await page.screenshot({ path: testInfo.outputPath('mobile-keybar.png') });
  });

  test(`mobile composer has readable input and reachable actions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await expect(composer).toHaveCSS('font-size', '16px');
    const actions = page.getByLabel('More composer actions', { exact: true });
    await expect(actions).toBeVisible();
    for (const locator of [actions, page.getByRole('button', { name: 'Add image', exact: true }), page.getByRole('button', { name: 'Send to terminal', exact: true }), page.getByRole('button', { name: 'Choose AI coder', exact: true })]) {
      const box = await locator.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await actions.click();
    await expect(page.getByRole('button', { name: 'Disable autocorrect' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Voice input (local Whisper)', exact: true })).toBeVisible();
    await expect(page.locator('.workspace-composer').getByRole('button', { name: 'Workspace tools', exact: true })).toHaveCount(0);
    await expect(page.locator('.workspace-composer').getByRole('button', { name: 'Workspace knowledge', exact: true })).toHaveCount(0);
    const menu = await page.locator('.composer-input-options-menu').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath('mobile-actions.png') });
    await actions.press('Escape');
    await expect(actions).toBeFocused();
    await actions.click();
    const context = page.getByRole('button', { name: 'Session context', exact: true });
    await context.click();
    await expect(page.getByRole('dialog', { name: 'Session context', exact: true })).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(context).toBeFocused();
    await composer.fill("printf 'responsive-%s\\n' command-ok");
    await page.getByRole('button', { name: 'Send to terminal', exact: true }).click();
    await expect(composer).toHaveValue('');
    await expect.poll(() => page.evaluate(async title => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const inventory = await (await fetch('/api/terminal', { headers })).json();
      const session = inventory.sessions.find((item: { title: string }) => item.title === title);
      const history = await (await fetch(`/api/terminal/${session.id}/history`, { headers })).json();
      return JSON.stringify(history.history);
    }, fixtureTitle)).toContain('responsive-command-ok');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.setViewportSize({ width, height: 480 });
    const send = page.getByRole('button', { name: 'Send to terminal', exact: true });
    await expect(send).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('mobile-composer.png') });
    await page.setViewportSize({ width, height: 402 });
    await actions.click();
    const compactMenu = page.locator('.composer-input-options-menu');
    await expect(compactMenu).toBeInViewport({ ratio: 1 });
    const header = await page.locator('.mobile-header').boundingBox();
    expect((await compactMenu.boundingBox())!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    await actions.press('Escape');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Mobile menu', exact: true })).toBeHidden();
    await expect(composer).toHaveCSS('font-size', '16px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test('desktop composer retains its compact controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('textbox', { name: 'Command composer', exact: true })).toHaveCSS('font-size', '13px');
  await expect(page.getByRole('button', { name: 'Send to terminal', exact: true })).toHaveCSS('width', '32px');
  await expect(page.getByLabel('More composer actions', { exact: true })).toHaveCount(0);
});
