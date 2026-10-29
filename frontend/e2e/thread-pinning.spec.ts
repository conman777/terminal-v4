import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const sessions = [
  { id: 'ss-pin-fixture', title: 'Pin fixture', updatedAt: '2026-10-25T10:00:00Z' },
  { id: 'ss-other-fixture', title: 'Other fixture', updatedAt: '2026-10-26T10:00:00Z' },
].map(session => ({ ...session, provider: 'codex', runtime: 'codex', cwd: '/tmp/pin-fixture', status: 'completed', model: 'gpt-6.1-sol', reasoning: 'high', createdAt: '2026-10-20T10:00:00Z' }));

for (const viewport of [{ width: 320, height: 720 }, { width: 1280, height: 800 }]) {
  test(`pins and unpins a thread while preserving its draft at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
      id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'],
    }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: sessions }));
    for (const session of sessions) {
      await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
      await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
        for (const event of [
          { type: 'message_completed', role: 'user', content: 'Review this thread', messageId: 'user', turnId: 'turn', seq: 1 },
          { type: 'message_completed', role: 'assistant', content: 'Ready for review', messageId: 'reply', turnId: 'turn', seq: 2 },
          { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
        ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      });
    }
    const changes: boolean[] = [];
    await page.route('**/api/structured/sessions/ss-pin-fixture/thread', async route => {
      const { pinned } = route.request().postDataJSON();
      changes.push(pinned);
      await route.fulfill({ json: { thread: { pinned } } });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`pin-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
    if (viewport.width === 320) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
      await expect(drawer.locator('.mobile-drawer-project-sessions-modern > button').first()).toContainText('Other fixture');
      await drawer.getByRole('button', { name: /Pin fixture/ }).click();
    } else await page.getByRole('button', { name: 'Select Pin fixture' }).click();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep this draft while pinning.');
    if (viewport.width === 320) {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Pin thread', exact: true }).click();
      await expect.poll(() => changes).toEqual([true]);
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
      const rows = drawer.locator('.mobile-drawer-project-sessions-modern > button');
      await expect(rows.first()).toContainText('Pin fixture');
      await expect(rows.first().getByRole('img', { name: 'Pinned thread' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('pinned-drawer.png'), animations: 'disabled' });
      await drawer.getByRole('button', { name: 'Close menu' }).click();
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Unpin thread', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Thread actions for Pin fixture' }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
      await expect.poll(() => changes).toEqual([true]);
      await expect(page.getByRole('img', { name: 'Pinned' }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Thread actions for Pin fixture' }).first().click();
      await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    }
    await expect.poll(() => changes).toEqual([true, false]);
    await expect(composer).toHaveValue('Keep this draft while pinning.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}
