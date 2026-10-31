import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_DELEGATION_AUTO !== '1', 'Requires an isolated preview backend.');

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
    Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, value: await response.json() };
}

for (const mode of ['auto', 'held', 'revoked', 'legacy', 'paired-auto', 'paired-held', 'paired-revoked'] as const) test(mode === 'paired-revoked'
  ? 'a revoked paired grant holds a result before parent dispatch'
  : mode === 'paired-auto'
  ? 'a paired investigation wakes its parent once while the grant remains valid'
  : mode === 'paired-held' ? 'a manual hold prevents a paired investigation from waking its parent'
  : mode === 'auto'
  ? 'an approved read-only investigation wakes its parent once with local authority'
  : mode === 'held' ? 'a manual queue hold prevents an approved investigation from waking its parent'
    : mode === 'revoked' ? 'a logged-out credential requires local review before a retained result can run'
      : 'an unproven legacy queue item retains its existing dispatch behavior', async () => {
  test.setTimeout(90_000);
  const root = process.env.E2E_DELEGATION_ROOT || '';
  const paired = mode === 'paired-auto' || mode === 'paired-held' || mode === 'paired-revoked';
  const held = mode === 'held' || mode === 'revoked' || mode === 'paired-held' || mode === 'paired-revoked';
  const binary = process.env.E2E_DELEGATION_BINARY || '';
  if (!root || !binary.startsWith(root + '/')) throw new Error('An isolated fixture root and its backend binary are required');
  const fixture = path.join(root, `case-${randomUUID()}`);
  const data = path.join(fixture, 'data');
  const workspace = path.join(fixture, 'workspace');
  await mkdir(data, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'notes'), 'original');
  let childRequests = 0;
  let parentFollowups = 0;
  let legacyFollowups = 0;
  let followupCanDelegate = false;
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
      if (transcript.includes('Legacy queued prompt')) {
        legacyFollowups += 1;
        value = answer({ role: 'assistant', content: 'Legacy queue completed.' });
      } else if (transcript.includes('Delegated task ')) {
        parentFollowups += 1;
        followupCanDelegate = parent;
        value = answer({ role: 'assistant', content: 'Parent received the investigation.' });
      } else if (parent && (body.messages || []).some((message: any) => message.role === 'tool')) {
        value = answer({ role: 'assistant', content: 'Background investigation started.' });
      } else if (parent) {
        value = answer({ role: 'assistant', content: null, tool_calls: [{ id: 'delegate-fixture', type: 'function', function: { name: 'delegate_task_background', arguments: JSON.stringify({ prompt: 'Inspect notes.' }) } }] }, 'tool_calls');
      } else {
        childRequests += 1;
        if (held) await childReleased;
        value = answer({ role: 'assistant', content: 'Verified child answer.' });
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider port unavailable');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let api: ChildProcess | undefined;
  try {
    api = spawn(binary, [], { env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOST: '127.0.0.1', PORT: String(port),
      XDG_CONFIG_HOME: root, TERMINAL_DATA_DIR: data, TERMINAL_USE_TMUX: 'false', TERMINAL_V4_LOCAL_TESTING: '1',
      JWT_SECRET: 'fixture-only-secret', VAULT_ENCRYPTION_KEY: 'fixture-vault-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`, NO_PROXY: '*',
    }, stdio: 'ignore' });
    await expect.poll(async () => {
      if (api?.exitCode !== null || api?.signalCode !== null) throw new Error('Fixture API exited during startup');
      try { return (await fetch(`${base}/api/auth/mode`)).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const login = await request(base, '/api/auth/local-testing', undefined, 'POST', { username: 'delegation-fixture' });
    expect(login.status).toBe(200);
    let token = login.value.tokens.accessToken as string;
    expect((await request(base, '/api/vault', token, 'POST', { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-fixture-key' })).status).toBe(200);
    const created = await request(base, '/api/structured/sessions', token, 'POST', { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title: 'Delegation fixture' });
    expect(created.status).toBe(201);
    const id = created.value.id as string;
    let inputToken = token;
    let pairedGrantId = '';
    if (paired) {
      const code = await request(base, '/api/environments/pairing-code', token, 'POST', { label: 'Synthetic paired client', profile: 'operator' });
      expect(code.status).toBe(200);
      const exchange = await request(base, '/api/environments/exchange', undefined, 'POST', { code: code.value.code });
      expect(exchange.status).toBe(200);
      inputToken = exchange.value.credential as string;
      pairedGrantId = exchange.value.grantId as string;
    }
    if (mode === 'legacy') {
      const enqueued = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: 0,
        operation: { kind: 'enqueue', itemId: randomUUID(), text: 'Legacy queued prompt', runWhenIdle: false },
      });
      expect(enqueued.status).toBe(200);
      const heldQueue = await request(base, `/api/structured/sessions/${id}/queue`, token);
      const item = heldQueue.value.items[0];
      const edit = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: heldQueue.value.revision,
        operation: { kind: 'edit', itemId: item.itemId, expectedItemRevision: item.revision, text: 'Legacy queued prompt, edited' },
      });
      expect(edit.status).toBe(200);
      await expect(access(path.join(data, 'queue-authority.key'))).rejects.toThrow();
      const edited = await request(base, `/api/structured/sessions/${id}/queue`, token);
      const resume = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: edited.value.revision, operation: { kind: 'resume' },
      });
      expect(resume.status).toBe(200);
      await expect.poll(async () => {
        const session = await request(base, `/api/structured/sessions/${id}`, token);
        return session.value?.events?.some((event: any) => event.type === 'message_completed' && event.content === 'Legacy queue completed.');
      }, { timeout: 20_000 }).toBe(true);
      await expect(access(path.join(data, 'queue-authority.key'))).rejects.toThrow();
      expect({ legacyFollowups, childRequests, parentFollowups }).toEqual({ legacyFollowups: 1, childRequests: 0, parentFollowups: 0 });
      expect(await readFile(path.join(workspace, 'notes'), 'utf8')).toBe('original');
      return;
    }
    expect((await request(base, `/api/structured/sessions/${id}/message`, inputToken, 'POST', { requestId: randomUUID(), text: 'Investigate the fixture.' })).status).toBe(202);
    let approvalId = '';
    await expect.poll(async () => {
      const session = await request(base, `/api/structured/sessions/${id}`, token);
      approvalId = session.value?.events?.find((event: any) => event.type === 'approval_required' && event.toolName === 'delegate_task_background')?.approvalId || '';
      return Boolean(approvalId);
    }, { timeout: 20_000 }).toBe(true);
    expect((await request(base, `/api/structured/sessions/${id}/approve`, inputToken, 'POST', { approvalId, approved: true })).status).toBe(200);
    if (held) {
      await expect.poll(() => childRequests, { timeout: 20_000 }).toBe(1);
      await expect.poll(async () => (await request(base, `/api/structured/sessions/${id}/queue`, token)).value.mode, { timeout: 20_000 }).toBe('running');
      const before = await request(base, `/api/structured/sessions/${id}/queue`, token);
      const pause = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
        operationId: randomUUID(), expectedQueueRevision: before.value.revision, operation: { kind: 'pause' },
      });
      expect(pause.status).toBe(200);
      releaseChild();
      await expect.poll(async () => (await request(base, `/api/structured/sessions/${id}/queue`, token)).value.items.length, { timeout: 30_000 }).toBe(1);
      const retained = await request(base, `/api/structured/sessions/${id}/queue`, token);
      expect([retained.value.mode, retained.value.holdReason]).toEqual(['held', 'manual']);
      expect(retained.value.items[0].text).toContain('Verified child answer.');
      if (mode === 'paired-revoked') {
        const revoked = await fetch(`${base}/api/environments/grants/${pairedGrantId}`, { method: 'DELETE', headers: { Origin: base, Authorization: `Bearer ${token}` } });
        expect(revoked.status).toBe(204);
        const resume = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
          operationId: randomUUID(), expectedQueueRevision: retained.value.revision, operation: { kind: 'resume' },
        });
        expect(resume.status).toBe(200);
        await expect.poll(async () => {
          const queue = await request(base, `/api/structured/sessions/${id}/queue`, token);
          return [queue.value.mode, queue.value.holdReason, queue.value.items[0]?.state];
        }, { timeout: 15_000 }).toEqual(['held', 'dispatch_error', 'pending']);
        expect(parentFollowups).toBe(0);
      }
      if (mode === 'revoked') {
        const logout = await request(base, '/api/auth/logout', token, 'POST', {});
        expect([200, 202]).toContain(logout.status);
        const relogin = await request(base, '/api/auth/local-testing', undefined, 'POST', { username: 'delegation-fixture' });
        expect(relogin.status).toBe(200);
        token = relogin.value.tokens.accessToken as string;
        await expect.poll(async () => {
          const status = await request(base, '/api/structured/owner-cleanup', token);
          return status.value?.state;
        }, { timeout: 20_000 }).toBe('complete');
        const current = await request(base, `/api/structured/sessions/${id}/queue`, token);
        const resume = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
          operationId: randomUUID(), expectedQueueRevision: current.value.revision, operation: { kind: 'resume' },
        });
        expect(resume.status).toBe(200);
        await expect.poll(async () => {
          const queue = await request(base, `/api/structured/sessions/${id}/queue`, token);
          return [queue.value.mode, queue.value.holdReason, queue.value.items[0]?.state];
        }, { timeout: 15_000 }).toEqual(['held', 'dispatch_error', 'pending']);
        expect(parentFollowups).toBe(0);
        const review = await request(base, `/api/structured/sessions/${id}/queue`, token);
        const item = review.value.items[0];
        const edit = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
          operationId: randomUUID(), expectedQueueRevision: review.value.revision,
          operation: { kind: 'edit', itemId: item.itemId, expectedItemRevision: item.revision, text: item.text },
        });
        expect(edit.status).toBe(200);
        const edited = await request(base, `/api/structured/sessions/${id}/queue`, token);
        const resumeReviewed = await request(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
          operationId: randomUUID(), expectedQueueRevision: edited.value.revision, operation: { kind: 'resume' },
        });
        expect(resumeReviewed.status).toBe(200);
        await expect.poll(async () => {
          const session = await request(base, `/api/structured/sessions/${id}`, token);
          return session.value?.events?.some((event: any) => event.type === 'message_completed' && event.content === 'Parent received the investigation.');
        }, { timeout: 20_000 }).toBe(true);
      }
    } else {
      await expect.poll(async () => (await request(base, `/api/structured/sessions/${id}/queue`, token)).value.mode, { timeout: 5_000 }).toBe('running');
      try {
        await expect.poll(async () => {
          const session = await request(base, `/api/structured/sessions/${id}`, token);
          return session.value?.events?.some((event: any) => event.type === 'message_completed' && event.content === 'Parent received the investigation.');
        }, { timeout: 30_000 }).toBe(true);
      } catch (error) {
        const pending = await request(base, `/api/structured/sessions/${id}/queue`, token);
        const session = await request(base, `/api/structured/sessions/${id}`, token);
        const events = session.value?.events?.map((event: any) => ({ type: event.type, status: event.status, toolName: event.toolName }));
        throw new Error(`Parent did not resume: ${JSON.stringify({ mode: pending.value?.mode, holdReason: pending.value?.holdReason, items: pending.value?.items?.map((item: any) => item.state), childRequests, parentFollowups, events })}`, { cause: error });
      }
    }
    const snapshot = await request(base, `/api/structured/sessions/${id}`, token);
    const accepted = snapshot.value.events.filter((event: any) => event.type === 'user_message_accepted');
    const delivered = mode === 'auto' || mode === 'revoked' || mode === 'paired-auto';
    expect(accepted).toHaveLength(delivered ? 2 : 1);
    if (delivered) expect(JSON.stringify(accepted)).toContain('Verified child answer.');
    expect({ childRequests, parentFollowups }).toEqual({ childRequests: 1, parentFollowups: delivered ? 1 : 0 });
    if (delivered) expect(followupCanDelegate).toBe(true);
    expect(await readFile(path.join(workspace, 'notes'), 'utf8')).toBe('original');
  } finally {
    releaseChild();
    try {
      if (api && api.exitCode === null && api.signalCode === null) {
        const stopped = new Promise<void>(resolve => api!.once('exit', () => resolve()));
        api.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([stopped, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture API did not stop')), 15_000); })]);
        } catch (error) {
          api.kill('SIGKILL');
          await stopped;
          throw error;
        } finally { if (timer) clearTimeout(timer); }
      }
    } finally {
      await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  }
});
