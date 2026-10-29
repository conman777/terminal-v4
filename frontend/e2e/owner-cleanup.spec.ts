import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_OWNER_CLEANUP_FIXTURE !== '1', 'Requires the isolated cleanup UI fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const width of [320, 393, 1200]) {
  test(`owner cleanup is readable and recoverable at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 700 });
    await context.addInitScript(() => {
      const payload = btoa(JSON.stringify({ sub: 'cleanup-fixture', exp: 4102444800 })).replace(/=/g, '');
      localStorage.setItem('terminal_access_token', `e30.${payload}.signature`);
      localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
      localStorage.setItem('terminal_user', JSON.stringify({ id: 'cleanup-fixture' }));
      localStorage.setItem('terminal_auth_session', 'cleanup-fixture');
    });
    let retryCalls = 0;
    await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
    await context.route('**/api/structured/owner-cleanup', route => route.fulfill({ json: { state: 'pending', requestId: 'private-id', resources: { structured: 'pending', delegation: 'confirmed', background: 'not_installed' } } }));
    await context.route('**/api/structured/owner-cleanup/retry', route => { retryCalls += 1; return route.fulfill({ json: { state: 'complete', requestId: 'private-id', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'not_installed' } } }); });
    await page.goto('/e2e/fixtures/owner-cleanup.html');
    const panel = page.getByRole('region', { name: 'Sign-out cleanup' });
    await expect(panel).toContainText('cleanup is still pending');
    await expect(panel).not.toContainText('private-id');
    const retry = panel.getByRole('button', { name: 'Retry cleanup' });
    expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await retry.click();
    await expect(panel).toContainText('cleanup is complete');
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel).toHaveCount(0);
    expect(retryCalls).toBe(1);
  });

  test(`background review requires confirmation and recovers a lost response at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 700 });
    await context.addInitScript(() => {
      const payload = btoa(JSON.stringify({ sub: 'cleanup-fixture', exp: 4102444800 })).replace(/=/g, '');
      localStorage.setItem('terminal_access_token', `e30.${payload}.signature`);
      localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
      localStorage.setItem('terminal_user', JSON.stringify({ id: 'cleanup-fixture' }));
      localStorage.setItem('terminal_auth_session', 'cleanup-fixture');
    });
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
    const pending = { state: 'review_required', requestId, backgroundReview: 'none', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'unconfirmed' } };
    const reviewed = { state: 'complete', requestId: null, backgroundReview: 'user_attested', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'confirmed' } };
    const operations: string[] = [];
    let complete = false;
    await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
    await context.route('**/api/structured/owner-cleanup', route => route.fulfill({ json: complete ? reviewed : pending }));
    await context.route('**/api/structured/owner-cleanup/background-review', route => {
      const body = route.request().postDataJSON();
      expect(body.requestId).toBe(requestId);
      expect(body.acknowledged).toBe(true);
      operations.push(body.operationId);
      if (operations.length === 1) return route.abort();
      complete = true;
      return route.fulfill({ json: { status: 'reviewed', requestId, operationId: body.operationId, reviewedCount: 1 } });
    });
    await page.goto('/e2e/fixtures/owner-cleanup.html');
    const panel = page.getByRole('region', { name: 'Sign-out cleanup' });
    await expect(panel).toContainText('Individual processes cannot be identified');
    await expect(panel).toContainText('server cannot verify');
    await expect(panel).not.toContainText(requestId);
    const confirm = panel.getByRole('button', { name: 'Confirm background review' });
    await expect(confirm).toBeDisabled();
    await panel.getByRole('checkbox', { name: /all associated background processes have stopped/i }).check();
    await confirm.scrollIntoViewIfNeeded();
    expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await confirm.click();
    await expect(panel.getByRole('alert')).toContainText('could not be confirmed');
    await expect(confirm).toBeDisabled();
    await panel.getByRole('button', { name: 'Check cleanup status' }).click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(panel).toContainText('previous cleanup review');
    await expect(panel).toContainText('server did not verify');
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`delegated child review requires confirmation at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 700 });
    await context.addInitScript(() => {
      const payload = btoa(JSON.stringify({ sub: 'cleanup-fixture', exp: 4102444800 })).replace(/=/g, '');
      localStorage.setItem('terminal_access_token', `e30.${payload}.signature`);
      localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
      localStorage.setItem('terminal_user', JSON.stringify({ id: 'cleanup-fixture' }));
      localStorage.setItem('terminal_auth_session', 'cleanup-fixture');
    });
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
    const child = { childOperationId: '84f7131a-c8da-41c8-84af-ef207c1723f0', taskId: 'fixture-task', childSessionId: 'fixture-session', workspacePath: '/synthetic/workspace', provider: 'fixture-provider', model: 'fixture-model' };
    const pending = { state: 'review_required', requestId, delegationReview: 'none', resources: { structured: 'confirmed', delegation: 'unconfirmed', background: 'not_installed' } };
    const complete = { state: 'complete', requestId: null, delegationReview: 'user_attested', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'not_installed' } };
    let reviewed = false, calls = 0;
    await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
    await context.route('**/api/structured/owner-cleanup', route => route.fulfill({ json: reviewed ? complete : pending }));
    await context.route('**/api/structured/owner-cleanup/delegation-children', route => route.fulfill({ json: { requestId, children: [child] } }));
    await context.route('**/api/structured/owner-cleanup/delegation-review', route => {
      const body = route.request().postDataJSON(); calls += 1;
      expect(body).toEqual({ requestId, operationId: expect.any(String), childOperationId: child.childOperationId, acknowledged: true });
      reviewed = true;
      return route.fulfill({ json: { status: 'reviewed', requestId, operationId: body.operationId, childOperationId: child.childOperationId, taskId: child.taskId, childSessionId: child.childSessionId } });
    });
    await page.goto('/e2e/fixtures/owner-cleanup.html');
    const panel = page.getByRole('region', { name: 'Sign-out cleanup' });
    await expect(panel).toContainText('Process identities are not saved');
    await expect(panel).toContainText('/synthetic/workspace');
    await expect(panel).toContainText('server cannot verify');
    const confirm = panel.getByRole('button', { name: 'Confirm delegated child review' });
    await expect(confirm).toBeDisabled();
    await panel.getByRole('checkbox', { name: /personally checked and stopped all associated processes/i }).check();
    await confirm.scrollIntoViewIfNeeded();
    expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await confirm.click();
    await expect(panel).toContainText('previous cleanup review');
    await expect(panel).toContainText('server did not verify');
    expect(calls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
