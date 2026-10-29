import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_NONSECURE_ORIGIN !== '1', 'Requires an isolated non-secure test origin.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER, args: ['--host-resolver-rules=MAP raw-fixture.test 127.0.0.1', '--no-proxy-server'] }, viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true });

test('HTTP without Web Locks uses the server hold and recovers input in another tab', async ({ page, context }) => {
  const sessionId = 'ss-insecure-raw-fixture';
  const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
  let status: 'none' | 'issued' | 'uncertain' | 'reviewed' = 'none';
  let issued = 0, sends = 0;
  const user = { id: 'synthetic-http-owner', username: 'synthetic-http-owner' };
  await context.addInitScript(fixtureUser => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify(fixtureUser));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  }, user);
  await context.route('**/api/**', route => route.fulfill({ json: {} }));
  await context.route('**/api/structured/input-capabilities', route => route.fulfill({ json: { protocol: 1 } }));
  await context.route(`**/api/structured/sessions/${sessionId}/input-capabilities`, route => route.fulfill({ json: { protocol: 1 } }));
  await context.route('**/api/structured/input-receipts', route => route.fulfill({ json: { receipts: ['issued', 'uncertain'].includes(status) ? [{ sessionId, requestId, status }] : [], nextCursor: null } }));
  await context.route(`**/api/structured/sessions/${sessionId}/input-operation`, route => {
    if (status !== 'none') return route.fulfill({ status: 409, json: { error: 'Previous input needs review' } });
    issued += 1; status = 'issued'; return route.fulfill({ json: { protocol: 1, requestId, deliveryToken: 'fixture-token' } });
  });
  await context.route(`**/api/structured/sessions/${sessionId}/supervised-input`, route => {
    sends += 1; status = 'uncertain'; return route.fulfill({ status: 409, json: { outcome: 'uncertain', requestId } });
  });
  await context.route(`**/api/structured/input-receipts/${sessionId}/${requestId}`, route => route.fulfill({ json: { sessionId, requestId, status } }));
  await context.route(`**/api/structured/input-receipts/${sessionId}/${requestId}/review`, route => { status = 'reviewed'; return route.fulfill({ json: { sessionId, requestId, status } }); });
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  expect(await page.evaluate(() => ({ secure: isSecureContext, webLocks: Boolean(navigator.locks) }))).toEqual({ secure: false, webLocks: false });
  await expect(page.getByText('Isolated raw input fixture')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/e2e/fixtures/supervised-insecure.html');
  await expect(other.getByText('Isolated raw input fixture')).toBeVisible();
  const send = (tab: typeof page) => tab.evaluate(async id => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    try { await sendRawInput(id, '\r', () => { throw new Error('unexpected legacy path'); }); return 'unexpected success'; }
    catch (error) { return (error as Error).message; }
  }, sessionId);
  const outcomes = await Promise.all([send(page), send(other)]);
  expect(outcomes.every(result => result !== 'unexpected success')).toBe(true);
  expect([issued, sends]).toEqual([1, 1]);
  const saved = await Promise.all([page, other].map(tab => tab.evaluate(() => Object.keys(localStorage).filter(key => key.includes('supervisedRawInput:v2:')))));
  expect(saved.map(keys => keys.length)).toEqual([1, 1]);
  const owner = outcomes[0].includes('could not be confirmed') ? page : other;
  const survivor = owner === page ? other : page;
  await owner.close();
  await survivor.reload();
  const review = survivor.getByRole('region', { name: 'Input delivery review' });
  await expect(review).toContainText('Delivery uncertain');
  await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
  await review.getByRole('button', { name: 'Continue after review' }).click();
  await expect(review).toHaveCount(0);
  expect(sends).toBe(1);
});

test('non-secure tabs compact settled records atomically and cannot revive an expired ID', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-http-owner' }));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  });
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  expect(await page.evaluate(() => ({ secure: isSecureContext, webLocks: Boolean(navigator.locks) }))).toEqual({ secure: false, webLocks: false });
  const sessionId = 'ss-compact-fixture', oldId = '018fdf56-2333-7abc-8abc-ffffffffffff';
  await page.evaluate(async ({ session, id }) => {
    const { supervisedInputScope } = await import('/src/utils/supervisedRawInputController.js');
    const scope = supervisedInputScope(session);
    for (let index = 0; index < 10_001; index += 1) {
      const requestId = `018fdf56-2333-7abc-8abc-${index.toString(16).padStart(12, '0')}`;
      scope.storage.setItem(`supervisedRawInput:v2:${session}:${requestId}`, JSON.stringify({ version: 2, sessionId: session, requestId, stage: 'settled' }));
    }
    await scope.store.reserve({ requestId: id, deliveryToken: 'fixture-token' });
    await scope.store.markSending(id);
    await scope.store.clear(id);
  }, { session: sessionId, id: oldId });
  const other = await context.newPage();
  await other.goto('/e2e/fixtures/supervised-insecure.html');
  await other.evaluate(() => import('/src/utils/supervisedRawInputController.js'));
  const compact = page.evaluate(async session => {
    const { supervisedInputScope } = await import('/src/utils/supervisedRawInputController.js');
    await supervisedInputScope(session).store.compactBefore(0x018fdf562334);
  }, sessionId);
  const stale = other.evaluate(async ({ session, id }) => {
    const { supervisedInputScope } = await import('/src/utils/supervisedRawInputController.js');
    try { await supervisedInputScope(session).store.markSending(id); return 'unexpected success'; }
    catch { return 'rejected'; }
  }, { session: sessionId, id: oldId });
  expect(await stale).toBe('rejected');
  await compact;
  const final = await other.evaluate(async ({ session, id }) => {
    const { supervisedInputScope } = await import('/src/utils/supervisedRawInputController.js');
    const store = supervisedInputScope(session).store;
    await store.compactBefore(0x018fdf562330);
    try { await store.reserve({ requestId: id, deliveryToken: 'stale' }); return { count: store.count(), accepted: true }; }
    catch { return { count: store.count(), accepted: false }; }
  }, { session: sessionId, id: oldId });
  expect(final).toEqual({ count: 0, accepted: false });
});

test('warns before closing while a raw-input batch is still awaiting issuance', async ({ page, context }) => {
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  const warned = await page.evaluate(async () => {
    const { supervisedInputQueue } = await import('/src/utils/supervisedRawInputQueue.js');
    const queue = supervisedInputQueue('ss-delayed-issuance', () => new Promise(() => {}));
    queue.enqueue('x');
    await new Promise(resolve => setTimeout(resolve, 100));
    const event = new Event('beforeunload', { cancelable: true });
    return { snapshot: queue.getSnapshot(), warned: !window.dispatchEvent(event) };
  });
  expect(warned).toMatchObject({ snapshot: { pending: 0, sending: true }, warned: true });
});

test('an older local session uses legacy input only when recovery has no pending receipt', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-http-owner' }));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  });
  let pending = false;
  const sessionId = 'ss-legacy-fixture', requestId = '018fdf56-2333-7abc-8abc-123456789abc';
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await context.route('**/api/structured/input-capabilities', route => route.fulfill({ json: { protocol: 1 } }));
  await context.route('**/api/structured/input-receipts', route => route.fulfill({ json: { receipts: pending ? [{ sessionId, requestId, status: 'uncertain' }] : [], nextCursor: null } }));
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  const send = () => page.evaluate(async id => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    try { return await sendRawInput(id, '\r', () => ({ accepted: true, legacy: true })); }
    catch (error) { return { error: (error as Error).message }; }
  }, sessionId);
  expect(await send()).toEqual({ accepted: true, legacy: true });
  pending = true;
  expect(await send()).toHaveProperty('error', expect.stringContaining('needs review'));
});

test('a paired older target uses legacy input without capability probes', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-http-owner' }));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  });
  const probes: string[] = [];
  await context.route('**/api/**', route => {
    probes.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 403, json: {} });
  });
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  await page.evaluate(async () => {
    const { setActiveEnvironment } = await import('/src/utils/remoteEnvironments.js');
    setActiveEnvironment({ id: 'old-paired-fixture', capabilities: { terminalInput: true, agentExecute: true } });
  });
  const result = await page.evaluate(async () => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    return sendRawInput('ss-paired', '\r', () => ({ accepted: true, legacy: true }));
  });
  expect(result).toEqual({ accepted: true, legacy: true });
  expect(probes.filter(path => path.includes('/environments/old-paired-fixture/'))).toEqual([]);
});

test('a fresh browser reviews server-retained input before disabled-server fallback', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-http-owner' }));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  });
  const sessionId = 'ss-restarted-fixture', requestId = '018fdf56-2333-7abc-8abc-123456789abc';
  let reviewed = false;
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await context.route('**/api/structured/input-capabilities', route => route.fulfill({ json: { protocol: 1, enabled: false } }));
  await context.route('**/api/structured/input-receipts', route => route.fulfill({ json: { receipts: reviewed ? [] : [{ sessionId, requestId, status: 'uncertain' }], nextCursor: null } }));
  await context.route(`**/api/structured/input-receipts/${sessionId}/${requestId}`, route => route.fulfill({ json: { sessionId, requestId, status: 'uncertain' } }));
  await context.route(`**/api/structured/input-receipts/${sessionId}/${requestId}/review`, route => { reviewed = true; return route.fulfill({ json: { sessionId, requestId, status: 'reviewed' } }); });
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.includes('supervisedRawInput:v2:')))).toBe(false);
  const outcome = await page.evaluate(async id => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    try { await sendRawInput(id, '\r', () => { throw new Error('unexpected legacy path'); }); return 'unexpected success'; }
    catch (error) { return (error as Error).message; }
  }, sessionId);
  expect(outcome).toContain('needs review');
  const review = page.getByRole('region', { name: 'Input delivery review' });
  await expect(review).toContainText('Delivery uncertain');
  await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
  await review.getByRole('button', { name: 'Continue after review' }).click();
  await expect(review).toHaveCount(0);
  const afterReview = await page.evaluate(async id => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    return sendRawInput(id, '\r', () => ({ accepted: true, legacy: true }));
  }, sessionId);
  expect(afterReview).toEqual({ accepted: true, legacy: true });
});

test('legacy keys stay ordered and batched with delayed network responses', async ({ page, context }) => {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', 'fixture-access');
    localStorage.setItem('terminal_refresh_token', 'fixture-refresh');
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-http-owner' }));
    localStorage.setItem('terminal_auth_session', 'fixture-session');
  });
  const sessionId = 'ss-delayed-legacy', batches: string[] = [];
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: {} }));
  await context.route(`**/api/structured/sessions/${sessionId}/input`, async route => {
    batches.push(route.request().postDataJSON().text);
    await new Promise(resolve => setTimeout(resolve, 150));
    return route.fulfill({ json: { status: 'accepted' } });
  });
  await context.route('**/api/structured/input-capabilities', async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/e2e/fixtures/supervised-insecure.html');
  await page.evaluate(async id => {
    const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
    const { supervisedInputQueue } = await import('/src/utils/supervisedRawInputQueue.js');
    const { apiFetch } = await import('/src/utils/api.js');
    const legacy = async (session, text) => {
      const result = await apiFetch(`/api/structured/sessions/${session}/input`, { method: 'POST', body: { text, fallbackToMessage: false } });
      return { accepted: result.ok };
    };
    const queue = supervisedInputQueue(id, text => sendRawInput(id, text, legacy, { requireLegacy: true }), 'legacy');
    queue.enqueue('a'); queue.enqueue('b'); queue.enqueue('c');
    (window as any).fixtureLegacyQueue = queue;
  }, sessionId);
  await expect.poll(() => batches).toEqual(['abc']);
  await page.evaluate(() => { (window as any).fixtureLegacyQueue.enqueue('d'); (window as any).fixtureLegacyQueue.enqueue('e'); });
  await expect(page.getByRole('status', { name: 'Pending terminal input' })).toContainText('2 characters waiting');
  await expect.poll(() => batches).toEqual(['abc', 'de']);
  await expect(page.getByRole('status', { name: 'Pending terminal input' })).toHaveCount(0);
  expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('abc') || value.includes('de')))).toBe(false);
});
