import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_IMAGE_REAL_PROJECT, 'Requires an isolated local backend and disposable project.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

test('admits a start image through the local backend with no configured provider key', async ({ page }) => {
  const project = process.env.E2E_IMAGE_REAL_PROJECT!;
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: project, parent: null, folders: [] } }));
  // Catalog is synthetic only so the test requires no configured provider or key.
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'anthropic-api', label: 'Synthetic agent', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'claude-fable-5', label: 'Synthetic model', default: true, imageInput: true }] }] } }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`real-image-start-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  const start = page.getByRole('region', { name: 'Workspace start' });
  await start.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('button', { name: 'Open here', exact: true }).click();
  await start.getByRole('textbox', { name: 'Command composer' }).fill('Inspect this synthetic image');
  const picker = page.waitForEvent('filechooser');
  await start.getByRole('button', { name: 'Add image', exact: true }).click();
  await (await picker).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
  await expect(start.getByText('synthetic.png')).toBeVisible();
  const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/structured/start-requests' && response.request().method() === 'POST');
  const upload = page.waitForResponse(response => /\/api\/structured\/sessions\/[^/]+\/attachments$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  const send = page.waitForResponse(response => /\/api\/structured\/sessions\/[^/]+\/attachments\/send$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await start.getByRole('button', { name: 'Start task' }).click();
  const response = await receipt;
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body).toMatchObject({ status: 'created', selection: { provider: 'anthropic-api', model: 'claude-fable-5' } });
  expect((await upload).ok()).toBe(true);
  const sent = await send;
  expect(sent.ok()).toBe(true);
  const accepted = await sent.json();
  expect(accepted).toMatchObject({ status: 'accepted', input: { text: 'Inspect this synthetic image', attachments: [{ name: 'synthetic.png' }] } });
  await expect(start).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Command composer' })).toHaveValue('');
  const durable = await page.evaluate(async ({ sessionId, requestId }) => {
    const { apiFetch } = await import('/src/utils/api.js');
    const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/requests/${requestId}`);
    return { status: response.status, body: await response.json() };
  }, { sessionId: body.sessionId, requestId: accepted.requestId });
  expect(durable.status).toBe(200);
  expect(durable.body).toMatchObject({ requestId: accepted.requestId, input: accepted.input });
});
