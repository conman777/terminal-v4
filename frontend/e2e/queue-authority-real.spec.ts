import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_QUEUE_AUTHORITY_REAL !== '1', 'Requires two dedicated local API binaries.');
test.describe.configure({ mode: 'serial' });

const defaultBinary = process.env.E2E_QUEUE_DEFAULT_BINARY || '';
const previewBinary = process.env.E2E_QUEUE_PREVIEW_BINARY || '';
const secret = 'queue-authority-fixture-only-secret';

async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback port unavailable');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startApi(binary: string, root: string, port: number, provider: number, dataName: string) {
  if (!binary.startsWith(root + '/')) throw new Error('API binary must belong to the isolated fixture');
  const data = path.join(root, dataName);
  await mkdir(data, { recursive: true });
  const child = spawn(binary, [], { env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', XDG_CONFIG_HOME: root, HOST: '127.0.0.1', PORT: String(port),
    TERMINAL_DATA_DIR: data, TERMINAL_USE_TMUX: 'false', TERMINAL_V4_LOCAL_TESTING: '1',
    JWT_SECRET: secret, VAULT_ENCRYPTION_KEY: 'queue-authority-fixture-vault',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider}/v1`, NO_PROXY: '*',
  }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture API exited during startup');
    try { return (await fetch(`${base}/api/auth/mode`)).ok; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
  return { child, base };
}

async function stopApi(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stopped, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture API did not stop')), 15_000); })]);
  } catch (error) {
    child.kill('SIGKILL');
    await stopped;
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

async function call(base: string, route: string, token?: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + route, { method, headers: {
    Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let value: any = null;
  try { value = JSON.parse(text); } catch { /* Some error responses are plain text. */ }
  return { status: response.status, value };
}

async function login(base: string) {
  const result = await call(base, '/api/auth/local-testing', undefined, 'POST', { username: 'queue-fixture' });
  expect(result.status).toBe(200);
  return result.value.tokens.accessToken as string;
}

async function createSession(base: string, token: string, workspace: string) {
  const result = await call(base, '/api/structured/sessions', token, 'POST', { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title: 'Queue fixture' });
  expect(result.status).toBe(201);
  return result.value.id as string;
}

async function queue(base: string, token: string, id: string) {
  const result = await call(base, `/api/structured/sessions/${id}/queue`, token);
  expect(result.status).toBe(200);
  return result.value;
}

test('default backend dispatches a signed delegation through the authorized path', async () => {
  test.setTimeout(90_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !defaultBinary || !previewBinary) throw new Error('An isolated fixture root and both binaries are required');
  const workspace = await mkdtemp(path.join(root, 'workspace-'));
  await writeFile(path.join(workspace, 'notes'), 'original');
  const provider = createHttpServer((incoming, outgoing) => {
    let raw = '';
    incoming.on('data', chunk => { raw += chunk; });
    incoming.on('end', () => {
      const body = JSON.parse(raw);
      const parent = (body.tools || []).some((tool: any) => tool.function?.name === 'delegate_task_background');
      const transcript = JSON.stringify(body.messages || []);
      const answer = (message: unknown, reason = 'stop') => ({ choices: [{ finish_reason: reason, message }] });
      let value;
      if (transcript.includes('Delegated task ')) value = answer({ role: 'assistant', content: 'Parent received the child result.' });
      else if (parent && (body.messages || []).some((message: any) => message.role === 'tool')) value = answer({ role: 'assistant', content: 'Background investigation started.' });
      else if (parent) value = answer({ role: 'assistant', content: null, tool_calls: [{ id: 'delegate-fixture', type: 'function', function: { name: 'delegate_task_background', arguments: JSON.stringify({ prompt: 'Inspect notes.' }) } }] }, 'tool_calls');
      else value = answer({ role: 'assistant', content: 'Verified child answer.' });
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(value));
    });
  });
  await new Promise<void>((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider port unavailable');
  let child: ChildProcess | undefined;
  try {
    const api = await startApi(defaultBinary, root, await freePort(), address.port, 'delegation-data');
    child = api.child;
    const token = await login(api.base);
    expect((await call(api.base, '/api/vault', token, 'POST', { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-fixture-key' })).status).toBe(200);
    const id = await createSession(api.base, token, workspace);
    expect((await call(api.base, `/api/structured/sessions/${id}/message`, token, 'POST', { requestId: randomUUID(), text: 'Investigate the fixture.' })).status).toBe(202);
    let approvalId = '';
    await expect.poll(async () => {
      const session = await call(api.base, `/api/structured/sessions/${id}`, token);
      const approval = session.value?.events?.find((event: any) => event.type === 'approval_required' && event.toolName === 'delegate_task_background');
      approvalId = approval?.approvalId || '';
      return Boolean(approvalId);
    }, { timeout: 20_000 }).toBe(true);
    expect((await call(api.base, `/api/structured/sessions/${id}/approve`, token, 'POST', { approvalId, approved: true })).status).toBe(200);
    await expect.poll(async () => (await queue(api.base, token, id)).items[0]?.state, { timeout: 30_000 }).toBe('accepted');
    const session = await call(api.base, `/api/structured/sessions/${id}`, token);
    const accepted = session.value.events.filter((event: any) => event.type === 'user_message_accepted');
    expect(accepted).toHaveLength(2);
    expect(JSON.stringify(accepted)).toContain('Verified child answer.');
    expect(await readFile(path.join(workspace, 'notes'), 'utf8')).toBe('original');
  } finally {
    if (child) await stopApi(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('default backend preserves the restart hold before dispatching preview-signed work', async () => {
  test.setTimeout(90_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !defaultBinary || !previewBinary) throw new Error('An isolated fixture root and both binaries are required');
  const workspace = await mkdtemp(path.join(root, 'workspace-'));
  const provider = createHttpServer((_incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Restored queue dispatched.' } }] }));
  });
  await new Promise<void>((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider port unavailable');
  let child: ChildProcess | undefined;
  try {
    let api = await startApi(previewBinary, root, await freePort(), address.port, 'restart-data');
    child = api.child;
    const token = await login(api.base);
    expect((await call(api.base, '/api/vault', token, 'POST', { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-fixture-key' })).status).toBe(200);
    const id = await createSession(api.base, token, workspace);
    const enqueued = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: 0,
      operation: { kind: 'enqueue', itemId: randomUUID(), text: 'Preview-signed message', runWhenIdle: false },
    });
    expect(enqueued.status).toBe(200);
    await stopApi(child);
    child = undefined;
    api = await startApi(defaultBinary, root, await freePort(), address.port, 'restart-data');
    child = api.child;
    const held = await queue(api.base, token, id);
    expect([held.mode, held.holdReason, held.items[0]?.state]).toEqual(['held', 'restart', 'pending']);
    expect((await call(api.base, `/api/structured/sessions/${id}`, token)).value.events.filter((event: any) => event.type === 'user_message_accepted')).toHaveLength(0);
    const resume = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: held.revision, operation: { kind: 'resume' },
    });
    expect(resume.status).toBe(200);
    await expect.poll(async () => (await queue(api.base, token, id)).items[0]?.state, { timeout: 20_000 }).toBe('accepted');
    const accepted = (await call(api.base, `/api/structured/sessions/${id}`, token)).value.events.filter((event: any) => event.type === 'user_message_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].content).toContain('Preview-signed message');
  } finally {
    if (child) await stopApi(child);
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('default backend can still edit an unproven message in a legacy session', async () => {
  test.setTimeout(90_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !defaultBinary) throw new Error('An isolated fixture root and default binary are required');
  const workspace = await mkdtemp(path.join(root, 'legacy-unproven-workspace-'));
  let child: ChildProcess | undefined;
  try {
    let api = await startApi(defaultBinary, root, await freePort(), 1, 'legacy-unproven-data');
    child = api.child;
    const loginResult = await call(api.base, '/api/auth/local-testing', undefined, 'POST', { username: 'legacy-unproven' });
    expect(loginResult.status).toBe(200);
    const token = loginResult.value.tokens.accessToken as string;
    const owner = loginResult.value.user.id as string;
    const id = await createSession(api.base, token, workspace);
    const itemId = randomUUID();
    expect((await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: 0,
      operation: { kind: 'enqueue', itemId, text: 'Legacy message', runWhenIdle: false },
    })).status).toBe(200);
    await stopApi(child);
    child = undefined;
    const ownerDir = createHash('sha256').update(owner).digest('hex');
    const checkpointPath = path.join(root, 'legacy-unproven-data', 'structured-sessions', ownerDir, `${id}.json`);
    const [first, ...tail] = (await readFile(checkpointPath, 'utf8')).split('\n');
    expect(tail.join('').trim()).toBe('');
    const checkpoint = JSON.parse(first);
    delete checkpoint.sessionIncarnation;
    checkpoint.version = 1;
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    api = await startApi(defaultBinary, root, await freePort(), 1, 'legacy-unproven-data');
    child = api.child;
    const before = await queue(api.base, token, id);
    const edit = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: before.revision,
      operation: { kind: 'edit', itemId, expectedItemRevision: 1, text: 'Edited legacy message' },
    });
    expect(edit.status).toBe(200);
    const after = await queue(api.base, token, id);
    expect([after.mode, after.holdReason, after.items[0].text]).toEqual(['held', 'restart', 'Edited legacy message']);
    expect(await exists(path.join(root, 'legacy-unproven-data', 'queue-authority.key'))).toBe(false);
  } finally {
    if (child) await stopApi(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('preview backend rejects local queue writes for a legacy session without an incarnation', async () => {
  test.setTimeout(90_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !previewBinary) throw new Error('An isolated fixture root and preview binary are required');
  const workspace = await mkdtemp(path.join(root, 'legacy-workspace-'));
  let child: ChildProcess | undefined;
  try {
    let api = await startApi(previewBinary, root, await freePort(), 1, 'legacy-data');
    child = api.child;
    const loginResult = await call(api.base, '/api/auth/local-testing', undefined, 'POST', { username: 'legacy-fixture' });
    expect(loginResult.status).toBe(200);
    const token = loginResult.value.tokens.accessToken as string;
    const owner = loginResult.value.user.id as string;
    const id = await createSession(api.base, token, workspace);
    const itemId = randomUUID();
    expect((await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: 0,
      operation: { kind: 'enqueue', itemId, text: 'Existing signed message', runWhenIdle: false },
    })).status).toBe(200);
    await stopApi(child);
    child = undefined;
    const ownerDir = createHash('sha256').update(owner).digest('hex');
    const checkpointPath = path.join(root, 'legacy-data', 'structured-sessions', ownerDir, `${id}.json`);
    const [first, ...tail] = (await readFile(checkpointPath, 'utf8')).split('\n');
    expect(tail.join('').trim()).toBe('');
    const checkpoint = JSON.parse(first);
    delete checkpoint.sessionIncarnation;
    checkpoint.version = 1;
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    api = await startApi(previewBinary, root, await freePort(), 1, 'legacy-data');
    child = api.child;
    const before = await queue(api.base, token, id);
    const enqueue = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: before.revision,
      operation: { kind: 'enqueue', itemId: randomUUID(), text: 'Must not be accepted', runWhenIdle: true },
    });
    expect(enqueue.status).toBe(409);
    const edit = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: before.revision,
      operation: { kind: 'edit', itemId, expectedItemRevision: 1, text: 'Must not replace it' },
    });
    expect(edit.status).toBe(409);
    const after = await queue(api.base, token, id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].text).toBe('Existing signed message');
    const resumed = await call(api.base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
      operationId: randomUUID(), expectedQueueRevision: after.revision, operation: { kind: 'resume' },
    });
    expect(resumed.status).toBe(200);
    await expect.poll(async () => {
      const value = await queue(api.base, token, id);
      return [value.mode, value.holdReason, value.items[0]?.state];
    }, { timeout: 10_000 }).toEqual(['held', 'dispatch_error', 'pending']);
    const session = await call(api.base, `/api/structured/sessions/${id}`, token);
    expect(session.value.events.filter((event: any) => event.type === 'user_message_accepted')).toHaveLength(0);
  } finally {
    if (child) await stopApi(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function exists(file: string) {
  try { await stat(file); return true; } catch { return false; }
}

async function loginAs(base: string, username: string) {
  const result = await call(base, '/api/auth/local-testing', undefined, 'POST', { username });
  expect(result.status).toBe(200);
  return { token: result.value.tokens.accessToken as string, owner: result.value.user.id as string };
}

async function enqueueText(base: string, token: string, id: string, revision: number, text: string, operationId = randomUUID()) {
  return call(base, `/api/structured/sessions/${id}/queue`, token, 'POST', {
    operationId, expectedQueueRevision: revision,
    operation: { kind: 'enqueue', itemId: randomUUID(), text, runWhenIdle: false },
  });
}

test('preview backend never recreates a lost queue key, and a retry recovers once it is restored', async () => {
  test.setTimeout(120_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !previewBinary) throw new Error('An isolated fixture root and preview binary are required');
  const workspace = await mkdtemp(path.join(root, 'keyloss-workspace-'));
  const data = path.join(root, 'keyloss-data');
  const key = path.join(data, 'queue-authority.key');
  const marker = path.join(data, 'queue-authority.installation');
  let child: ChildProcess | undefined;
  try {
    let api = await startApi(previewBinary, root, await freePort(), 1, 'keyloss-data');
    child = api.child;
    const { token, owner } = await loginAs(api.base, 'keyloss-fixture');
    const id = await createSession(api.base, token, workspace);
    expect((await enqueueText(api.base, token, id, 0, 'first signed message')).status).toBe(200);
    expect(await exists(key) && await exists(marker)).toBe(true);
    const keyBytes = await readFile(key);
    const markerBytes = await readFile(marker);
    const queueFile = path.join(data, 'followup-queues', sha256(owner), sha256(await realpath(workspace)), `${id}.json`);
    await stopApi(child);
    child = undefined;

    await rm(key);
    api = await startApi(previewBinary, root, await freePort(), 1, 'keyloss-data');
    child = api.child;
    // Reading needs no signing key; it only records the restart hold.
    const restarted = await queue(api.base, token, id);
    expect([restarted.mode, restarted.holdReason, restarted.items]).toEqual(['held', 'restart', expect.any(Array)]);
    const queueBytes = await readFile(queueFile);
    const retry = randomUUID();
    const refused = await enqueueText(api.base, token, id, restarted.revision, 'second signed message', retry);
    expect(refused.status).toBe(503);
    expect(await exists(key)).toBe(false);
    expect((await readFile(marker)).equals(markerBytes)).toBe(true);
    expect((await readFile(queueFile)).equals(queueBytes)).toBe(true);
    expect((await call(api.base, `/api/structured/sessions/${id}/queue/operations/${retry}`, token)).status).toBe(404);
    await stopApi(child);
    child = undefined;

    await writeFile(key, keyBytes);
    await chmod(key, 0o600);
    api = await startApi(previewBinary, root, await freePort(), 1, 'keyloss-data');
    child = api.child;
    const before = await queue(api.base, token, id);
    expect([before.mode, before.holdReason, before.items]).toEqual(['held', 'restart', expect.any(Array)]);
    expect(before.items).toHaveLength(1);
    const recovered = await enqueueText(api.base, token, id, before.revision, 'second signed message', retry);
    expect(recovered.status).toBe(200);
    expect((await queue(api.base, token, id)).items).toHaveLength(2);
    expect((await readFile(marker)).equals(markerBytes)).toBe(true);
    expect((await readdir(data)).filter(name => name.startsWith('queue-authority')).sort()).toEqual(['queue-authority.installation', 'queue-authority.key']);
  } finally {
    if (child) await stopApi(child);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('preview backend installs for one owner while another owner\'s damaged legacy queue stays preserved and held', async () => {
  test.setTimeout(120_000);
  const root = process.env.E2E_QUEUE_FIXTURE_ROOT || '';
  if (!root || !defaultBinary || !previewBinary) throw new Error('An isolated fixture root and both binaries are required');
  const workspace = await mkdtemp(path.join(root, 'damage-workspace-'));
  const data = path.join(root, 'damage-data');
  let child: ChildProcess | undefined;
  try {
    let api = await startApi(defaultBinary, root, await freePort(), 1, 'damage-data');
    child = api.child;
    const damaged = await loginAs(api.base, 'damaged-fixture');
    const damagedId = await createSession(api.base, damaged.token, workspace);
    expect((await enqueueText(api.base, damaged.token, damagedId, 0, 'legacy message')).status).toBe(200);
    await stopApi(child);
    child = undefined;
    expect(await exists(path.join(data, 'queue-authority.key'))).toBe(false);
    const damagedFile = path.join(data, 'followup-queues', sha256(damaged.owner), sha256(await realpath(workspace)), `${damagedId}.json`);
    await writeFile(damagedFile, '{malformed');
    await chmod(damagedFile, 0o600);

    api = await startApi(previewBinary, root, await freePort(), 1, 'damage-data');
    child = api.child;
    const other = await loginAs(api.base, 'healthy-fixture');
    const otherId = await createSession(api.base, other.token, workspace);
    expect((await enqueueText(api.base, other.token, otherId, 0, 'healthy signed message')).status).toBe(200);
    expect(await exists(path.join(data, 'queue-authority.key')) && await exists(path.join(data, 'queue-authority.installation'))).toBe(true);
    expect((await readFile(damagedFile, 'utf8'))).toBe('{malformed');
    expect((await call(api.base, `/api/structured/sessions/${damagedId}/queue`, damaged.token)).status).toBe(503);
    expect((await queue(api.base, other.token, otherId)).items).toHaveLength(1);
  } finally {
    if (child) await stopApi(child);
    await rm(workspace, { recursive: true, force: true });
  }
});
