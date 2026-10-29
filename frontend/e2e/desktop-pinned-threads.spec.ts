import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1440, height: 900 } });

test('pinned threads appear once in desktop navigation and remain searchable', async ({ page }) => {
  const pinned = { id: 'ss-pinned-fixture', provider: 'codex', runtime: 'codex', title: 'Pinned investigation', cwd: '/tmp/pins-fixture', status: 'idle', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z', thread: { topic: 'Pinned investigation', pinned: true, projectPath: '/tmp/pins-fixture' } };
  const other = { ...pinned, id: 'ss-other-fixture', title: 'Other thread', updatedAt: '2026-10-25T10:00:00Z', thread: { topic: 'Other thread', pinned: false, projectPath: '/tmp/pins-fixture' } };
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [pinned, other] }));
  await page.route(`**/api/structured/sessions/${pinned.id}`, route => route.fulfill({ json: pinned }));
  await page.route('**/api/workspace/history?*', route => route.fulfill({ json: [] }));
  await page.routeWebSocket(`**/api/structured/sessions/${pinned.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`pins-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const sidebar = page.getByRole('complementary', { name: 'Threads' });
  await expect(sidebar.getByRole('button', { name: 'Select Pinned investigation' })).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: 'Select Other thread' })).toBeVisible();
  await sidebar.getByRole('textbox', { name: 'Search threads' }).fill('Pinned');
  await expect(sidebar.getByRole('button', { name: 'Select Pinned investigation' })).toHaveCount(1);
  await expect(sidebar.getByRole('button', { name: 'Select Other thread' })).toHaveCount(0);
});
