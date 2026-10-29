import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_REAL_RAW_PREVIEW !== '1', 'Requires the isolated preview server and synthetic process.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER, args: ['--host-resolver-rules=MAP raw-fixture.test 127.0.0.1', '--no-proxy-server'] }, viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true });

test('real preview server holds competing HTTP raw input and recovers an uncertain receipt', async ({ page, context }) => {
  test.setTimeout(45_000);
  const backend = 'http://127.0.0.1:43891';
  const root = process.env.E2E_FIXTURE_ROOT;
  if (!root) throw new Error('The isolated fixture root is required.');
  const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
  expect(login.status).toBe(200);
  const identity = await login.json();
  const token = identity.tokens.accessToken;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: `${root}/workspace`, provider: 'claude' }) });
  expect(created.status).toBe(201);
  const session = await created.json();
  const sessionId = session.id;
  let releaseFirstBatch!: () => void;
  const firstBatchReleased = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
  await context.addInitScript(value => {
    localStorage.setItem('terminal_access_token', value.tokens.accessToken);
    localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
    localStorage.setItem('terminal_user', JSON.stringify(value.user));
    localStorage.setItem('terminal_auth_session', 'isolated-browser-fixture');
  }, identity);
  try {
    await page.goto('/e2e/fixtures/supervised-insecure.html');
    expect(await page.evaluate(() => ({ secure: isSecureContext, webLocks: Boolean(navigator.locks) }))).toEqual({ secure: false, webLocks: false });
    await expect(page.getByText('Isolated raw input fixture')).toBeVisible();
    const other = await context.newPage();
    await other.goto('/e2e/fixtures/supervised-insecure.html');
    await expect(other.getByText('Isolated raw input fixture')).toBeVisible();
    await context.route('**/api/structured/**', async route => {
      const url = new URL(route.request().url());
      if (/input-capabilities|input-receipts|input-operation|supervised-input/.test(url.pathname)) await new Promise(resolve => setTimeout(resolve, 150));
      if (url.pathname.endsWith('/supervised-input') && route.request().postDataJSON().text === 'ab') {
        const response = await route.fetch({ url: `${backend}${url.pathname}${url.search}` });
        await firstBatchReleased;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'start synthetic agent' }) });
    expect(start.status).toBe(202);
    const send = (tab: typeof page, text: string) => tab.evaluate(async ({ id, input }) => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      try { return await sendRawInput(id, input, () => { throw new Error('unexpected legacy path'); }); }
      catch (error) { return { error: (error as Error).message }; }
    }, { id: sessionId, input: text });
    const delivered = await send(page, '\n');
    expect(delivered).toMatchObject({ accepted: true });
    const sentBatches: string[] = [];
    page.on('request', value => { if (value.url().endsWith('/supervised-input') && value.method() === 'POST') sentBatches.push(value.postDataJSON().text); });
    const firstBatch = page.waitForRequest(value => value.url().endsWith('/supervised-input') && value.method() === 'POST');
    await page.evaluate(id => {
      const queue = (window as any).fixtureGetQueue(id);
      queue.enqueue('a'); queue.enqueue('b');
      (window as any).fixtureQueue = queue;
    }, sessionId);
    await firstBatch;
    const waiting = await page.evaluate(() => {
      const queue = (window as any).fixtureQueue;
      const first = queue.enqueue('c'), second = queue.enqueue('d');
      return { first, second, ...queue.getSnapshot() };
    });
    expect(waiting).toMatchObject({ first: true, second: true, pending: 2, sending: true });
    await expect(page.getByRole('status', { name: 'Pending terminal input' })).toContainText('2 characters waiting');
    releaseFirstBatch();
    await expect.poll(() => sentBatches).toEqual(['ab', 'cd']);
    await expect(page.getByRole('status', { name: 'Pending terminal input' })).toHaveCount(0);
    let competingWrites = 0;
    other.on('request', value => { if (value.url().endsWith('/supervised-input') && value.method() === 'POST') competingWrites += 1; });
    const request = page.waitForRequest(value => value.url().endsWith('/supervised-input') && value.method() === 'POST');
    const partial = send(page, 'x'.repeat(100_000));
    await request;
    const competing = await send(other, '\n');
    expect(competing).toHaveProperty('error', expect.stringMatching(/previous input needs review|could not reserve/i));
    expect(competingWrites).toBe(0);
    const uncertain = await partial;
    expect(uncertain).toHaveProperty('error', expect.stringContaining('could not be confirmed'));
    await expect(page.getByRole('region', { name: 'Input delivery review' })).toContainText('Delivery uncertain');
    const receiptResponse = await fetch(`${backend}/api/structured/input-receipts`, { headers });
    const receipts = await receiptResponse.json();
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0]).toMatchObject({ sessionId, status: 'uncertain' });
    const requestId = receipts.receipts[0].requestId;
    await page.close();
    await other.reload();
    const review = other.getByRole('region', { name: 'Input delivery review' });
    await expect(review).toContainText('Delivery uncertain');
    await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
    await review.getByRole('button', { name: 'Continue after review' }).click();
    await expect(review).toHaveCount(0);
    const reviewed = await fetch(`${backend}/api/structured/input-receipts/${sessionId}/${requestId}`, { headers });
    expect(await reviewed.json()).toMatchObject({ sessionId, requestId, status: 'reviewed' });
  } finally {
    releaseFirstBatch();
    await fetch(`${backend}/api/structured/sessions/${sessionId}`, { method: 'DELETE', headers }).catch(() => {});
  }
});

test('a lost delivered response remains recoverable from another tab', async ({ page, context }) => {
  test.setTimeout(45_000);
  const backend = 'http://127.0.0.1:43891', root = process.env.E2E_FIXTURE_ROOT;
  if (!root) throw new Error('The isolated fixture root is required.');
  const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
  expect(login.status).toBe(200);
  const identity = await login.json();
  const headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: `${root}/workspace`, provider: 'claude' }) });
  expect(created.status).toBe(201);
  const { id: sessionId } = await created.json();
  await context.addInitScript(value => {
    localStorage.setItem('terminal_access_token', value.tokens.accessToken);
    localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
    localStorage.setItem('terminal_user', JSON.stringify(value.user));
    localStorage.setItem('terminal_auth_session', 'isolated-browser-fixture');
  }, identity);
  try {
    await page.goto('/e2e/fixtures/supervised-insecure.html');
    const other = await context.newPage();
    await other.goto('/e2e/fixtures/supervised-insecure.html');
    const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'start synthetic agent' }) });
    expect(start.status).toBe(202);
    await page.route('**/api/structured/sessions/*/supervised-input', async route => {
      const url = new URL(route.request().url());
      const delivered = await route.fetch({ url: `${backend}${url.pathname}` });
      expect(delivered.status()).toBe(202);
      await route.abort('failed');
    });
    const outcome = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      try { await sendRawInput(id, '\n', () => { throw new Error('unexpected legacy path'); }); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    }, sessionId);
    expect(outcome).toContain('could not be confirmed');
    const receipts = await (await fetch(`${backend}/api/structured/input-receipts`, { headers })).json();
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.receipts[0]).toMatchObject({ sessionId, status: 'delivered' });
    const requestId = receipts.receipts[0].requestId;
    await page.close();
    await other.reload();
    const review = other.getByRole('region', { name: 'Input delivery review' });
    await expect(review).toContainText('Delivery confirmed');
    await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
    await review.getByRole('button', { name: 'Continue after review' }).click();
    await expect(review).toHaveCount(0);
    const acknowledged = await fetch(`${backend}/api/structured/input-receipts/${sessionId}/${requestId}`, { headers });
    expect(await acknowledged.json()).toMatchObject({ sessionId, requestId, status: 'acknowledged' });
  } finally {
    await fetch(`${backend}/api/structured/sessions/${sessionId}`, { method: 'DELETE', headers }).catch(() => {});
  }
});

test('a restored legacy session uses the real legacy input endpoint', async ({ page, context }) => {
  test.skip(!process.env.E2E_LEGACY_FIXTURE_FILE, 'Requires a restored synthetic legacy session.');
  const backend = 'http://127.0.0.1:43891';
  const { identity, sessionId } = JSON.parse(readFileSync(process.env.E2E_LEGACY_FIXTURE_FILE!, 'utf8'));
  const headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
  await context.addInitScript(value => {
    localStorage.setItem('terminal_access_token', value.tokens.accessToken);
    localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
    localStorage.setItem('terminal_user', JSON.stringify(value.user));
    localStorage.setItem('terminal_auth_session', 'isolated-browser-fixture');
  }, identity);
  try {
    expect((await fetch(`${backend}/api/structured/input-capabilities`, { headers })).status).toBe(200);
    expect((await fetch(`${backend}/api/structured/sessions/${sessionId}/input-capabilities`, { headers })).status).toBe(404);
    const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'start synthetic agent' }) });
    expect(start.status).toBe(202);
    await page.goto('/e2e/fixtures/supervised-insecure.html');
    const sent: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') sent.push(new URL(request.url()).pathname); });
    const result = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      const { apiFetch } = await import('/src/utils/api.js');
      return sendRawInput(id, '\n', async (session, text) => {
        const response = await apiFetch(`/api/structured/sessions/${session}/input`, { method: 'POST', body: { text } });
        return { accepted: response.ok, status: response.status };
      });
    }, sessionId);
    expect(result).toMatchObject({ accepted: true });
    expect(sent).toContain(`/api/structured/sessions/${sessionId}/input`);
    expect(sent.some(path => path.endsWith('/supervised-input') || path.endsWith('/input-operation'))).toBe(false);
  } finally {
    await fetch(`${backend}/api/structured/sessions/${sessionId}`, { method: 'DELETE', headers }).catch(() => {});
  }
});
