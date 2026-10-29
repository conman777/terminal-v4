import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });

test('mobile plan and edit actions preserve the unsent draft', async ({ page }, testInfo) => {
  const session = { id: 'ss-mobile-plan-actions', runtime: 'codex', provider: 'codex', title: 'Review plan', cwd: '/tmp/action-fixture', status: 'completed', model: 'fixture-model', reasoning: 'high' };
  const sent: string[] = [];
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', models: [{ id: 'fixture-model', label: 'Fixture model' }], reasoningLevels: ['high'] }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.route(`**/api/structured/sessions/${session.id}/input`, async route => {
    const body = route.request().postDataJSON();
    sent.push(body.text);
    await route.fulfill({ json: { requestId: body.requestId, messageId: 'accepted-message', turnId: 'accepted-turn', acceptedSeq: 3, status: 'accepted' } });
  });
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
    for (const event of [
      { type: 'message_completed', role: 'user', messageId: 'user', turnId: 'turn', content: '[Plan] Review the layout', seq: 1 },
      { type: 'message_completed', role: 'assistant', messageId: 'assistant', turnId: 'turn', content: 'First adjust the layout.', seq: 2 },
      { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
    ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`actions-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText('First adjust the layout.')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Command composer' });
  await composer.fill('Keep my draft');
  const edit = page.getByRole('button', { name: 'Edit as new message' });
  const fork = page.getByRole('button', { name: 'Fork from here' });
  for (const action of [edit, fork]) {
    const bounds = await action.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
  }
  await edit.click();
  await expect(composer).toHaveValue('Keep my draft\n\nReview the layout');
  await page.getByLabel('More composer actions', { exact: true }).click();
  const planMode = page.getByRole('button', { name: 'Plan mode' });
  await expect(planMode).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('mobile-plan-controls.png') });
  await planMode.click();
  await expect(planMode).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('More composer actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Implement plan', exact: true }).click();
  await expect.poll(() => sent).toEqual(['Implement the plan above.\n']);
  await expect(composer).toHaveValue('Keep my draft\n\nReview the layout');
});
