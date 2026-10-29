import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const session = {
  id: 'ss-find-in-thread-fixture', provider: 'codex', runtime: 'codex', title: 'Find in thread',
  cwd: '/tmp/find-in-thread-fixture', status: 'completed', model: 'gpt-6.1-sol', reasoning: 'high',
  createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
};

for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
  test(`finds conversation messages and updates live at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
      id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'],
    }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    let push = (_event: object) => {};
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      push = event => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      push({ type: 'message_completed', role: 'user', content: 'First needle', messageId: 'user', turnId: 'turn', seq: 1 });
      push({ type: 'message_completed', role: 'assistant', content: 'A **hidden** [diagnostic](https://example.test)', messageId: 'interim', turnId: 'turn', seq: 2 });
      push({ type: 'message_completed', role: 'reasoning', content: 'Inspect the **reasoning** details', messageId: 'reasoning', turnId: 'turn', seq: 3 });
      push({ type: 'message_completed', role: 'plan', content: JSON.stringify({ explanation: 'A plan for recovery', steps: [{ step: 'Check the results', status: 'pending' }] }), messageId: 'plan', turnId: 'turn', seq: 4 });
      push({ type: 'tool_started', toolName: 'read_file', toolCallId: 'tool', toolInput: { path: 'fixture.txt' }, turnId: 'turn', seq: 5 });
      push({ type: 'tool_completed', toolName: 'read_file', toolCallId: 'tool', result: 'Done', turnId: 'turn', seq: 6 });
      push({ type: 'tool_started', toolName: 'read_file', toolCallId: 'tool-2', toolInput: { path: 'other.txt' }, turnId: 'turn', seq: 7 });
      push({ type: 'tool_completed', toolName: 'read_file', toolCallId: 'tool-2', result: [...Array.from({ length: 13 }, (_, index) => `line ${index}`), 'deep output fixture'].join('\n'), turnId: 'turn', seq: 8 });
      push({ type: 'message_completed', role: 'assistant', content: 'Second needle', messageId: 'assistant', turnId: 'turn', seq: 9 });
      push({ type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 10 });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`find-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Second needle', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep this draft while finding messages.');
    await composer.focus();
    if (viewport.width === 320) {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('button', { name: 'Find in thread', exact: true }).click();
    } else await page.keyboard.press('Meta+f');
    const search = page.getByRole('searchbox', { name: 'Find in thread', exact: true });
    await expect(search).toBeFocused();
    const work = page.getByRole('button', { name: /^Worked(?: for |$)/ });
    await expect(work).toHaveAttribute('aria-expanded', 'false');
    await search.fill('hidden diagnostic');
    await expect(work).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.cc-find-current')).toContainText('A hidden diagnostic');
    await expect(search).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('find-folded-message.png') });
    await work.click();
    await search.fill('reasoning details');
    await expect(work).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.cc-find-current')).toContainText('Inspect the reasoning details');
    await search.fill('plan for recovery');
    await expect(page.locator('.cc-find-current')).toContainText('A plan for recovery');
    await search.focus();
    await page.screenshot({ path: testInfo.outputPath('find-folded-plan.png') });
    await work.click();
    await search.fill('deep output fixture');
    await expect(page.locator('.cc-find-current')).toContainText('deep output fixture');
    await expect(search).toBeFocused();
    await expect(page.locator('.cc-tool-header')).toHaveCount(2);
    await expect(page.locator('.cc-tool-header').nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.cc-tool-header').nth(1)).toHaveAttribute('aria-expanded', 'true');
    await page.screenshot({ path: testInfo.outputPath('find-folded-tool.png') });
    await search.fill('needle');
    await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();
    const next = page.getByRole('button', { name: 'Next match', exact: true });
    await next.click();
    await expect(page.locator('.cc-find-current')).toContainText('Second needle');
    if (viewport.width === 320) {
      expect((await search.boundingBox())!.width).toBeGreaterThanOrEqual(180);
      for (const label of ['Previous match', 'Next match', 'Close find']) {
        const bounds = await page.getByRole('button', { name: label, exact: true }).boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    }
    push({ type: 'message_completed', role: 'user', content: 'Third needle', messageId: 'user-2', turnId: 'turn-2', seq: 11 });
    await expect(page.getByText('2 of 3', { exact: true })).toBeVisible();
    push({ type: 'tool_started', toolName: 'run_command', toolCallId: 'live-tool', toolInput: { command: 'check' }, turnId: 'turn-2', seq: 12 });
    push({ type: 'tool_output', toolCallId: 'live-tool', turnId: 'turn-2', output: 'Streaming diagnostic result', seq: 13 });
    await search.fill('streaming diagnostic');
    await expect(page.locator('.cc-find-current')).toContainText('Streaming diagnostic result');
    await expect(page.getByText('1 of 1', { exact: true })).toBeVisible();
    push({ type: 'tool_completed', toolName: 'run_command', toolCallId: 'live-tool', turnId: 'turn-2', result: 'Done', seq: 14 });
    push({ type: 'tool_started', toolName: 'replace_text', toolCallId: 'edit-tool', toolInput: { path: 'fixture.txt', old_string: 'old value', new_string: 'needle in proposed edit' }, turnId: 'turn-2', seq: 15 });
    push({ type: 'tool_completed', toolName: 'replace_text', toolCallId: 'edit-tool', turnId: 'turn-2', result: 'Applied', seq: 16 });
    push({ type: 'message_completed', role: 'assistant', content: 'Changes reviewed', messageId: 'assistant-2', turnId: 'turn-2', seq: 17 });
    push({ type: 'turn_completed', turnId: 'turn-2', status: 'completed', seq: 18 });
    await search.fill('needle in proposed edit');
    await expect(page.locator('.cc-find-current')).toContainText('+needle in proposed edit');
    await expect(page.getByText('1 of 1', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('find-in-thread.png') });
    await page.getByRole('button', { name: 'Close find', exact: true }).click();
    await expect(composer).toHaveValue('Keep this draft while finding messages.');
    if (viewport.width === 320) await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeFocused();
    else await expect(composer).toBeFocused();
    await expect(page.locator('.cc-find-match')).toHaveCount(0);
  });
}
