import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const session = {
  id: 'ss-archive-fixture', title: 'Archive fixture', provider: 'codex', runtime: 'codex', cwd: '/tmp/archive-fixture',
  status: 'completed', model: 'gpt-6.1-sol', reasoning: 'high', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
};

for (const viewport of [{ width: 320, height: 720 }, { width: 1280, height: 800 }]) {
  test(`archives and restores a thread without losing its draft at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
      id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'],
    }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      for (const event of [
        { type: 'message_completed', role: 'user', content: 'Review this thread', messageId: 'user', turnId: 'turn', seq: 1 },
        { type: 'message_completed', role: 'assistant', content: 'Ready for review', messageId: 'reply', turnId: 'turn', seq: 2 },
        { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
      ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    const changes: boolean[] = [];
    await page.route(`**/api/structured/sessions/${session.id}/thread`, async route => {
      const { archived } = route.request().postDataJSON();
      changes.push(archived);
      await route.fulfill({ json: { thread: { archived } } });
    });
    let deletes = 0;
    page.on('request', request => { if (request.method() === 'DELETE' && request.url().includes(session.id)) deletes += 1; });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`archive-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep this unsent draft.');
    if (viewport.width === 320) {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Archive thread', exact: true }).click();
      await expect.poll(() => changes).toEqual([true]);
      await expect(page.locator('.mobile-header-project-context')).toHaveAttribute('aria-label', 'archive-fixture, Archived thread');
      await expect(composer).toHaveValue('Keep this unsent draft.');
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
      await drawer.getByRole('button', { name: /Archived threads/ }).click();
      await expect(drawer.getByRole('button', { name: 'Restore Archive fixture' })).toBeVisible();
      await drawer.getByRole('searchbox', { name: 'Search threads' }).fill('Archive');
      const archiveToggle = drawer.getByRole('button', { name: /Archived threads/ });
      await expect(archiveToggle).toHaveAttribute('aria-expanded', 'true');
      await archiveToggle.click();
      await expect(archiveToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(drawer.getByRole('button', { name: 'Restore Archive fixture' })).toHaveCount(0);
      await archiveToggle.click();
      await expect(drawer.getByRole('button', { name: 'Restore Archive fixture' })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('archived-drawer.png'), animations: 'disabled' });
      await drawer.getByRole('button', { name: 'Restore Archive fixture' }).click();
      await expect.poll(() => changes).toEqual([true, false]);
      await expect(drawer.getByRole('searchbox', { name: 'Search threads' })).toBeFocused();
      await drawer.getByRole('button', { name: 'Close menu' }).click();
    } else {
      await page.getByRole('button', { name: 'Thread actions for Archive fixture' }).click();
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
      await expect.poll(() => changes).toEqual([true]);
      await page.getByRole('button', { name: /Archived \(1\)/ }).click();
      await page.getByRole('button', { name: 'Thread actions for Archive fixture' }).click();
      await page.getByRole('menuitem', { name: 'Unarchive', exact: true }).click();
      await expect.poll(() => changes).toEqual([true, false]);
      await page.getByRole('button', { name: 'Select Archive fixture' }).click();
    }
    await expect(composer).toHaveValue('Keep this unsent draft.');
    expect(deletes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}
