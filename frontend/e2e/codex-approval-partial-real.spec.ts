import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_CODEX_APPROVAL_PARTIAL !== '1', 'Requires an isolated preview backend and synthetic Codex fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
test.describe.configure({ mode: 'serial' });
const backend = 'http://127.0.0.1:43891', root = process.env.E2E_FIXTURE_ROOT || '', binary = process.env.E2E_PREVIEW_BINARY || '';

async function startServer(data: string, scenario = 'partial'): Promise<ChildProcess> {
  const env = { ...process.env, HOME: root, TERMINAL_DATA_DIR: data, TERMINAL_V4_LOCAL_TESTING: '1', CODEX_BIN: `${root}/synthetic-codex-${scenario}`, CODEX_FIXTURE_LOG: `${root}/codex-requests`, JWT_SECRET: 'isolated-codex-approval-test-secret', HOST: '127.0.0.1', PORT: '43891' };
  const child = spawn(binary, [], { env, stdio: 'ignore' });
  try { await expect.poll(async () => { try { await fetch(`${backend}/api/auth/mode`); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true); }
  catch (error) { child.kill('SIGINT'); throw error; }
  return child;
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture server did not stop')), 15_000); });
  try { await Promise.race([exited, timeout]); } finally { clearTimeout(timer!); }
}

test.beforeAll(async () => {
  if (!root || !binary) throw new Error('The isolated fixture root and preview binary are required.');
  const source = await readFile('../rust/crates/api/src/structured/codex/fixture.py', 'utf8');
  const idNeedle = '"id": "native-approval", "method": "item/commandExecution/requestApproval"';
  const pauseNeedle = '            if text == "approval-pair":';
  if (!source.includes(idNeedle) || !source.includes(pauseNeedle)) throw new Error('Synthetic Codex fixture shape changed.');
  const fixture = source.replace(idNeedle, '"id": "native-" + "x" * 100000, "method": "item/commandExecution/requestApproval"')
    .replace(pauseNeedle, '            import time\n            time.sleep(120)\n' + pauseNeedle);
  await writeFile(`${root}/synthetic-codex-partial`, fixture, { mode: 0o700 });
  await writeFile(`${root}/synthetic-codex-normal`, source, { mode: 0o700 });
});

for (const width of [393, 1200]) {
  test(`real partial approval remains reviewable after restart at ${width}px`, async ({ page, context, browser }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 700 });
    const data = `${root}/data-${width}`, workspace = `${root}/workspace-${width}`;
    await mkdir(workspace, { recursive: true });
    let server = await startServer(data);
    let secondContext;
    try {
      const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
      expect(login.status).toBe(200);
      const identity = await login.json(), headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
      const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: workspace, provider: 'codex' }) });
      expect(created.status).toBe(201);
      const { id: sessionId } = await created.json();
      const auth = value => {
        localStorage.setItem('terminal_access_token', value.tokens.accessToken);
        localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
        localStorage.setItem('terminal_user', JSON.stringify(value.user));
        localStorage.setItem('terminal_auth_session', 'isolated-codex-approval');
      };
      await context.addInitScript(auth, identity);
      const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'approval', requestId: randomUUID() }) });
      expect(start.status).toBe(202);
      await page.goto(`/e2e/fixtures/uncertain-approval.html?session=${encodeURIComponent(sessionId)}`);
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeVisible();
      let approvalId = '';
      page.on('request', request => {
        if (request.url().endsWith('/approve') && request.method() === 'POST') approvalId = request.postDataJSON().approvalId;
      });
      const approvalResponse = page.waitForResponse(response => response.url().endsWith('/approve') && response.request().method() === 'POST');
      await approve.click();
      const card = page.getByRole('group', { name: 'Uncertain approval decision' });
      await expect(card).toContainText('The decision may have been delivered');
      await expect.poll(() => approvalId).not.toBe('');
      await expect.poll(async () => {
        const response = await fetch(`${backend}/api/structured/sessions/${sessionId}`, { headers });
        const snapshot = await response.json();
        return snapshot.events.filter(event => event.type === 'approval_decision_started' && event.approvalId === approvalId).length;
      }).toBe(1);
      const stopBeforeRestart = page.getByRole('button', { name: 'Stop response' });
      await expect(stopBeforeRestart).toBeVisible();
      await stopBeforeRestart.click();
      const partialResponse = await approvalResponse;
      expect(partialResponse.status()).toBe(409);
      expect((await partialResponse.json()).error).toMatch(/partial|uncertain/i);
      await stopServer(server);
      server = await startServer(data);
      secondContext = await browser.newContext({ viewport: { width, height: 700 } });
      await secondContext.addInitScript(auth, identity);
      const recovered = await secondContext.newPage();
      await recovered.goto(`/e2e/fixtures/uncertain-approval.html?session=${encodeURIComponent(sessionId)}`);
      const recoveredCard = recovered.getByRole('group', { name: 'Uncertain approval decision' });
      await expect(recoveredCard).toContainText('The decision may have been delivered');
      await expect(recovered.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
      const stop = recovered.getByRole('button', { name: 'Stop response' });
      if (await stop.isVisible().catch(() => false)) await stop.click();
      await recoveredCard.getByRole('checkbox', { name: /I inspected the action/ }).check();
      const review = recoveredCard.getByRole('button', { name: 'Acknowledge review' });
      await expect(review).toBeEnabled();
      await review.click();
      await expect(recoveredCard).toHaveCount(0);
      const snapshot = await (await fetch(`${backend}/api/structured/sessions/${sessionId}`, { headers })).json();
      expect(snapshot.events.filter(event => event.type === 'approval_decision_started' && event.approvalId === approvalId)).toHaveLength(1);
      expect(snapshot.events.filter(event => event.type === 'approval_decision_reviewed' && event.approvalId === approvalId)).toHaveLength(1);
      expect(snapshot.events.filter(event => event.type === 'approval_resolved' && event.approvalId === approvalId)).toHaveLength(0);
      const replay = await fetch(`${backend}/api/structured/sessions/${sessionId}/approve`, { method: 'POST', headers, body: JSON.stringify({ approvalId, approved: true }) });
      expect(replay.ok).toBe(false);
      expect(await recovered.evaluate(() => JSON.stringify(Object.values(localStorage)).includes('deliveryToken'))).toBe(false);
    } finally {
      await secondContext?.close();
      await stopServer(server);
    }
  });
}

test('lost reservation response survives reload and is reviewed without dispatch', async ({ page, context, browser }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 393, height: 700 });
  const data = `${root}/lost-data`, workspace = `${root}/lost-workspace`;
  await mkdir(workspace, { recursive: true });
  let server = await startServer(data, 'normal');
  let secondContext;
  try {
    const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
    expect(login.status).toBe(200);
    const identity = await login.json(), headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: workspace, provider: 'codex' }) });
    expect(created.status).toBe(201);
    const { id: sessionId } = await created.json();
    const auth = value => {
      localStorage.setItem('terminal_access_token', value.tokens.accessToken);
      localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
      localStorage.setItem('terminal_user', JSON.stringify(value.user));
      localStorage.setItem('terminal_auth_session', 'isolated-codex-approval');
    };
    await context.addInitScript(auth, identity);
    let dispatches = 0;
    page.on('request', request => { if (request.url().endsWith('/approve') && request.method() === 'POST') dispatches += 1; });
    await page.route('**/approval-claims/*/reserve', async route => {
      const url = new URL(route.request().url());
      const reserved = await route.fetch({ url: `${backend}${url.pathname}` });
      expect(reserved.status()).toBe(200);
      await route.abort('failed');
    });
    const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'approval', requestId: randomUUID() }) });
    expect(start.status).toBe(202);
    await page.goto(`/e2e/fixtures/uncertain-approval.html?session=${encodeURIComponent(sessionId)}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const card = page.getByRole('group', { name: 'Uncertain approval decision' });
    await expect(card).toContainText('The decision may have been delivered');
    await page.reload();
    await expect(card).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    expect(dispatches).toBe(0);
    const stop = page.getByRole('button', { name: 'Stop response' });
    await expect(stop).toBeVisible();
    await stop.click();
    await stopServer(server);
    server = await startServer(data, 'normal');
    secondContext = await browser.newContext({ viewport: { width: 393, height: 700 } });
    await secondContext.addInitScript(auth, identity);
    const recovered = await secondContext.newPage();
    await recovered.goto(`/e2e/fixtures/uncertain-approval.html?session=${encodeURIComponent(sessionId)}`);
    const recoveredCard = recovered.getByRole('group', { name: 'Uncertain approval decision' });
    await expect(recoveredCard).toBeVisible();
    await recoveredCard.getByRole('checkbox', { name: /I inspected the action/ }).check();
    await recoveredCard.getByRole('button', { name: 'Acknowledge review' }).click();
    await expect(recoveredCard).toHaveCount(0);
    const snapshot = await (await fetch(`${backend}/api/structured/sessions/${sessionId}`, { headers })).json();
    expect(snapshot.events.filter(event => event.type === 'approval_decision_reserved')).toHaveLength(1);
    expect(snapshot.events.filter(event => event.type === 'approval_decision_started')).toHaveLength(0);
    expect(snapshot.events.filter(event => event.type === 'approval_decision_reviewed')).toHaveLength(1);
    expect(dispatches).toBe(0);
  } finally {
    await secondContext?.close();
    await stopServer(server);
  }
});

for (const width of [393, 1200]) {
  test(`normal Codex approval completes through the real server at ${width}px`, async ({ page, context }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width, height: 700 });
    const data = `${root}/normal-data-${width}`, workspace = `${root}/normal-workspace-${width}`;
    await mkdir(workspace, { recursive: true });
    const server = await startServer(data, 'normal');
    try {
      const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
      expect(login.status).toBe(200);
      const identity = await login.json(), headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
      const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: workspace, provider: 'codex' }) });
      expect(created.status).toBe(201);
      const { id: sessionId } = await created.json();
      await context.addInitScript(value => {
        localStorage.setItem('terminal_access_token', value.tokens.accessToken);
        localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
        localStorage.setItem('terminal_user', JSON.stringify(value.user));
        localStorage.setItem('terminal_auth_session', 'isolated-codex-approval');
      }, identity);
      const start = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'approval', requestId: randomUUID() }) });
      expect(start.status).toBe(202);
      await page.goto(`/e2e/fixtures/uncertain-approval.html?session=${encodeURIComponent(sessionId)}`);
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeVisible();
      await approve.click();
      await expect(approve).toHaveCount(0);
      await expect.poll(async () => {
        const snapshot = await (await fetch(`${backend}/api/structured/sessions/${sessionId}`, { headers })).json();
        return snapshot.events.filter(event => event.type === 'approval_resolved' && event.approved === true).length;
      }).toBe(1);
      await expect(page.getByRole('group', { name: 'Uncertain approval decision' })).toHaveCount(0);
    } finally { await stopServer(server); }
  });
}
