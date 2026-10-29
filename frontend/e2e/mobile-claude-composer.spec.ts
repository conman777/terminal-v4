import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 393, height: 684 }, isMobile: true, hasTouch: true });

test('Claude model, project mentions and file attachments keep the mobile draft', async ({ page }) => {
  const session = { id: 'ss-claude-mobile-fixture', provider: 'claude', title: 'Claude mobile', cwd: '/tmp/claude-fixture', status: 'completed', model: 'sonnet', reasoning: 'low', createdAt: '2026-10-25T10:00:00Z' };
  const selections: unknown[] = [];
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'claude', label: 'Claude Code', available: true, status: 'ready', models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }], reasoningLevels: ['low', 'high'] }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.route(`**/api/structured/sessions/${session.id}/selection`, async route => {
    const selection = route.request().postDataJSON();
    selections.push(selection);
    await route.fulfill({ json: { ...session, ...selection } });
  });
  await page.route('**/api/workspace/files?*', route => route.fulfill({ json: { files: ['src/example.js'] } }));
  await page.route('**/api/files/attachment', route => route.fulfill({ json: { path: '/tmp/fixture-document.txt' } }));
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
    socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready to help.', messageId: 'assistant', turnId: 'turn', seq: 1 } }));
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`claude-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText('Ready to help.')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Command composer' });
  await composer.fill('Keep this draft @exa');
  await page.getByRole('option', { name: /@src\/example.js/ }).click();
  await expect(composer).toHaveValue('Keep this draft @src/example.js ');
  await page.getByRole('button', { name: /^Model settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation model settings' });
  await expect(dialog.getByRole('heading', { name: 'Claude' })).toBeVisible();
  await dialog.getByRole('option', { name: 'Opus' }).click();
  await expect.poll(() => selections).toEqual([{ model: 'opus', reasoning: 'low' }]);
  await dialog.getByRole('button', { name: 'Close model settings' }).click();
  await expect(composer).toHaveValue('Keep this draft @src/example.js ');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Attach file' }).click()]);
  await chooser.setFiles({ name: 'fixture-document.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic document') });
  await expect(page.getByText('fixture-document.txt')).toBeVisible();
  await expect(composer).toHaveValue('Keep this draft @src/example.js ');
});
