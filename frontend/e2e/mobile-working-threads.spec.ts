import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, isMobile: true, hasTouch: true });

for (const width of [320, 393]) {
  test(`working threads remain searchable and reachable at ${width}px`, async ({ page }, testInfo) => {
    const current = { id: 'ss-working-current', provider: 'codex', runtime: 'codex', title: 'Current conversation', cwd: '/tmp/thread-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z', threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } };
    let working = { ...current, id: 'ss-working-background', title: 'Background investigation', status: 'running', statusSeq: 1, isBusy: true, updatedAt: '2026-10-25T10:00:00Z' };
    await page.setViewportSize({ width, height: 700 });
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [current, working] }));
    await page.route(`**/api/structured/sessions/${current.id}`, route => route.fulfill({ json: current }));
    await page.route(`**/api/structured/sessions/${working.id}`, route => route.fulfill({ json: working }));
    await page.route('**/api/workspace/history?*', route => route.fulfill({ json: [] }));
    await page.routeWebSocket(`**/api/structured/sessions/${current.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`working-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Mobile menu' });
    const toggle = menu.getByRole('button', { name: 'Working (1)' });
    await expect(toggle).toBeVisible();
    const size = await toggle.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
    await expect(menu.getByRole('region', { name: 'Working threads' })).toContainText('Background investigation');
    await page.screenshot({ path: testInfo.outputPath('working-threads.png'), animations: 'disabled' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('button', { name: /Background investigation/ })).toHaveCount(0);
    await menu.getByRole('searchbox', { name: 'Search threads' }).fill('Background');
    await expect(menu.getByRole('button', { name: /Background investigation/ })).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(menu.getByRole('button', { name: /Background investigation/ })).toHaveCount(0);
    await toggle.click();
    await expect(menu.getByRole('button', { name: /Background investigation/ })).toBeVisible();
    await menu.getByRole('button', { name: 'Clear thread search' }).click();
    working = { ...working, status: 'completed', statusSeq: 2, isBusy: false, updatedAt: new Date().toISOString() };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(menu.getByRole('region', { name: 'Working threads' })).toHaveCount(0);
    await expect(menu.getByRole('button', { name: /Background investigation/ })).toContainText('Background investigation');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
