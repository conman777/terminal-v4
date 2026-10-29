import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const session = {
  id: 'ss-todo-ui-fixture', provider: 'codex', runtime: 'codex', title: 'Task fixture',
  cwd: '/tmp/todo-ui-fixture', status: 'completed', model: 'gpt-6.1-sol', reasoning: 'high',
  createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
};

for (const viewport of [{ width: 320, height: 720 }, { width: 1280, height: 800 }]) {
  test(`renders successful and failed session tasks without losing a draft at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
      id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'],
    }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      const push = (event: object) => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      push({ type: 'message_completed', role: 'user', content: 'Review the tasks', messageId: 'prompt', turnId: 'turn', seq: 1 });
      push({ type: 'tool_started', toolName: 'todo_list', toolCallId: 'tasks', toolInput: {}, turnId: 'turn', seq: 2 });
      push({ type: 'tool_completed', toolName: 'todo_list', toolCallId: 'tasks', result: JSON.stringify({ todos: [
        { id: 'child', parent: 'parent', content: 'Verify the mobile layout', status: 'pending' },
        { id: 'parent', content: 'Inspect the interface', status: 'in_progress' },
        { id: 'done', content: 'Prepare the test', status: 'completed' },
        { id: 'cancelled', content: 'Skip old approach', status: 'cancelled' },
      ], revision: 2, summary: { total: 4, pending: 1, in_progress: 1, completed: 1, cancelled: 1 } }), turnId: 'turn', seq: 3 });
      push({ type: 'tool_started', toolName: 'todo_list', toolCallId: 'rejected', toolInput: { todos: [{ id: 'bad', content: 'Rejected task', status: 'completed' }] }, turnId: 'turn', seq: 4 });
      push({ type: 'tool_completed', toolName: 'todo_list', toolCallId: 'rejected', result: 'Task list could not be saved', isError: true, turnId: 'turn', seq: 5 });
      push({ type: 'message_completed', role: 'assistant', content: 'Task update finished', messageId: 'reply', turnId: 'turn', seq: 6 });
      push({ type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 7 });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`todo-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Task update finished', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep this unsent draft.');
    await page.getByRole('button', { name: /^Worked(?: for |$)/ }).click();
    await page.locator('.cc-structured-activity > summary').click();
    await page.getByRole('button', { name: /Task list.*Completed/ }).click();
    const list = page.getByRole('list', { name: 'Session tasks' });
    await expect(list).toContainText('Inspect the interface');
    await expect(list.locator('ul')).toContainText('Verify the mobile layout');
    for (const status of ['Pending', 'In progress', 'Completed', 'Cancelled']) await expect(list).toContainText(status);
    await page.getByRole('button', { name: /Task list.*Failed/ }).click();
    await expect(page.getByText('Task list could not be saved')).toBeVisible();
    await expect(list).not.toContainText('Rejected task');
    await expect(page.locator('.cc-todo-raw')).not.toHaveAttribute('open', '');
    await expect(composer).toHaveValue('Keep this unsent draft.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await page.screenshot({ path: testInfo.outputPath('session-todos.png') });
  });
}
