import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_DELEGATION_AUTO !== '1', 'Requires isolated fixture servers.');

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback port unavailable');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function request(base: string, route: string, token?: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + route, { method, headers: {
    Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}

async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stopped, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture server did not stop')), 15_000); })]);
  } catch (error) {
    child.kill('SIGKILL');
    await stopped;
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

function processStatus(pid: number): { state: string; command: string } | null {
  try {
    const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    return { state, command };
  } catch { return null; }
}

function findOwnedChild(parent: number, binary: string): { pid: number; command: string } | null {
  let pids: number[];
  try { pids = execFileSync('/usr/bin/pgrep', ['-P', String(parent)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number); }
  catch { return null; }
  for (const pid of pids) {
    const status = processStatus(pid);
    if (status && status.command.startsWith(binary) && status.command.includes('--tool-policy read-only-child')) {
      return { pid, command: status.command };
    }
  }
  return null;
}

for (const mode of ['auto', 'restart', 'crash'] as const) test(mode === 'crash'
  ? 'paired proxy preserves an interrupted child for review after a server crash'
  : mode === 'restart'
  ? 'paired proxy preserves a queued result across restart until explicit resume'
  : 'paired proxy delivers an approved investigation to the idle parent', async () => {
  test.setTimeout(120_000);
  const root = process.env.E2E_DELEGATION_ROOT || '';
  const binary = process.env.E2E_DELEGATION_BINARY || '';
  if (!root || !binary.startsWith(root + '/')) throw new Error('An isolated fixture root and its backend binary are required');
  const fixture = path.join(root, `proxy-${randomUUID()}`);
  const restart = mode === 'restart';
  const crash = mode === 'crash';
  const homeData = path.join(fixture, 'home');
  const remoteData = path.join(fixture, 'remote');
  const workspace = path.join(fixture, 'workspace');
  await Promise.all([mkdir(homeData, { recursive: true }), mkdir(remoteData, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(path.join(workspace, 'notes'), 'original');
  let childRequests = 0;
  let parentFollowups = 0;
  let canDelegate = false;
  let releaseChild!: () => void;
  const childReleased = new Promise<void>(resolve => { releaseChild = resolve; });
  const provider = createHttpServer((incoming, outgoing) => {
    let raw = '';
    incoming.on('data', chunk => { raw += chunk; });
    incoming.on('end', async () => {
      const body = JSON.parse(raw);
      const parent = (body.tools || []).some((tool: any) => tool.function?.name === 'delegate_task_background');
      const transcript = JSON.stringify(body.messages || []);
      const answer = (message: unknown, reason = 'stop') => ({ choices: [{ finish_reason: reason, message }] });
      let value;
      if (transcript.includes('Delegated task ')) {
        parentFollowups += 1;
        canDelegate = parent;
        value = answer({ role: 'assistant', content: 'Parent received the investigation.' });
      } else if (parent && (body.messages || []).some((message: any) => message.role === 'tool')) {
        value = answer({ role: 'assistant', content: 'Background investigation started.' });
      } else if (parent) {
        value = answer({ role: 'assistant', content: null, tool_calls: [{ id: 'delegate-fixture', type: 'function', function: { name: 'delegate_task_background', arguments: JSON.stringify({ prompt: 'Inspect notes.' }) } }] }, 'tool_calls');
      } else {
        childRequests += 1;
        if (restart || crash) await childReleased;
        value = answer({ role: 'assistant', content: 'Verified child answer.' });
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Provider port unavailable');
  const homePort = await freePort();
  const remotePort = await freePort();
  const homeBase = `http://127.0.0.1:${homePort}`;
  const remoteBase = `http://127.0.0.1:${remotePort}`;
  const dispatchDiagnostics: string[] = [];
  const start = (data: string, port: number) => {
    const child = spawn(binary, [], { env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOST: '127.0.0.1', PORT: String(port),
    XDG_CONFIG_HOME: root, TERMINAL_DATA_DIR: data, TERMINAL_USE_TMUX: 'false', TERMINAL_V4_LOCAL_TESTING: '1',
    JWT_SECRET: 'fixture-only-secret', VAULT_ENCRYPTION_KEY: 'fixture-vault-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`, NO_PROXY: '*',
    RUST_LOG: 'terminal_v4_api=debug',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        pending += String(chunk);
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) if (line.includes('Queue remains held after dispatch')) dispatchDiagnostics.push(line);
      });
    }
    return child;
  };
  let home: ChildProcess | undefined;
  let remote: ChildProcess | undefined;
  let ownedChild: { pid: number; command: string } | null = null;
  const ready = async (base: string, child: ChildProcess) => {
    await expect.poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture server exited during startup');
      try { return (await fetch(`${base}/api/auth/mode`)).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    home = start(homeData, homePort);
    remote = start(remoteData, remotePort);
    await Promise.all([ready(homeBase, home), ready(remoteBase, remote)]);
    const homeLogin = await request(homeBase, '/api/auth/local-testing', undefined, 'POST', { username: 'synthetic-home' });
    const remoteLogin = await request(remoteBase, '/api/auth/local-testing', undefined, 'POST', { username: 'synthetic-remote' });
    expect([homeLogin.status, remoteLogin.status]).toEqual([200, 200]);
    const homeToken = homeLogin.value.tokens.accessToken as string;
    const remoteToken = remoteLogin.value.tokens.accessToken as string;
    expect((await request(remoteBase, '/api/vault', remoteToken, 'POST', { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-fixture-key' })).status).toBe(200);
    const created = await request(remoteBase, '/api/structured/sessions', remoteToken, 'POST', { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title: 'Proxy fixture' });
    expect(created.status).toBe(201);
    const sessionId = created.value.id as string;
    const code = await request(remoteBase, '/api/environments/pairing-code', remoteToken, 'POST', { label: 'Synthetic paired client', profile: 'operator' });
    expect(code.status).toBe(200);
    const connected = await request(homeBase, '/api/environments/connect', homeToken, 'POST', { url: remoteBase, code: code.value.code, label: 'Synthetic remote' });
    expect(connected.status).toBe(200);
    const prefix = `/api/environments/${connected.value.id}/proxy`;
    const via = (route: string, method = 'GET', body?: unknown) => request(homeBase, prefix + route, homeToken, method, body);
    expect((await via(`/api/structured/sessions/${sessionId}/message`, 'POST', { requestId: randomUUID(), text: 'Investigate the fixture.' })).status).toBe(202);
    let approvalId = '';
    await expect.poll(async () => {
      const session = await via(`/api/structured/sessions/${sessionId}`);
      approvalId = session.value?.events?.find((event: any) => event.type === 'approval_required' && event.toolName === 'delegate_task_background')?.approvalId || '';
      return Boolean(approvalId);
    }, { timeout: 20_000 }).toBe(true);
    expect((await via(`/api/structured/sessions/${sessionId}/approve`, 'POST', { approvalId, approved: true })).status).toBe(200);
    if (crash) {
      await expect.poll(() => childRequests, { timeout: 20_000 }).toBe(1);
      await expect.poll(() => { ownedChild = findOwnedChild(remote!.pid!, binary); return ownedChild !== null; }, { timeout: 10_000 }).toBe(true);
      const child = ownedChild!;
      const stopped = new Promise<void>(resolve => remote!.once('exit', () => resolve()));
      remote!.kill('SIGKILL');
      await stopped;
      await expect.poll(() => {
        const status = processStatus(child.pid);
        return !status || status.state.startsWith('Z') || status.command !== child.command;
      }, { timeout: 10_000 }).toBe(true);
      ownedChild = null;
      releaseChild();
      remote = start(remoteData, remotePort);
      await ready(remoteBase, remote);
      const ownership = await request(remoteBase, '/api/structured/ownership', remoteToken);
      expect(ownership.value.state).toBe('unconfirmed');
      expect((await via(`/api/structured/sessions/${sessionId}`)).status).not.toBe(200);
      expect(parentFollowups).toBe(0);
      const reviewed = await fetch(`${remoteBase}/api/structured/ownership/reconcile`, {
        method: 'POST', headers: { Origin: remoteBase, Authorization: `Bearer ${remoteToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ epoch: ownership.value.epoch, operationId: randomUUID(), acknowledged: true }),
      });
      expect(reviewed.status).toBe(204);
      await expect.poll(async () => (await via(`/api/structured/sessions/${sessionId}`)).status, { timeout: 20_000 }).toBe(200);
      await expect.poll(async () => {
        const queue = await via(`/api/structured/sessions/${sessionId}/queue`);
        return [queue.value?.mode, queue.value?.holdReason, queue.value?.items?.length, queue.value?.items?.[0]?.text?.includes('interrupted')];
      }, { timeout: 20_000 }).toEqual(['held', 'restart', 1, true]);
      expect({ childRequests, parentFollowups }).toEqual({ childRequests: 1, parentFollowups: 0 });
      const queue = await via(`/api/structured/sessions/${sessionId}/queue`);
      expect((await via(`/api/structured/sessions/${sessionId}/queue`, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: queue.value.revision, operation: { kind: 'resume' },
      })).status).toBe(200);
    }
    if (restart) {
      await expect.poll(() => childRequests, { timeout: 20_000 }).toBe(1);
      await expect.poll(async () => (await via(`/api/structured/sessions/${sessionId}/queue`)).value.mode, { timeout: 20_000 }).toBe('running');
      const current = await via(`/api/structured/sessions/${sessionId}/queue`);
      expect((await via(`/api/structured/sessions/${sessionId}/queue`, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: current.value.revision, operation: { kind: 'pause' },
      })).status).toBe(200);
      releaseChild();
      await expect.poll(async () => (await via(`/api/structured/sessions/${sessionId}/queue`)).value.items.length, { timeout: 30_000 }).toBe(1);
      expect(parentFollowups).toBe(0);
      await stop(remote);
      remote = start(remoteData, remotePort);
      await ready(remoteBase, remote);
      const recovered = await via(`/api/structured/sessions/${sessionId}/queue`);
      expect(recovered.status).toBe(200);
      expect(recovered.value.mode).toBe('held');
      expect(['manual', 'restart']).toContain(recovered.value.holdReason);
      expect(recovered.value.items).toHaveLength(1);
      expect(recovered.value.items[0].text).toContain('Verified child answer.');
      expect(parentFollowups).toBe(0);
      expect((await via(`/api/structured/sessions/${sessionId}/queue`, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: recovered.value.revision, operation: { kind: 'resume' },
      })).status).toBe(200);
    }
    try {
      await expect.poll(async () => {
        const session = await via(`/api/structured/sessions/${sessionId}`);
        return session.value?.events?.some((event: any) => event.type === 'message_completed' && event.content === 'Parent received the investigation.');
      }, { timeout: 30_000 }).toBe(true);
    } catch (error) {
      const queue = await via(`/api/structured/sessions/${sessionId}/queue`);
      const session = await via(`/api/structured/sessions/${sessionId}`);
      const events = session.value?.events?.map((event: any) => ({ type: event.type, status: event.status, code: event.code, message: event.message }));
      throw new Error(`Paired parent did not resume: ${JSON.stringify({ queue: { mode: queue.value?.mode, holdReason: queue.value?.holdReason, items: queue.value?.items?.map((item: any) => item.state) }, events, childRequests, parentFollowups, dispatchDiagnostics })}`, { cause: error });
    }
    const session = await via(`/api/structured/sessions/${sessionId}`);
    const accepted = session.value.events.filter((event: any) => event.type === 'user_message_accepted');
    expect(accepted).toHaveLength(2);
    expect(JSON.stringify(accepted)).toContain(crash ? 'interrupted' : 'Verified child answer.');
    expect({ childRequests, parentFollowups, canDelegate }).toEqual({ childRequests: 1, parentFollowups: 1, canDelegate: true });
    expect(await readFile(path.join(workspace, 'notes'), 'utf8')).toBe('original');
  } finally {
    releaseChild();
    try { await stop(remote); } finally {
      try { await stop(home); } finally {
        if (ownedChild) {
          const status = processStatus(ownedChild.pid);
          if (status && !status.state.startsWith('Z') && status.command === ownedChild.command) {
            try { process.kill(ownedChild.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
          }
        }
        provider.closeAllConnections();
        await new Promise<void>(resolve => provider.close(() => resolve()));
      }
    }
  }
});
