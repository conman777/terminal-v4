import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_APPROVAL_FIXTURE !== '1', 'Requires the isolated synthetic approval fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER, ...(process.env.E2E_APPROVAL_INSECURE === '1' ? { args: ['--host-resolver-rules=MAP raw-fixture.test 127.0.0.1', '--no-proxy-server'] } : {}) } });

for (const width of [393, 1200]) {
  test(`uncertain Codex approval remains reviewable at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 700 });
    await context.addInitScript(() => {
      const payload = btoa(JSON.stringify({ sub: 'approval-fixture', exp: 4102444800 })).replace(/=/g, '');
      localStorage.setItem('terminal_access_token', `e30.${payload}.signature`);
      localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
      localStorage.setItem('terminal_user', JSON.stringify({ id: 'approval-fixture' }));
      localStorage.setItem('terminal_auth_session', 'approval-fixture');
      class FixtureSocket {
        onopen; onmessage; onclose;
        constructor() {
          setTimeout(() => {
            this.onopen?.(new Event('open'));
            const events = [
              { seq: 1, type: 'turn_started', turnId: 'turn-one' },
              { seq: 2, type: 'approval_required', approvalId: 'approval-one', turnId: 'turn-one', toolName: 'run_command', description: 'Run synthetic checks?', toolInput: { command: 'npm test' } },
              { seq: 3, type: 'approval_decision_started', approvalId: 'approval-one', turnId: 'turn-one', approved: true, forSession: false },
              { seq: 4, type: 'turn_completed', turnId: 'turn-one', status: 'interrupted' },
            ];
            for (const event of events) this.onmessage?.({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
          }, 20);
        }
        close() { this.onclose?.({ code: 1000 }); }
      }
      window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
    });
    let reviewCalls = 0, approvalCalls = 0;
    await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
    await context.route('**/api/structured/sessions/ss-approval-fixture/approve', route => { approvalCalls += 1; return route.fulfill({ status: 500, json: {} }); });
    await context.route('**/api/structured/sessions/ss-approval-fixture/approval-claims/approval-one/review', route => {
      reviewCalls += 1;
      return reviewCalls === 1 ? route.fulfill({ status: 409, json: { error: 'Stop the session first.' } }) : route.fulfill({ json: { approvalId: 'approval-one', status: 'reviewed' } });
    });
    await page.goto('/e2e/fixtures/uncertain-approval.html');
    const card = page.getByRole('group', { name: 'Uncertain approval decision' });
    await expect(card).toContainText('The decision may have been delivered');
    await expect(card).toContainText('Run synthetic checks?');
    await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    const review = card.getByRole('button', { name: 'Acknowledge review' });
    await expect(review).toBeDisabled();
    await card.getByRole('checkbox', { name: /I inspected the action/ }).check();
    await review.click();
    await expect(page.getByRole('alert')).toContainText('Stop the session first.');
    await expect(card).toBeVisible();
    await review.click();
    await expect(card).toHaveCount(0);
    expect([reviewCalls, approvalCalls]).toEqual([2, 0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('lost approval response cannot be retried and can be reviewed after stopping', async ({ page, context }) => {
  await page.setViewportSize({ width: 393, height: 700 });
  await context.addInitScript(() => {
    const payload = btoa(JSON.stringify({ sub: 'approval-fixture', exp: 4102444800 })).replace(/=/g, '');
    localStorage.setItem('terminal_access_token', `e30.${payload}.signature`);
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'approval-fixture' }));
    localStorage.setItem('terminal_auth_session', 'approval-fixture');
    class FixtureSocket {
      onopen; onmessage; onclose;
      constructor() {
        (window as any).fixtureApprovalSocket = this;
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          for (const event of [
            { seq: 1, type: 'turn_started', turnId: 'turn-one' },
            { seq: 2, type: 'approval_required', approvalId: 'approval-one', turnId: 'turn-one', toolName: 'run_command', description: 'Run synthetic checks?' },
          ]) this.onmessage?.({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
        }, 20);
      }
      close() { this.onclose?.({ code: 1000 }); }
    }
    window.WebSocket = FixtureSocket as unknown as typeof WebSocket;
  });
  let approvals = 0, reviews = 0;
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await context.route('**/api/structured/sessions/ss-approval-fixture/approval-capability', route => route.fulfill({ json: { protocol: 1, mode: 'reservation', outstanding: false } }));
  await context.route('**/api/structured/sessions/ss-approval-fixture/approval-claims/approval-one/reserve', route => route.fulfill({ json: { approvalId: 'approval-one', reservationId: 'reservation-one', deliveryToken: 'fixture-token', status: 'reserved' } }));
  await context.route('**/api/structured/sessions/ss-approval-fixture/approve', route => { approvals += 1; return route.abort('failed'); });
  await context.route('**/api/structured/sessions/ss-approval-fixture/approval-claims/approval-one/review', route => { reviews += 1; return route.fulfill({ json: { approvalId: 'approval-one', status: 'reviewed' } }); });
  await page.goto('/e2e/fixtures/uncertain-approval.html');
  if (process.env.E2E_APPROVAL_INSECURE === '1') expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const card = page.getByRole('group', { name: 'Uncertain approval decision' });
  await expect(card).toContainText('The decision may have been delivered');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  const saved = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('approvalDecision:v1:')).map(([, value]) => JSON.parse(value)));
  expect(saved).toEqual([{ version: 1, sessionId: 'ss-approval-fixture', approvalId: 'approval-one', intentId: expect.any(String) }]);
  await page.reload();
  await expect(card).toContainText('The decision may have been delivered');
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await card.getByRole('checkbox', { name: /I inspected the action/ }).check();
  await expect(card.getByRole('button', { name: 'Acknowledge review' })).toBeDisabled();
  await page.evaluate(() => (window as any).fixtureApprovalSocket.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 3, type: 'turn_completed', turnId: 'turn-one', status: 'interrupted' } }) }));
  await card.getByRole('button', { name: 'Acknowledge review' }).click();
  await expect(card).toHaveCount(0);
  expect([approvals, reviews]).toEqual([1, 1]);
});
