import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1280, height: 800 } });

test('an older server cannot receive an advanced schedule', async ({ page }) => {
  const session = { id: 'ss-schedule-compat', provider: 'codex', runtime: 'codex', title: 'Compatibility fixture', cwd: '/tmp/schedule-compat-fixture',
    status: 'completed', model: 'fixture-model', reasoning: 'high', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' };
  let schedulePosts = 0;
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, capabilities: { durableTasks: true }, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: ['high'] }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.route('**/api/workspace/tasks*', route => route.fulfill({ json: { tasks: [], schedules: [] } }));
  await page.route('**/api/workspace/schedules/capabilities', route => route.fulfill({ status: 404, json: { error: 'Not found' } }));
  await page.route('**/api/workspace/schedules', route => { schedulePosts += 1; return route.fulfill({ json: {} }); });
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
    for (const event of [
      { type: 'message_completed', role: 'assistant', content: 'Compatibility test session', messageId: 'compat-message', turnId: 'compat-turn', seq: 1 },
      { type: 'turn_completed', turnId: 'compat-turn', status: 'completed', seq: 2 },
    ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`compat-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText('Compatibility test session', { exact: true })).toBeVisible();
  await page.getByRole('complementary', { name: 'Threads' }).getByRole('button', { name: 'Project tools' }).click();
  const tools = page.locator('.workspace-tools-dialog');
  await tools.getByRole('tab', { name: 'Tasks & schedules' }).click();
  await tools.getByRole('textbox', { name: 'Task prompt' }).fill('Review the project');
  await tools.getByText('Make a schedule').click();
  await tools.getByRole('textbox', { name: 'Schedule name' }).fill('One-time check');
  await tools.getByLabel('Runs').selectOption('once');
  await expect(tools.getByText(/Advanced scheduling is unavailable on this server/)).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Create schedule' })).toBeDisabled();
  expect(schedulePosts).toBe(0);
});
