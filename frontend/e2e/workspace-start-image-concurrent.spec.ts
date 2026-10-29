import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_IMAGE_REAL_PROJECT, 'Requires an isolated local backend and disposable project.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

test('editing and sending in the destination during a delayed start cannot cause a second send', async ({ page, context }) => {
  const project = process.env.E2E_IMAGE_REAL_PROJECT!;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64');
  const artifactId = createHash('sha256').update('v4-image-v1\0image/png\0').update(bytes).digest('hex');
  await context.route('**/api/fs/list**', route => route.fulfill({ json: { path: project, parent: null, folders: [] } }));
  await context.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'deepseek', label: 'Synthetic agent', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'deepseek-chat', label: 'Synthetic model', default: true, imageInput: true }] }] } }));
  let release!: () => void, uploads = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  await context.route('**/api/structured/sessions/*/attachments', async route => {
    const count = ++uploads;
    const match = route.request().postDataBuffer()?.toString('latin1').match(/name="uploadId"\r\n\r\n([0-9a-f-]+)/i);
    if (!match) throw new Error('Missing upload identity');
    if (count === 1) await blocked;
    await route.fulfill({ status: 201, json: { status: 'ready', expiresAt: Date.now() + 60000,
      attachment: { attachmentId: match[1], artifactId, mimeType: 'image/png', bytes: bytes.length, name: 'chart.png' } } }).catch(() => {});
  });
  await context.route('**/api/structured/sessions/*/attachments/send', route => {
    const input = route.request().postDataJSON(); sent.push(input);
    return route.fulfill({ json: { status: 'accepted', requestId: input.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1,
      input: { text: input.text, attachments: input.attachments } } });
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`concurrent-image-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Original start draft');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: bytes });
  await expect(start.getByText('chart.png')).toBeVisible();
  await start.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect.poll(() => uploads).toBe(1);
  const destination = await context.newPage();
  try {
    await destination.goto('/');
    const composer = destination.getByRole('textbox', { name: 'Command composer' });
    await expect(composer).toHaveValue('Original start draft');
    await destination.getByRole('button', { name: 'Retry image upload chart.png' }).click();
    await expect.poll(() => uploads).toBe(2);
    await expect(destination.getByRole('region', { name: 'Image attachments' }).getByText('Ready', { exact: true })).toBeVisible();
    await composer.fill('Edited in the destination');
    await destination.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    release();
    await expect(start.getByText(/image transfer may have completed/i)).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: 'Edited in the destination' });
  } finally { release(); await destination.close(); }
});

test('a newer start draft in another tab is not erased by accepted-send cleanup', async ({ page, context }) => {
  const project = process.env.E2E_IMAGE_REAL_PROJECT!;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64');
  const artifactId = createHash('sha256').update('v4-image-v1\0image/png\0').update(bytes).digest('hex');
  await context.route('**/api/fs/list**', route => route.fulfill({ json: { path: project, parent: null, folders: [] } }));
  await context.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'deepseek', label: 'Synthetic agent', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'deepseek-chat', label: 'Synthetic model', default: true, imageInput: true }] }] } }));
  let release!: () => void, sends = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/api/structured/sessions/*/attachments', route => {
    const match = route.request().postDataBuffer()?.toString('latin1').match(/name="uploadId"\r\n\r\n([0-9a-f-]+)/i);
    if (!match) throw new Error('Missing upload identity');
    return route.fulfill({ status: 201, json: { status: 'ready', expiresAt: Date.now() + 60000,
      attachment: { attachmentId: match[1], artifactId, mimeType: 'image/png', bytes: bytes.length, name: 'chart.png' } } });
  });
  await context.route('**/api/structured/sessions/*/attachments/send', async route => {
    sends += 1; const input = route.request().postDataJSON();
    await blocked;
    await route.fulfill({ json: { status: 'accepted', requestId: input.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1,
      input: { text: input.text, attachments: input.attachments } } }).catch(() => {});
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`start-draft-race-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Original draft');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: bytes });
  await expect(start.getByText('chart.png')).toBeVisible();
  const other = await context.newPage();
  try {
    await other.goto('/');
    const otherStart = other.getByRole('region', { name: 'Workspace start' });
    await expect(otherStart.getByText('chart.png')).toBeVisible();
    await start.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect.poll(() => sends).toBe(1);
    const composer = otherStart.getByRole('textbox', { name: 'Command composer' });
    await composer.fill('Newer unsent draft');
    await expect.poll(() => other.evaluate(async () => {
      const { captureAuthScope } = await import('/src/utils/auth.js');
      const auth = captureAuthScope();
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('v4-composer-images'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const record = await new Promise<any>((resolve, reject) => { const request = db.transaction('records').objectStore('records').get(['scope', auth.userId, auth.home, 'home', 'workspace-start']); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close(); return record?.draft?.rawText;
    })).toBe('Newer unsent draft');
    release();
    await expect(start.getByText(/message may have been sent/i)).toBeVisible();
    await expect(composer).toHaveValue('Newer unsent draft');
    await expect(otherStart.getByText('chart.png')).toBeVisible();
    await start.getByRole('button', { name: 'Start another task' }).click();
    await expect(start.getByRole('textbox', { name: 'Command composer' })).toHaveValue('Newer unsent draft');
    await expect(start.getByText('chart.png')).toBeVisible();
    expect(sends).toBe(1);
  } finally { release(); await other.close(); }
});
