import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 568 }, { width: 1280, height: 800 }]) {
  test.describe(`${viewport.width}px V4 question`, () => {
    test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
    test('answers the bound question without losing a draft', async ({ page }, testInfo) => {
      const session = { id: 'ss-question-fixture', provider: 'deepseek', runtime: 'v4', title: 'Question fixture', cwd: '/tmp/question-fixture', status: 'running', model: 'fixture-model', createdAt: '2026-10-25T10:00:00Z' };
      const decisions: unknown[] = [];
      await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'deepseek', label: 'DeepSeek', runtime: 'v4', available: true, status: 'ready', models: [{ id: 'fixture-model', label: 'Fixture model', default: true }] }] } }));
      await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
      await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
      await page.route(`**/api/structured/sessions/${session.id}/approve`, async route => {
        decisions.push(route.request().postDataJSON());
        await route.fulfill({ json: { status: 'accepted', approvalId: 'question-1', approved: true } });
      });
      await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
        for (const event of [
          { type: 'message_completed', role: 'assistant', content: 'I need a little more detail.', messageId: 'assistant', turnId: 'turn', seq: 1 },
          { type: 'turn_started', turnId: 'turn', seq: 2 },
          { type: 'approval_required', approvalId: 'question-1', turnId: 'turn', toolCallId: 'call-1', toolName: 'ask_user', description: 'The agent has a question for you.', toolInput: { questions: [{ id: 'device', question: 'Which device?', options: [{ label: 'Phone' }, { label: 'Desktop' }] }, { id: 'reason', question: 'What should I check?' }] }, seq: 3 },
        ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`question-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
      await composer.fill('Keep this draft.');
      const card = page.getByRole('group', { name: 'Agent question', exact: true });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: 'Send answers' })).toBeDisabled();
      await card.getByRole('radio', { name: 'Phone', exact: true }).check();
      await card.getByRole('textbox', { name: 'What should I check?', exact: true }).fill('The keyboard');
      await card.getByRole('button', { name: 'Send answers' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('question.png') });
      await card.getByRole('button', { name: 'Send answers' }).click();
      await expect.poll(() => decisions).toEqual([{ approvalId: 'question-1', approved: true, answers: { device: ['Phone'], reason: ['The keyboard'] } }]);
      await expect(card).toHaveCount(0);
      await expect(composer).toHaveValue('Keep this draft.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    });
  });
}
