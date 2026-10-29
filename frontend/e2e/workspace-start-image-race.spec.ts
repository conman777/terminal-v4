import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_IMAGE_REAL_PROJECT || !process.env.E2E_IMAGE_OTHER_PROJECT, 'Requires an isolated local backend and disposable projects.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const different of [false, true]) {
  test(`concurrent tabs use one source-bound start ID with ${different ? 'different' : 'matching'} selections`, async ({ page, context }) => {
    const project = process.env.E2E_IMAGE_REAL_PROJECT!, other = process.env.E2E_IMAGE_OTHER_PROJECT!;
    await context.route('**/api/fs/list**', route => route.fulfill({ json: { path: project, parent: null, folders: [] } }));
    await context.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'deepseek', label: 'Synthetic agent', runtime: 'v4', capabilities: { structured: true }, available: true, models: [{ id: 'deepseek-chat', label: 'Synthetic model', default: true, imageInput: true }] }] } }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`image-race-${different}-${Date.now()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.getByRole('region', { name: 'Workspace start' });
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    await start.getByRole('textbox', { name: 'Command composer' }).fill('Inspect this synthetic image');
    const picker = page.waitForEvent('filechooser');
    await start.getByRole('button', { name: 'Add image', exact: true }).click();
    await (await picker).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64') });
    await expect(start.getByText('synthetic.png')).toBeVisible();
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('region', { name: 'Workspace start' }).getByText('synthetic.png')).toBeVisible();
    const post = (tab: typeof page, cwd: string, model: string) => tab.evaluate(async ({ cwd, model }) => {
      const transfer = await import('/src/utils/startImageTransfer.js');
      const { getComposerDraftStore } = await import('/src/utils/composerDraftStore.js');
      const { captureAuthScope, isAuthScopeCurrent } = await import('/src/utils/auth.js');
      const { getEnvironmentSignal } = await import('/src/utils/remoteEnvironments.js');
      const { apiFetch } = await import('/src/utils/api.js');
      const facade = getComposerDraftStore('workspace-start'), auth = captureAuthScope(), signal = getEnvironmentSignal();
      const native = facade.getImageStore() || facade.observeImages({ scope: [auth.userId, auth.home, 'home', 'workspace-start'], signal,
        isCurrent: () => !signal.aborted && isAuthScopeCurrent(auth) });
      const binding = await transfer.captureStartImageSource(native, () => true);
      const requestId = await transfer.startImageRequestId(binding);
      const response = await apiFetch('/api/structured/start-requests', { method: 'POST', body: { requestId, cwd, provider: 'deepseek', model } });
      return { requestId, status: response.status, body: await response.json() };
    }, { cwd, model });
    const [first, later] = await Promise.all([
      post(page, project, 'deepseek-chat'), post(second, different ? other : project, different ? 'deepseek-reasoner' : 'deepseek-chat'),
    ]);
    expect(later.requestId).toBe(first.requestId);
    if (different) expect([first.status, later.status].sort()).toEqual([200, 409]);
    else expect([first.status, later.status].every(status => [200, 202].includes(status))).toBe(true);
    await second.close();
  });
}
