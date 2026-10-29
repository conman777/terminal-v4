import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_RECOVERY_RESTART !== '1', 'Requires an isolated preview binary and synthetic data directory.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER, args: ['--host-resolver-rules=MAP raw-fixture.test 127.0.0.1', '--no-proxy-server'] }, viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: 'serial' });
const backend = 'http://127.0.0.1:43891';
const root = process.env.E2E_FIXTURE_ROOT || '';
const binary = process.env.E2E_PREVIEW_BINARY || '';

async function startServer(data: string, enabled: boolean): Promise<ChildProcess> {
  const env = { ...process.env, HOME: root, TERMINAL_DATA_DIR: data, TERMINAL_V4_LOCAL_TESTING: '1', CLAUDE_BIN: `${root}/synthetic-claude`, V4_SYNTHETIC_HOLD: enabled ? '1' : '0', JWT_SECRET: 'isolated-supervised-input-test-secret', HOST: '127.0.0.1', PORT: '43891' };
  if (enabled) env.TERMINAL_V4_SUPERVISED_INPUT_FIXTURE = '1';
  else delete env.TERMINAL_V4_SUPERVISED_INPUT_FIXTURE;
  const child = spawn(binary, [], { env, stdio: 'ignore' });
  try {
    await expect.poll(async () => { try { await fetch(`${backend}/api/auth/mode`); return true; } catch { return false; } }, { timeout: 15_000 }).toBe(true);
  } catch (error) {
    child.kill('SIGINT');
    throw error;
  }
  return child;
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture server did not stop')), 10_000); });
  try { await Promise.race([exited, timeout]); } finally { clearTimeout(timer!); }
}

async function sessionFixture(data: string) {
  const workspace = `${data}/workspace`;
  await mkdir(workspace, { recursive: true });
  const login = await fetch(`${backend}/api/auth/local-testing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `fixture-${randomUUID().slice(0, 18)}` }) });
  expect(login.status).toBe(200);
  const identity = await login.json();
  const headers = { Authorization: `Bearer ${identity.tokens.accessToken}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${backend}/api/structured/sessions`, { method: 'POST', headers, body: JSON.stringify({ cwd: workspace, provider: 'claude' }) });
  expect(created.status).toBe(201);
  return { identity, headers, workspace, sessionId: (await created.json()).id };
}

async function startAgent(sessionId: string, headers: Record<string, string>) {
  const result = await fetch(`${backend}/api/structured/sessions/${sessionId}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'start synthetic agent' }) });
  expect(result.status).toBe(202);
}

test.beforeAll(async () => {
  if (!root || !binary) throw new Error('The isolated fixture root and preview binary are required.');
  await writeFile(`${root}/synthetic-claude`, '#!/bin/sh\nif [ "$V4_SYNTHETIC_HOLD" = 1 ]; then exec /bin/sleep 30; fi\nexec /bin/cat > "$PWD/captured-input"\n', { mode: 0o700 });
});

test('fresh browser can review an installed-disabled server receipt after restart', async ({ page, context }) => {
  test.setTimeout(60_000);
  let server = await startServer(`${root}/installed-data`, true);
  let fixture;
  try {
    fixture = await sessionFixture(`${root}/installed-data`);
    await startAgent(fixture.sessionId, fixture.headers);
    let issued: Response | undefined;
    await expect.poll(async () => {
      issued = await fetch(`${backend}/api/structured/sessions/${fixture.sessionId}/input-operation`, { method: 'POST', headers: fixture.headers });
      return issued.status;
    }, { timeout: 10_000 }).toBe(200);
    const { requestId, deliveryToken } = await issued!.json();
    const uncertain = await fetch(`${backend}/api/structured/sessions/${fixture.sessionId}/supervised-input`, { method: 'POST', headers: fixture.headers, body: JSON.stringify({ text: 'x'.repeat(100_000), fallbackToMessage: false, requestId, deliveryToken }) });
    expect(uncertain.status).toBe(409);
    expect(await uncertain.json()).toMatchObject({ outcome: 'uncertain', requestId });
    await stopServer(server);
    server = await startServer(`${root}/installed-data`, false);
    await startAgent(fixture.sessionId, fixture.headers);
    const cap = await fetch(`${backend}/api/structured/input-capabilities`, { headers: fixture.headers });
    expect(await cap.json()).toEqual({ protocol: 1, enabled: false });
    const blocked = await fetch(`${backend}/api/structured/sessions/${fixture.sessionId}/input`, { method: 'POST', headers: fixture.headers, body: JSON.stringify({ text: 'x', fallbackToMessage: false }) });
    expect(blocked.status).toBe(409);
    await context.addInitScript(value => {
      localStorage.setItem('terminal_access_token', value.tokens.accessToken);
      localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
      localStorage.setItem('terminal_user', JSON.stringify(value.user));
      localStorage.setItem('terminal_auth_session', 'isolated-browser-fixture');
    }, fixture.identity);
    await page.goto('/e2e/fixtures/supervised-insecure.html');
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.includes('supervisedRawInput:v2:')))).toBe(false);
    const blockedFrontend = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      try { await sendRawInput(id, 'x', () => { throw new Error('unexpected legacy send'); }); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    }, fixture.sessionId);
    expect(blockedFrontend).toContain('needs review');
    const review = page.getByRole('region', { name: 'Input delivery review' });
    await expect(review).toContainText('Delivery uncertain');
    await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
    await review.getByRole('button', { name: 'Continue after review' }).click();
    await expect(review).toHaveCount(0);
    const receipt = await fetch(`${backend}/api/structured/input-receipts/${fixture.sessionId}/${requestId}`, { headers: fixture.headers });
    expect(await receipt.json()).toMatchObject({ status: 'reviewed', requestId });
    const sent = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      const { apiFetch } = await import('/src/utils/api.js');
      const legacy = async (session, text) => {
        const response = await apiFetch(`/api/structured/sessions/${session}/input`, { method: 'POST', body: { text, fallbackToMessage: false } });
        if (!response.ok) throw new Error(`Legacy input failed: ${response.status}`);
        return { accepted: true };
      };
      return [await sendRawInput(id, 'x', legacy), await sendRawInput(id, '\x1b[A', legacy)];
    }, fixture.sessionId);
    expect(sent).toEqual([{ accepted: true }, { accepted: true }]);
    await expect.poll(async () => readFile(`${fixture.workspace}/captured-input`, 'utf8').catch(() => '')).toBe('x\x1b[A');
  } finally { await stopServer(server); }
});

test('uninstalled server accepts actual frontend legacy letters and escape sequences', async ({ page, context }) => {
  test.setTimeout(45_000);
  const server = await startServer(`${root}/uninstalled-data`, false);
  try {
    const fixture = await sessionFixture(`${root}/uninstalled-data`);
    await startAgent(fixture.sessionId, fixture.headers);
    expect((await fetch(`${backend}/api/structured/input-capabilities`, { headers: fixture.headers })).status).toBe(404);
    await context.addInitScript(value => {
      localStorage.setItem('terminal_access_token', value.tokens.accessToken);
      localStorage.setItem('terminal_refresh_token', value.tokens.refreshToken);
      localStorage.setItem('terminal_user', JSON.stringify(value.user));
      localStorage.setItem('terminal_auth_session', 'isolated-browser-fixture');
    }, fixture.identity);
    await page.goto('/e2e/fixtures/supervised-insecure.html');
    const sent = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      const { apiFetch } = await import('/src/utils/api.js');
      const legacy = async (session, text) => {
        const response = await apiFetch(`/api/structured/sessions/${session}/input`, { method: 'POST', body: { text, fallbackToMessage: false } });
        if (!response.ok) throw new Error(`Legacy input failed: ${response.status}`);
        return { accepted: true };
      };
      return [await sendRawInput(id, 'x', legacy), await sendRawInput(id, '\x1b[A', legacy)];
    }, fixture.sessionId);
    expect(sent).toEqual([{ accepted: true }, { accepted: true }]);
    await expect.poll(async () => readFile(`${fixture.workspace}/captured-input`, 'utf8').catch(() => '')).toBe('x\x1b[A');
  } finally { await stopServer(server); }
});
