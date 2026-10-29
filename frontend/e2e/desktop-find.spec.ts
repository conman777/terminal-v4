import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1440, height: 900 } });

test('desktop Find follows the chosen pane and returns focus to its header', async ({ page }, testInfo) => {
  const sessions = ['amber', 'violet'].map((name, index) => ({
    id: `ss-find-${name}`, provider: 'codex', runtime: 'codex', title: `${name} thread`,
    cwd: '/tmp/desktop-find-fixture', status: 'completed', model: 'fixture-model', reasoning: 'high',
    createdAt: `2026-10-25T10:0${index}:00Z`, updatedAt: `2026-10-25T10:0${index}:00Z`,
    thread: { topic: `${name} thread`, projectPath: '/tmp/desktop-find-fixture' },
  }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: sessions }));
  for (const session of sessions) {
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
      for (const event of [
        { type: 'message_completed', role: 'assistant', content: `${session.title} has a synthetic needle`, messageId: 'message', turnId: 'turn', seq: 1 },
        { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 2 },
      ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
  }
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`find-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText(/has a synthetic needle/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Split horizontally', exact: true }).click();
  await page.getByRole('button', { name: 'Select amber thread', exact: true }).click();
  const hosts = page.locator('[data-pane-host]');
  await expect(hosts).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Find in thread', exact: true })).toHaveCount(2);
  const second = hosts.nth(1);
  const trigger = second.getByRole('button', { name: 'Find in thread', exact: true });
  await trigger.click();
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  await expect(find).toBeFocused();
  await expect(second.locator('.split-terminal-pane')).toHaveClass(/\bactive\b/);
  await find.fill('synthetic needle');
  await expect(page.getByText('1 of 1', { exact: true })).toBeVisible();
  await expect(second.locator('.cc-find-current')).toContainText('amber thread');
  await expect(hosts.nth(0).locator('.cc-find-current')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-find.png'), animations: 'disabled' });
  await find.press('Escape');
  await expect(trigger).toBeFocused();
});
