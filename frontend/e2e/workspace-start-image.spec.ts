import { expect, test, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64');
const artifactId = createHash('sha256').update('v4-image-v1\0image/png\0').update(imageBytes).digest('hex');
function imageAction(route: Route) {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith('/attachments')) {
    const match = route.request().postDataBuffer()?.toString('latin1').match(/name="uploadId"\r\n\r\n([0-9a-f-]+)/i);
    if (!match) throw new Error('Missing upload identity');
    return route.fulfill({ status: 201, json: { status: 'ready', expiresAt: Date.now() + 60000,
      attachment: { attachmentId: match[1], artifactId, mimeType: 'image/png', bytes: imageBytes.length, name: 'chart.png' } } });
  }
  if (path.endsWith('/attachments/send')) {
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { status: 'accepted', requestId: input.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1,
      input: { text: input.text, attachments: input.attachments } } });
  }
  return route.fulfill({ status: 404, json: {} });
}

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
if (process.env.E2E_LEGACY_ABORT === '1') {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      delete (AbortSignal as unknown as { any?: unknown }).any;
      delete (AbortSignal as unknown as { timeout?: unknown }).timeout;
      delete (AbortSignal.prototype as unknown as { throwIfAborted?: unknown }).throwIfAborted;
      delete (AbortSignal.prototype as unknown as { reason?: unknown }).reason;
      (window as unknown as { legacyAbortFixture: boolean }).legacyAbortFixture =
        typeof AbortSignal.any === 'undefined' && typeof AbortSignal.timeout === 'undefined'
        && typeof AbortSignal.prototype.throwIfAborted === 'undefined' && !('reason' in AbortSignal.prototype);
    });
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 1440, height: 900 }]) {
  test(`open an empty image conversation with the draft at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }] }] } }));
    const snapshot = { id: 'ss-image-fixture', cwd: '/tmp/v4-image-open-fixture/project', runtime: 'v4', provider: 'lmstudio', model: 'fixture-model', title: 'Review my image', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: [] };
    let created = false;
    let sends = 0;
    await page.route('**/api/structured/sessions**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/structured/sessions' && route.request().method() === 'POST') { created = true; return route.fulfill({ json: snapshot }); }
      if (url.pathname === '/api/structured/sessions' && route.request().method() === 'GET') return route.fulfill({ json: created ? [snapshot] : [] });
      if (url.pathname === `/api/structured/sessions/${snapshot.id}` && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
      if (route.request().method() !== 'GET') { sends += 1; return route.fulfill({ status: 403, json: {} }); }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('/');
    if (process.env.E2E_LEGACY_ABORT === '1') {
      expect(await page.evaluate(() => ({
        removedBeforeStartup: (window as unknown as { legacyAbortFixture: boolean }).legacyAbortFixture,
        installed: [typeof AbortSignal.any, typeof AbortSignal.timeout, typeof AbortSignal.prototype.throwIfAborted],
      }))).toEqual({ removedBeforeStartup: true, installed: ['function', 'function', 'function'] });
    }
    await page.getByLabel('Username', { exact: true }).fill(`image-open-${viewport.width}-${Date.now()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.getByRole('region', { name: 'Workspace start' });
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    await start.getByRole('textbox', { name: 'Command composer' }).fill('Review my image');
    const open = start.getByRole('button', { name: 'Open conversation to add images' });
    await expect(open).toBeEnabled();
    await open.scrollIntoViewIfNeeded();
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('image-entry.png'), animations: 'disabled' });
    await open.click();
    await expect.poll(() => created).toBe(true);
    await expect(start).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Review my image');
    expect(sends).toBe(0);
  });
}

test('an uncertain first-image conversation keeps the original draft across reload without another create', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  const requests: string[] = [];
  await page.route('**/api/structured/start-requests', route => { requests.push(route.request().postDataJSON().requestId); return route.abort('failed'); });
  await page.route('**/api/structured/sessions', route => route.fulfill({ json: [] }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`uncertain-image-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Keep this image');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
  await expect(start.getByText('chart.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task' }).click();
  await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
  await page.reload();
  await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
  await expect(start.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Keep this image');
  await expect(start.getByText('chart.png')).toBeVisible();
  expect(requests).toHaveLength(1);
  await start.getByRole('button', { name: 'Start another task' }).click();
  await start.getByRole('button', { name: 'Start task' }).click();
  await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).not.toBe(requests[0]);
});

test('resumes an uncertain image start with the identical request after reload', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  const snapshot = { id: 'ss-recovered-image', cwd: '/tmp/v4-image-open-fixture/project', runtime: 'v4', provider: 'lmstudio', model: 'fixture-model', title: 'Keep this image', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: [] };
  const requests: unknown[] = [];
  let messages = 0;
  await page.route('**/api/structured/start-requests', route => {
    const input = route.request().postDataJSON(); requests.push(input);
    if (requests.length === 1) return route.abort('failed');
    return route.fulfill({ json: { status: 'created', requestId: input.requestId,
      selection: { cwd: snapshot.cwd, provider: snapshot.provider, model: snapshot.model }, sessionId: snapshot.id } });
  });
  await page.route('**/api/structured/sessions**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/structured/sessions' && route.request().method() === 'GET') return route.fulfill({ json: requests.length ? [snapshot] : [] });
    if (path === `/api/structured/sessions/${snapshot.id}` && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    if (route.request().method() === 'POST' && (path.endsWith('/attachments') || path.endsWith('/attachments/send'))) {
      if (path.endsWith('/attachments/send')) messages += 1;
      return imageAction(route);
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`resume-image-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Keep this image');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
  await expect(start.getByText('chart.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task' }).click();
  await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await start.getByRole('button', { name: 'Check and resume image request' }).click();
  await expect(start).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Command composer' })).toHaveValue('');
  expect(messages).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('a start can send an image with no text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  const snapshot = { id: 'ss-only-image', cwd: '/tmp/v4-image-open-fixture/project', runtime: 'v4', provider: 'lmstudio', model: 'fixture-model', title: 'Image', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: [] };
  let created = false; const messages: unknown[] = [];
  await page.route('**/api/structured/start-requests', route => {
    created = true;
    return route.fulfill({ json: { status: 'created', requestId: route.request().postDataJSON().requestId,
      selection: { cwd: snapshot.cwd, provider: snapshot.provider, model: snapshot.model }, sessionId: snapshot.id } });
  });
  await page.route('**/api/structured/sessions**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/structured/sessions' && route.request().method() === 'GET') return route.fulfill({ json: created ? [snapshot] : [] });
    if (path === `/api/structured/sessions/${snapshot.id}` && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    if (route.request().method() === 'POST' && (path.endsWith('/attachments') || path.endsWith('/attachments/send'))) {
      if (path.endsWith('/attachments/send')) messages.push(route.request().postDataJSON());
      return imageAction(route);
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`only-image-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: imageBytes });
  await expect(start.getByText('chart.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(start).toHaveCount(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: '', attachments: [{ name: 'chart.png', artifactId }] });
});

test('a lost image message response is held across reload without automatic replay', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  const snapshot = { id: 'ss-lost-message', cwd: '/tmp/v4-image-open-fixture/project', runtime: 'v4', provider: 'lmstudio', model: 'fixture-model', title: 'Check image', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: [] };
  let created = false, sends = 0;
  await page.route('**/api/structured/start-requests', route => {
    created = true;
    return route.fulfill({ json: { status: 'created', requestId: route.request().postDataJSON().requestId,
      selection: { cwd: snapshot.cwd, provider: snapshot.provider, model: snapshot.model }, sessionId: snapshot.id } });
  });
  await page.route('**/api/structured/sessions**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/structured/sessions' && route.request().method() === 'GET') return route.fulfill({ json: created ? [snapshot] : [] });
    if (path === `/api/structured/sessions/${snapshot.id}` && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
    if (route.request().method() === 'POST' && path.endsWith('/attachments')) return imageAction(route);
    if (route.request().method() === 'POST' && path.endsWith('/attachments/send')) { sends += 1; return route.abort('failed'); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`lost-image-message-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Check image');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: imageBytes });
  await expect(start.getByText('chart.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(start.getByText(/message may have been sent/i)).toBeVisible();
  await expect(start.getByRole('button', { name: 'Review conversation' })).toBeVisible();
  expect(sends).toBe(1);
  await page.reload();
  await expect(page.getByText('Previous send outcome unknown')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check previous send' })).toBeVisible();
  expect(sends).toBe(1);
});

test('start image originals stay with the authenticated account', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  const username = `images-owner-${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  let start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Owner-only draft');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'owner-only.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
  await expect(start.getByText('owner-only.png')).toBeVisible();
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(`${username}-other`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  start = page.getByRole('region', { name: 'Workspace start' });
  await expect(start.getByText('owner-only.png')).toHaveCount(0);
  await expect(start.getByRole('textbox', { name: 'Command composer' })).not.toHaveValue('Owner-only draft');
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  start = page.getByRole('region', { name: 'Workspace start' });
  await expect(start.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Owner-only draft');
  await expect(start.getByText('owner-only.png')).toBeVisible();
});

test('an account switch fences a delayed image start and retains the original request', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
  let release!: () => void;
  let started = false;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/structured/start-requests', async route => {
    started = true;
    const requestId = route.request().postDataJSON().requestId;
    await delayed;
    await route.fulfill({ json: { status: 'created', requestId, selection: { cwd: '/tmp/v4-image-open-fixture/project', provider: 'lmstudio', model: 'fixture-model' }, sessionId: 'ss-late' } }).catch(() => {});
  });
  const username = `images-race-${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  let start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Private delayed image');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'private.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
  await expect(start.getByText('private.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task' }).click();
  await expect.poll(() => started).toBe(true);
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(`${username}-other`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  release();
  start = page.getByRole('region', { name: 'Workspace start' });
  await expect(start.getByText('private.png')).toHaveCount(0);
  await expect(start.getByRole('textbox', { name: 'Command composer' })).not.toHaveValue('Private delayed image');
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  start = page.getByRole('region', { name: 'Workspace start' });
  await expect(start.getByText('private.png')).toBeVisible();
  await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`select and send a start image at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/v4-image-open-fixture/project', parent: null, folders: [] } }));
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true, imageInput: true }] }] } }));
    const snapshot = { id: 'ss-image-fixture', cwd: '/tmp/v4-image-open-fixture/project', runtime: 'v4', provider: 'lmstudio', model: 'fixture-model', title: 'Review my image', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', events: [] };
    let creates = 0, sends = 0;
    await page.route('**/api/structured/start-requests', route => {
      creates += 1;
      return route.fulfill({ json: { status: 'created', requestId: route.request().postDataJSON().requestId,
        selection: { cwd: snapshot.cwd, provider: snapshot.provider, model: snapshot.model }, sessionId: snapshot.id } });
    });
    await page.route('**/api/structured/sessions**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/structured/sessions' && route.request().method() === 'POST') { creates += 1; return route.fulfill({ json: snapshot }); }
      if (url.pathname === '/api/structured/sessions' && route.request().method() === 'GET') return route.fulfill({ json: creates ? [snapshot] : [] });
      if (url.pathname === `/api/structured/sessions/${snapshot.id}` && route.request().method() === 'GET') return route.fulfill({ json: snapshot });
      if (route.request().method() === 'POST' && (url.pathname.endsWith('/attachments') || url.pathname.endsWith('/attachments/send'))) {
        if (url.pathname.endsWith('/attachments/send')) sends += 1;
        return imageAction(route);
      }
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`direct-image-${viewport.width}-${Date.now()}`);
    if (process.env.E2E_LEGACY_ABORT === '1') {
      expect(await page.evaluate(() => ({
        removedBeforeStartup: (window as unknown as { legacyAbortFixture: boolean }).legacyAbortFixture,
        installed: [typeof AbortSignal.any, typeof AbortSignal.timeout, typeof AbortSignal.prototype.throwIfAborted],
      }))).toEqual({ removedBeforeStartup: true, installed: ['function', 'function', 'function'] });
    }
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.getByRole('region', { name: 'Workspace start' });
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    if (viewport.width < 768) {
      const project = start.getByRole('button', { name: 'Project', exact: true });
      const placement = start.getByRole('button', { name: 'Where', exact: true });
      for (const control of [project, placement]) {
        const bounds = await control.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      }
      const labelFits = (element: HTMLElement) => {
        const text = element.querySelector(':scope > span') as HTMLElement;
        return text.scrollWidth <= text.clientWidth;
      };
      await expect(project).toContainText('project');
      expect(await project.evaluate(labelFits)).toBe(true);
      await expect(placement).toContainText('This folder');
      expect(await placement.evaluate(labelFits)).toBe(true);
      await placement.click();
      const menu = page.getByRole('menu', { name: 'Where' });
      const menuBox = await menu.boundingBox();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width);
      await menu.getByRole('menuitemradio', { name: /New worktree/ }).click();
      await expect(placement).toContainText('New worktree');
      expect(await placement.evaluate(labelFits)).toBe(true);
      await placement.click();
      await page.getByRole('menu', { name: 'Where' }).getByRole('menuitemradio', { name: /This folder/ }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await start.getByRole('textbox', { name: 'Command composer' }).fill('Review my image');
    const picker = page.waitForEvent('filechooser');
    await start.getByRole('button', { name: 'Add image', exact: true }).click();
    await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
    await expect(start.getByText('chart.png')).toBeVisible();
    await start.getByRole('button', { name: 'Start task' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('start-with-image.png'), animations: 'disabled' });
    await start.getByRole('button', { name: 'Start task' }).click();
    await expect(start).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Command composer' })).toHaveValue('');
    expect({ creates, sends }).toEqual({ creates: 1, sends: 1 });
  });
}
