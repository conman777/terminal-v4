import { test, expect, type Page } from '@playwright/test';
import { fixtureDraft, installFixture, managedChromium } from './ui-unification-fixture';

test.skip(process.env.E2E_CHAT_FLOW !== '1', 'Opt in against an isolated local-testing API.');
test.use({ launchOptions: { executablePath: managedChromium } });

async function openConversation(page: Page, fixture: Awaited<ReturnType<typeof installFixture>>) {
  await fixture.login();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Review the workspace.');
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'tmp /tmp', exact: true }).click();
  await start.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(page.getByText('The workspace now keeps a clear reading rail.', { exact: false })).toBeVisible();
}

for (const profile of [
  { phone: false, name: 'desktop chat', width: 1440, height: 1000 },
  { phone: true, name: 'phone chat', width: 390, height: 844 },
  { phone: true, name: 'narrow phone chat', width: 320, height: 844 },
]) {
  const phone = profile.phone;
  test.describe(profile.name, () => {
    test.use({ viewport: { width: profile.width, height: profile.height }, hasTouch: phone, isMobile: phone });
    for (const approved of [false, true]) {
      test(`one inline browser decision ${approved ? 'allows' : 'denies'} the exact action and retains the draft`, async ({ page }, testInfo) => {
        const fixture = await installFixture(page, testInfo);
        const reviewId = '00000000-0000-4000-8000-000000000002';
        let pending = false;
        const decisions: unknown[] = [];
        let nativeDecisions = 0;
        page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/api/structured/sessions/${fixture.structuredId}/approve`)) nativeDecisions++; });
        await page.route('**/api/workspace-browser/approvals**', async route => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (request.method() === 'GET' && pathname === '/api/workspace-browser/approvals') {
            return route.fulfill({ json: { requests: pending ? [{ id: reviewId, label: `codex:${fixture.structuredId}:00000000-0000-4000-8000-000000000001`, name: 'browser_tabs', arguments: {}, target: {} }] : [] } });
          }
          if (request.method() === 'POST' && pathname === `/api/workspace-browser/approvals/${reviewId}` && pending) {
            decisions.push({ id: reviewId, ...request.postDataJSON() });
            pending = false;
            fixture.emitStructured({ type: 'tool_completed', turnId: 'chat-turn', toolCallId: 'chat-browser', toolName: 'terminal_v4_browser.browser_tabs', result: approved ? '[]' : 'Browser action denied', isError: !approved });
            fixture.emitStructured({ type: 'turn_completed', turnId: 'chat-turn', status: 'completed' });
            return route.fulfill({ status: 204 });
          }
          return route.fulfill({ status: 403, json: { error: 'Unrecognized synthetic browser decision' } });
        });
        try {
          await openConversation(page, fixture);
          const input = page.getByRole('textbox', { name: 'Command composer', exact: true });
          await input.fill(fixtureDraft);
          pending = true;
          fixture.emitStructured({ type: 'turn_started', turnId: 'chat-turn' });
          fixture.emitStructured({ type: 'tool_started', turnId: 'chat-turn', toolCallId: 'chat-browser', toolName: 'terminal_v4_browser.browser_tabs', toolInput: {} });
          await expect(page.getByText('View open browser tabs?', { exact: true })).toBeVisible();
          if (!phone) await expect(page.locator('.ph-status')).toHaveText('Waiting for approval');
          const stop = page.locator('.workspace-composer').getByRole('button', { name: 'Stop response', exact: true });
          await expect(stop).toBeEnabled();
          await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(1);
          const stopBox = await stop.boundingBox();
          const sendBox = await page.locator('.workspace-composer').getByRole('button', { name: 'Send message', exact: true }).boundingBox();
          expect(Math.abs(stopBox!.y - sendBox!.y)).toBeLessThanOrEqual(1);
          expect(stopBox!.width).toBeGreaterThanOrEqual(phone ? 44 : 28);
          expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
          await expect(page.locator('.structured-tool-running-line').filter({ hasText: /^Running/ })).toHaveCount(0);
          await fixture.screenshot('single-inline-browser-approval');
          const review = page.locator('.structured-browser-approval');
          await review.getByRole('button', { name: approved ? 'Approve' : 'Reject', exact: true }).click();
          await expect.poll(() => decisions).toEqual([{ id: reviewId, approved }]);
          expect(nativeDecisions).toBe(0);
          await expect(page.getByText('View open browser tabs?', { exact: true })).toHaveCount(0);
          await expect(input).toHaveValue(fixtureDraft);
          await expect(page.locator('.workspace-composer').getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
          expect(fixture.pageErrors).toEqual([]);
          fixture.passed();
        } finally { await fixture.finish(); }
      });
    }
    test('composer Stop cancels once and keeps an unsent follow-up', async ({ page }, testInfo) => {
      const fixture = await installFixture(page, testInfo);
      let finishStop: () => void = () => {};
      let interrupts = 0;
      await page.route(`**/api/structured/sessions/${fixture.structuredId}/interrupt`, async route => {
        interrupts++;
        await new Promise<void>(resolve => { finishStop = resolve; });
        fixture.emitStructured({ type: 'turn_completed', turnId: 'chat-stoppable', status: 'cancelled' });
        await route.fulfill({ json: { status: 'cancelled', cleanupConfirmed: true } });
      });
      try {
        await openConversation(page, fixture);
        const input = page.getByRole('textbox', { name: 'Command composer', exact: true });
        await input.fill(fixtureDraft);
        fixture.emitStructured({ type: 'turn_started', turnId: 'chat-stoppable' });
        const composer = page.locator('.workspace-composer');
        await composer.getByRole('button', { name: 'Stop response', exact: true }).click();
        await expect(composer.getByRole('button', { name: 'Stopping response', exact: true })).toBeDisabled();
        await expect(input).toHaveValue(fixtureDraft);
        await fixture.screenshot('composer-stopping');
        finishStop();
        await expect(composer.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
        await expect(composer.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
        await expect(input).toHaveValue(fixtureDraft);
        expect(interrupts).toBe(1);
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { finishStop(); await fixture.finish(); }
    });
    test('reopened cleanup explains the retry action and stopping state', async ({ page }, testInfo) => {
      const fixture = await installFixture(page, testInfo);
      let finishStop: () => void = () => {};
      await page.route(`**/api/structured/sessions/${fixture.structuredId}/interrupt`, async route => {
        await new Promise<void>(resolve => { finishStop = resolve; });
        fixture.setStructuredStatus('idle');
        fixture.emitStructured({ type: 'status', status: 'idle' });
        await route.fulfill({ json: { status: 'cancelled', cleanupConfirmed: true } });
      });
      try {
        await openConversation(page, fixture);
        await page.getByRole('textbox', { name: 'Command composer', exact: true }).fill(fixtureDraft);
        fixture.setStructuredStatus('cleanup_required');
        await page.reload();
        const input = page.getByRole('textbox', { name: 'Command composer', exact: true });
        const retry = page.getByRole('button', { name: 'Retry cancellation', exact: true });
        await expect(retry).toBeVisible();
        await expect(retry).toHaveText('Retry cancellation');
        await expect(retry).toBeEnabled();
        await expect(input).toHaveValue(fixtureDraft);
        if (phone) await expect(page.getByRole('status', { name: 'Response cancellation' })).toContainText('Cancellation is not confirmed.');
        else await expect(page.locator('.ph-status')).toHaveText('Needs attention');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(profile.width);
        await fixture.screenshot('persisted-cancellation-recovery');
        await retry.click();
        await expect(page.getByRole('button', { name: 'Stopping response', exact: true })).toBeDisabled();
        if (phone) await expect(page.getByRole('status', { name: 'Response cancellation' })).toHaveText('Stopping response…');
        await fixture.screenshot('persisted-cancellation-stopping');
        finishStop();
        await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
        await expect(input).toHaveValue(fixtureDraft);
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { finishStop(); await fixture.finish(); }
    });
  });
}
