import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1280, height: 800 } });

test('file attachments stay with the desktop conversation when switching threads', async ({ page }) => {
  const first = { id: 'ss-desktop-attachment-first', provider: 'codex', runtime: 'codex', title: 'First desktop thread', cwd: '/tmp/attachment-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z' };
  const second = { ...first, id: 'ss-desktop-attachment-second', title: 'Second desktop thread', updatedAt: '2026-10-25T10:00:00Z' };
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [first, second] }));
  for (const session of [first, second]) {
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
  }
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`desk-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Please review the attached file.');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  const uploadResponse = page.waitForResponse('**/api/files/attachment');
  await (await chooserPromise).setFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture content') });
  const uploaded = await (await uploadResponse).json();
  if (process.env.E2E_EXPECT_UPLOAD_ROOT) {
    const uploadRoot = path.join(process.env.E2E_EXPECT_UPLOAD_ROOT, 'terminal-v4-uploads') + path.sep;
    expect(uploaded.path.startsWith(uploadRoot)).toBe(true);
    expect(await readFile(uploaded.path, 'utf8')).toBe('Fixture content');
  }
  await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');

  const navigation = page.getByRole('complementary', { name: 'Threads' });
  await navigation.getByRole('button', { name: 'Select Second desktop thread' }).click();
  await expect(page.getByLabel('Composer attachments')).toHaveCount(0);
  await navigation.getByRole('button', { name: 'Select First desktop thread' }).click();
  await expect(composer).toHaveValue('Please review the attached file.');
  await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');
  await page.reload();
  await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');
  await expect(page.getByText('Restored file selections. Check the files before sending; they may have changed.')).toBeVisible();
  await expect(composer).toHaveValue('Please review the attached file.');
  if (process.env.E2E_EXPECT_UPLOAD_ROOT) expect(await readFile(uploaded.path, 'utf8')).toBe('Fixture content');
  await page.getByRole('button', { name: 'Remove fixture.txt' }).click();
  await page.reload();
  await expect(page.getByLabel('Composer attachments')).toHaveCount(0);
});
