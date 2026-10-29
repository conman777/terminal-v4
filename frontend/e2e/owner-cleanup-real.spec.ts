import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_OWNER_CLEANUP_REAL !== '1', 'Requires a dedicated loopback runtime and synthetic provider.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
test.describe.configure({ mode: 'serial' });
const backend = 'http://127.0.0.1:43891';
const root = process.env.E2E_FIXTURE_ROOT || '';
const binary = process.env.E2E_PREVIEW_BINARY || '';

async function stopServer(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill(signal);
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([stopped, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture API did not stop')), 10_000); })]); }
  catch (error) { child.kill('SIGKILL'); await stopped; throw error; }
  finally { clearTimeout(timer!); }
}

async function startServer(data: string, provider: number, localTesting = true) {
  const probe = createSocketServer();
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(43891, '127.0.0.1', resolve));
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const env = { PATH: `${root}/bin`, HOME: root, TERMINAL_USE_TMUX: 'false', TERMINAL_DATA_DIR: data, JWT_SECRET: 'fixture-owner-cleanup-only-secret', VAULT_ENCRYPTION_KEY: 'fixture-owner-cleanup-only-vault', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider}/v1`, HOST: '127.0.0.1', PORT: '43891', ...(localTesting ? { TERMINAL_V4_LOCAL_TESTING: '1' } : {}) };
  const child = spawn(binary, [], { env, stdio: 'ignore' });
  try { await expect.poll(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture API exited during startup'); try { const response = await fetch(`${backend}/api/auth/mode`); return response.ok && (await response.json()).mode === (localTesting ? 'local-testing' : 'password'); } catch { return false; } }, { timeout: 20_000 }).toBe(true); }
  catch (error) { await stopServer(child, 'SIGKILL'); throw error; }
  return child;
}

test.beforeAll(async () => {
  if (!root || !binary || !binary.startsWith(root + '/')) throw new Error('A fixture-owned root and binary are required.');
  await mkdir(`${root}/bin`, { recursive: true });
  await symlink('/bin/sleep', `${root}/bin/sleep`).catch((error: any) => { if (error.code !== 'EEXIST') throw error; });
});

function ownedChildPid(parent: number): number | null {
  const lines = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match && Number(match[2]) === parent && match[3].includes(binary) && match[3].includes('read-only-child')) return Number(match[1]);
  }
  return null;
}

function descendants(parent: number): number[] {
  const pairs = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found: number[] = [], pending = [parent];
  while (pending.length) {
    const next = pending.pop();
    for (const [pid, ppid] of pairs) if (ppid === next) { found.push(pid); pending.push(pid); }
  }
  return found;
}

async function verifyStopped(pid: number) {
  await expect.poll(() => {
    try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z'); }
    catch { return true; }
  }, { timeout: 10_000 }).toBe(true);
}

function processCommand(pid: number): string | null {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function stopFixtureProcess(pid: number, command: string) {
  try { if (execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z')) return; }
  catch { return; }
  const current = processCommand(pid);
  if (current === null) return;
  if (current !== command) throw new Error('Fixture process identity changed; refusing to signal it');
  try { process.kill(pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
}

for (const width of [393, 1200]) {
  test(`review an interrupted delegated child after real logout at ${width}px`, async ({ page, request }) => {
    test.setTimeout(90_000);
    if (!root || !binary || !binary.startsWith(root + '/')) throw new Error('A fixture-owned root and binary are required.');
    expect(new URL(String(test.info().project.use.baseURL)).origin).toBe('http://127.0.0.1:43892');
    const data = `${root}/data-${width}`, workspace = `${root}/workspace-${width}`;
    await mkdir(workspace, { recursive: true });
    await writeFile(`${workspace}/notes`, 'synthetic');
    let childRequest = false;
    const provider: Server = createServer((incoming, outgoing) => {
      if (incoming.method !== 'POST') { outgoing.writeHead(404); outgoing.end(); return; }
      let raw = '';
      incoming.on('data', chunk => { raw += chunk; });
      incoming.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { outgoing.writeHead(400); outgoing.end(); return; }
        const parent = (body.tools || []).some((tool: any) => tool.function?.name === 'delegate_task_background');
        if (!parent) { childRequest = true; return; }
        const hasResult = (body.messages || []).some((message: any) => message.role === 'tool');
        const message = hasResult ? { role: 'assistant', content: 'Synthetic investigation started.' } : { role: 'assistant', content: null, tool_calls: [{ id: 'delegate-fixture', type: 'function', function: { name: 'delegate_task_background', arguments: JSON.stringify({ prompt: 'Inspect the synthetic notes.' }) } }] };
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ choices: [{ finish_reason: hasResult ? 'stop' : 'tool_calls', message }] }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const port = (provider.address() as { port: number }).port;
    let server: ChildProcess | undefined, ownedPid: number | null = null, ownedCommand: string | null = null;
    const username = `cleanup-${randomUUID().slice(0, 12)}`;
    try {
      server = await startServer(data, port);
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(username);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await page.waitForFunction(() => Boolean(localStorage.getItem('terminal_access_token')));
      const token = await page.evaluate(() => localStorage.getItem('terminal_access_token'));
      const headers = { Authorization: `Bearer ${token}` };
      expect((await request.put('/api/agent/auth/deepseek/api-key', { headers, data: { apiKey: 'fixture-key' } })).ok()).toBe(true);
      expect((await request.patch('/api/settings', { headers, data: { recentFolders: [workspace], sidebarProjects: [{ path: workspace, name: 'Fixture project' }] } })).ok()).toBe(true);
      const created = await request.post('/api/structured/sessions', { headers, data: { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title: 'Cleanup fixture' } });
      expect(created.status()).toBe(201);
      await page.reload();
      await page.getByText('Cleanup fixture', { exact: true }).first().click();
      await page.getByRole('textbox', { name: 'Command composer', exact: true }).fill('Investigate synthetic notes.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('group', { name: 'Approval required' }).getByRole('button', { name: 'Approve', exact: true }).click();
      await expect.poll(() => childRequest, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => { ownedPid = ownedChildPid(server!.pid!); return ownedPid !== null; }).toBe(true);
      ownedCommand = processCommand(ownedPid!);
      if (!ownedCommand?.includes(binary) || !ownedCommand.includes('read-only-child')) throw new Error('Fixture child identity unavailable');
      await stopServer(server, 'SIGKILL');
      if (ownedPid && ownedCommand) stopFixtureProcess(ownedPid, ownedCommand);
      await verifyStopped(ownedPid!);
      ownedPid = null; ownedCommand = null;
      server = await startServer(data, port);
      await page.reload();
      await page.getByLabel('More options', { exact: true }).click();
      const logout = page.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
      await page.getByRole('button', { name: 'Logout' }).click();
      const logoutResult = await logout;
      expect(logoutResult.status()).toBe(202);
      expect(await logoutResult.json()).toMatchObject({ success: true, cleanup: { state: 'pending' } });
      const otherLogin = await request.post('/api/auth/local-testing', { data: { username: `other-${randomUUID().slice(0, 12)}` } });
      expect(otherLogin.status()).toBe(200);
      const otherToken = (await otherLogin.json()).tokens.accessToken;
      const otherStatus = await request.get('/api/structured/owner-cleanup', { headers: { Authorization: `Bearer ${otherToken}` } });
      expect(await otherStatus.json()).toMatchObject({ state: 'complete', requestId: null });
      await page.setViewportSize({ width, height: 800 });
      await page.getByLabel('Username', { exact: true }).fill(username);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Sign-out cleanup' });
      await expect.poll(async () => {
        if (await panel.getByText(/Process identities are not saved/).count()) return true;
        const retry = panel.getByRole('button', { name: 'Retry cleanup' });
        if (await retry.isVisible().catch(() => false) && await retry.isEnabled()) await retry.click();
        return false;
      }, { timeout: 20_000 }).toBe(true);
      await expect(panel).toContainText(workspace);
      await panel.getByRole('checkbox', { name: /personally checked and stopped all associated processes/i }).check();
      let operationId = '', delivered = 0;
      await page.route('**/api/structured/owner-cleanup/delegation-review', async route => {
        operationId = route.request().postDataJSON().operationId;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        delivered += 1;
        await route.abort();
      });
      await panel.getByRole('button', { name: 'Confirm delegated child review' }).click();
      await expect(panel.getByRole('alert')).toContainText('could not be confirmed');
      await panel.getByRole('button', { name: 'Check review status' }).click();
      await expect(panel).toContainText('server did not verify', { timeout: 20_000 });
      const reviewedToken = await page.evaluate(() => localStorage.getItem('terminal_access_token'));
      const receipt = await request.get(`/api/structured/owner-cleanup/delegation-review/${operationId}`, { headers: { Authorization: `Bearer ${reviewedToken}` } });
      expect(await receipt.json()).toMatchObject({ operationId, status: 'reviewed' });
      expect(delivered).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      try { if (server) await stopServer(server, 'SIGINT'); }
      finally {
        try { if (ownedPid && ownedCommand) stopFixtureProcess(ownedPid, ownedCommand); }
        finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
      }
    }
  });
}

for (const width of [393, 1200]) {
  test(`review a crashed background process after real logout at ${width}px`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const testBinary = process.env.E2E_TEST_BINARY || '';
    if (!testBinary.startsWith(root + '/')) throw new Error('A fixture-owned Rust test binary is required.');
    expect(new URL(String(test.info().project.use.baseURL)).origin).toBe('http://127.0.0.1:43892');
    const data = `${root}/background-${width}`;
    await mkdir(data, { recursive: true });
    let server: ChildProcess | undefined, helper: ChildProcess | undefined, pids: { pid: number, command: string }[] = [];
    try {
      server = await startServer(data, 1, false);
      await stopServer(server, 'SIGINT');
      const hash = execFileSync('/usr/sbin/htpasswd', ['-nbBC', '10', 'fixtureowner', 'fixture-only-password'], { encoding: 'utf8' }).trim().split(':').slice(1).join(':');
      execFileSync('/usr/bin/python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)",("owner","fixtureowner",sys.argv[2],"2026-01-01","2026-01-01")); db.commit()', `${data}/terminal.db`, hash]);
      helper = spawn(testBinary, ['--exact', 'v4_agent::background_quiescence::tests::remote_manager_fixture', '--ignored'], { env: { PATH: `${root}/bin`, HOME: root, V4_BACKGROUND_QUIESCENCE_ROOT: data }, stdio: 'ignore' });
      await expect.poll(async () => { try { await access(`${data}/remote-started`); return true; } catch { return false; } }, { timeout: 10_000 }).toBe(true);
      await expect.poll(() => descendants(helper!.pid!).some(pid => /(?:^|\/)sleep 60$/.test(processCommand(pid) || '')), { timeout: 5_000 }).toBe(true);
      pids = descendants(helper.pid!).map(pid => ({ pid, command: processCommand(pid) || '' }));
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.every(process => process.command.length > 0)).toBe(true);
      await stopServer(helper, 'SIGKILL');
      for (const process of pids.reverse()) stopFixtureProcess(process.pid, process.command);
      for (const process of pids) await verifyStopped(process.pid);
      pids = [];
      server = await startServer(data, 1, false);
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill('fixtureowner');
      await page.getByLabel('Password', { exact: true }).fill('fixture-only-password');
      await page.getByRole('button', { name: 'Initialize Session' }).click();
      await page.waitForFunction(() => Boolean(localStorage.getItem('terminal_access_token')));
      await page.getByLabel('More options', { exact: true }).click();
      const logout = page.waitForResponse(response => response.url().endsWith('/api/auth/logout'));
      await page.getByRole('button', { name: 'Logout' }).click();
      expect((await logout).status()).toBe(202);
      await page.setViewportSize({ width, height: 800 });
      await page.getByLabel('Username', { exact: true }).fill('fixtureowner');
      await page.getByLabel('Password', { exact: true }).fill('fixture-only-password');
      await page.getByRole('button', { name: 'Initialize Session' }).click();
      const panel = page.getByRole('region', { name: 'Sign-out cleanup' });
      await expect.poll(async () => {
        if (await panel.getByText(/Individual processes cannot be identified/).count()) return true;
        const retry = panel.getByRole('button', { name: 'Retry cleanup' });
        if (await retry.isVisible().catch(() => false) && await retry.isEnabled()) await retry.click();
        return false;
      }, { timeout: 20_000 }).toBe(true);
      await panel.getByRole('checkbox', { name: /all associated background processes have stopped/i }).check();
      const review = page.waitForResponse(response => response.url().endsWith('/background-review') && response.request().method() === 'POST');
      await panel.getByRole('button', { name: 'Confirm background review' }).click();
      const result = await review;
      expect(result.status()).toBe(200);
      expect(await result.json()).toMatchObject({ status: 'reviewed', reviewedCount: 1 });
      const token = await page.evaluate(() => localStorage.getItem('terminal_access_token'));
      await expect.poll(async () => (await (await request.get('/api/structured/owner-cleanup', { headers: { Authorization: `Bearer ${token}` } })).json()).state, { timeout: 20_000 }).toBe('complete');
      await expect(panel).toContainText('server did not verify');
    } finally {
      try { if (helper) await stopServer(helper, 'SIGKILL'); }
      finally { try { for (const process of pids) if (process.command) stopFixtureProcess(process.pid, process.command); }
        finally { if (server) await stopServer(server, 'SIGINT'); } }
    }
  });
}
