import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1280, height: 800 } });

const workspace = process.env.E2E_TERMINAL_WORKSPACE || process.cwd();
const session = { id: 'ss-layout-fixture', provider: 'deepseek', runtime: 'v4', title: 'Layout fixture', cwd: workspace, status: 'idle', model: 'fixture-model', createdAt: '2026-10-25T10:00:00Z' };

async function openThread(page: Page) {
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'deepseek', label: 'DeepSeek', runtime: 'v4', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }] }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, () => {});
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`layout-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Command composer', exact: true })).toBeVisible();
}

async function openDrawerTerminal(page: Page) {
  await openThread(page);
  await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
  await expect(page.locator('.thread-terminal-drawer .xterm-screen')).toBeVisible();
  await page.waitForTimeout(1000);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(async cwd => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
    const response = await fetch('/api/terminal', { headers });
    if (!response.ok) return;
    const inventory = await response.json();
    for (const item of inventory.sessions) if (item.cwd === cwd) await fetch(`/api/terminal/${item.id}`, { method: 'DELETE', headers });
  }, workspace).catch(() => undefined);
});

test('thread terminal fills its panel at 1280px and details stay closed by default', async ({ page }) => {
  await openDrawerTerminal(page);
  await expect(page.getByRole('complementary', { name: 'Thread details' })).toHaveCount(0);
  const drawer = (await page.locator('.thread-terminal-drawer').boundingBox())!;
  const container = (await page.locator('.thread-terminal-drawer .xterm-container').boundingBox())!;
  const screen = (await page.locator('.thread-terminal-drawer .xterm-screen').boundingBox())!;
  expect(container.x - drawer.x).toBeLessThanOrEqual(1);
  expect(drawer.x + drawer.width - (container.x + container.width)).toBeLessThanOrEqual(1);
  expect(screen.x - drawer.x).toBeLessThanOrEqual(20);
});

test('Add to chat stays inside the thread terminal after selecting text', async ({ page }) => {
  await openDrawerTerminal(page);
  const screen = (await page.locator('.thread-terminal-drawer .xterm-screen').boundingBox())!;
  await page.mouse.dblclick(screen.x + 24, screen.y + 8);
  const add = page.locator('.thread-terminal-drawer .terminal-add-to-chat');
  await expect(add).toBeVisible();
  const drawer = (await page.locator('.thread-terminal-drawer').boundingBox())!;
  const box = (await add.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(drawer.x + drawer.width);
  expect(drawer.x + drawer.width - (box.x + box.width)).toBeLessThanOrEqual(24);
});

test('Tab reaches the thread list before the composer and Enter opens provider settings from the chip', async ({ page }) => {
  await openThread(page);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const order: string[] = [];
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return 'body';
      return `${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.tagName}|${el.closest('aside,nav,[class*="sidebar"],[class*="thread-list"]') ? 'side' : 'main'}`;
    }));
    if (order.at(-1)?.startsWith('Provider settings')) break;
  }
  const composer = order.findIndex(entry => entry.startsWith('Command composer'));
  const firstSide = order.findIndex(entry => entry.endsWith('|side'));
  const lastSide = order.map(entry => entry.endsWith('|side')).lastIndexOf(true);
  const chip = order.findIndex(entry => entry.startsWith('Provider settings'));
  expect([composer, firstSide, lastSide, chip].every(index => index >= 0)).toBe(true);
  expect(lastSide).toBeLessThan(composer);
  expect(composer).toBeLessThan(chip);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Provider authentication' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Provider settings/ })).toBeFocused();
});
