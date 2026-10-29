import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { test, expect, devices } from '@playwright/test';

test.skip(process.env.E2E_CODEX_FIXTURE !== '1', 'Requires an isolated local API using the synthetic Codex app-server fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_CODEX_BROWSER } });

const workspace = process.env.E2E_CODEX_WORKSPACE || '/tmp/terminal-v4-codex-smoke/workspace';
const owner = 'codex-smoke-owner';
function token() {
  const secret = process.env.E2E_CODEX_JWT_SECRET;
  if (!secret) throw new Error('Set the isolated API JWT secret for this fixture test.');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: owner, username: owner, iat: now, exp: now + 3600, token_kind: 'access' })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

test('local Codex opens as a conversation, handles approval, survives reload and stops', async ({ page, request, browser }) => {
  test.setTimeout(90_000);
  const accessToken = token();
  const otherWorkspace = `${workspace}-other`;
  mkdirSync(otherWorkspace, { recursive: true });
  const selectionWrites: string[] = [];
  const conversationCreates: string[] = [];
  page.on('request', req => {
    const path = new URL(req.url()).pathname;
    if (req.method() === 'PATCH' && path.endsWith('/selection')) selectionWrites.push(req.url());
    if (req.method() === 'POST' && path === '/api/structured/sessions') conversationCreates.push(req.url());
  });
  const terminalCreates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/terminal') terminalCreates.push(request.url()); });
  const headers = { Authorization: `Bearer ${accessToken}` };
  const settings = await request.patch('/api/settings', { headers, data: { recentFolders: [workspace, otherWorkspace], sidebarProjects: [{ path: workspace, name: 'Codex fixture' }, { path: otherWorkspace, name: 'Other fixture project' }] } });
  expect(settings.ok()).toBe(true);
  await page.addInitScript(({ accessToken, owner, workspace }) => {
    localStorage.setItem('terminal_access_token', accessToken);
    localStorage.setItem('terminal_refresh_token', 'isolated-fixture');
    localStorage.setItem('terminal_user', JSON.stringify({ id: owner, username: owner }));
    localStorage.setItem('recentFolders', JSON.stringify([workspace]));
    localStorage.setItem('sidebarProjects', JSON.stringify([{ path: workspace, name: 'Codex fixture' }]));
  }, { accessToken, owner, workspace });
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
    id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true },
    models: [{ id: 'fixture-initial-model', label: 'Fixture initial model', default: true }, { id: 'fixture-next-model', label: 'Fixture next model' }],
    reasoningLevels: ['low', 'medium', 'high']
  }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'New thread', exact: true }).click();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitemradio').filter({ has: page.getByText(workspace, { exact: true }) }).click();
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('title', workspace);
  const initialPrompt = page.getByPlaceholder('Ask Codex to do anything…', { exact: true });
  await page.getByRole('button', { name: 'Codex speed', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Standard/ }).click();
  await initialPrompt.fill('approval-pair');
  await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
  await expect(page.locator('.pro-folder-browser')).toHaveCount(0);
  const firstInput = page.waitForRequest(request => request.method() === 'POST' && /\/api\/structured\/sessions\/[^/]+\/input$/.test(new URL(request.url()).pathname));
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  const firstRequest = await firstInput;
  expect(firstRequest.postDataJSON().text).toBe('approval-pair');
  const sessionId = new URL(firstRequest.url()).pathname.split('/')[4];
  const composer = page.getByPlaceholder('Ask Codex to do anything…', { exact: true });
  await expect(composer).toBeVisible();
  await expect(page.locator('.threads-session-item.active')).toBeVisible();
  const projectName = page.locator('.threads-project-name').first();
  await expect(projectName).toBeVisible();
  expect(await projectName.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Add image', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Launch permissions unavailable' })).toHaveCount(0);
  await expect(page.getByText(/attachments are not supported/i)).toHaveCount(0);
  await expect(page.getByText('Run the fixture command', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('/fixture/example.txt', { exact: false })).toBeVisible();
  await expect(page.getByText('+fixture', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText('Local Codex reply', { exact: true })).toBeVisible();
  const modelButton = page.getByRole('button', { name: /^Codex model / });
  await expect(modelButton).toBeEnabled();
  expect(selectionWrites).toEqual([]);
  await modelButton.click();
  const modelSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/selection'));
  await page.getByRole('button', { name: 'Fixture next model', exact: true }).click();
  expect((await modelSaved).status()).toBe(200);
  await expect(modelButton).toContainText('Fixture next model');
  await page.getByRole('button', { name: 'Agent reasoning effort', exact: true }).click();
  const reasoningSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/selection'));
  await page.getByRole('menuitemradio', { name: 'Medium', exact: true }).click();
  expect((await reasoningSaved).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Agent reasoning effort', exact: true })).toContainText('Medium');
  const changed = await (await request.get(`/api/structured/sessions/${sessionId}`, { headers })).json();
  expect({ id: changed.id, model: changed.model, reasoning: changed.reasoning }).toEqual({ id: sessionId, model: 'fixture-next-model', reasoning: 'medium' });
  expect(changed.serviceTier).toBe('default');
  await page.getByRole('button', { name: 'Codex speed', exact: true }).click();
  const speedSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/selection'));
  await page.getByRole('menuitemradio', { name: /^Fast/ }).click();
  expect((await speedSaved).status()).toBe(200);
  await page.reload();
  await expect(composer).toBeVisible();
  await expect(modelButton).toContainText('Fixture next model');
  await expect(page.getByRole('button', { name: 'Agent reasoning effort', exact: true })).toContainText('Medium');
  expect(selectionWrites).toHaveLength(3);
  await expect(page.getByRole('button', { name: 'Codex speed', exact: true })).toContainText('Fast');
  await expect(page.getByText('Local Codex reply', { exact: true })).toHaveCount(1);
  await composer.fill('Continue');
  await composer.press('Enter');
  await expect(page.getByText('Local Codex reply', { exact: true })).toHaveCount(2);
  if (process.env.E2E_CODEX_PROTOCOL_LOG) {
    const packets = readFileSync(process.env.E2E_CODEX_PROTOCOL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const resume = packets.filter(packet => packet.method === 'thread/resume').at(-1);
    expect({ threadId: resume.params.threadId, model: resume.params.model, reasoning: resume.params.config.model_reasoning_effort, serviceTier: resume.params.serviceTier })
      .toEqual({ threadId: 'native-fixture', model: 'fixture-next-model', reasoning: 'medium', serviceTier: 'fast' });
  }
  await composer.fill('Keep this draft in the original chat');
  const createsBeforeProjectChange = conversationCreates.length;
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.getByText('New chat in project', { exact: true })).toBeVisible();
  await page.getByRole('menuitemradio').filter({ hasText: otherWorkspace }).click();
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('title', otherWorkspace);
  expect(conversationCreates).toHaveLength(createsBeforeProjectChange);
  await page.locator('.threads-session-item').filter({ hasText: 'approval-pair' }).first().click();
  await expect(composer).toHaveValue('Keep this draft in the original chat');
  await expect(page.getByText('Local Codex reply', { exact: true })).toHaveCount(2);

  await composer.fill('hold');
  await composer.press('Enter');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await expect(modelButton).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Codex speed', exact: true })).toBeDisabled();
  const blockedChange = await request.patch(`/api/structured/sessions/${sessionId}/selection`, { headers, data: { model: 'must-not-change', reasoning: 'low' } });
  expect(blockedChange.status()).toBe(409);
  await page.getByRole('button', { name: /stop/i }).last().click();
  await expect(composer).toBeEnabled();
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Agent reasoning effort', 'Codex speed']) {
      const picker = page.getByRole('button', { name, exact: true });
      await page.screenshot({ path: `/tmp/terminal-v4-claude-ui/picker-${width}.png` });
      await picker.click();
      const menu = await page.getByRole('menu', { name, exact: true }).boundingBox();
      const pane = await page.locator('.terminal-pane').boundingBox();
      expect(menu!.x).toBeGreaterThanOrEqual(pane!.x);
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(pane!.x + pane!.width);
      await picker.click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: '/tmp/terminal-v4-codex-smoke/desktop.png', fullPage: true });
  const mobileContext = await browser.newContext({ ...devices['iPhone 13'], storageState: await page.context().storageState(), baseURL: process.env.BASE_URL });
  const mobile = await mobileContext.newPage();
  await mobile.goto('/');
  await expect(mobile.locator('.layout.mobile')).toBeVisible();
  const phoneComposer = mobile.getByPlaceholder('Message Codex…', { exact: true });
  await expect(phoneComposer).toBeInViewport();
  await phoneComposer.fill('Continue on phone');
  await mobile.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(mobile.getByText('Local Codex reply', { exact: true })).toHaveCount(3);
  await expect(mobile.getByText(/attachments are not supported/i)).toHaveCount(0);
  await mobile.screenshot({ path: '/tmp/terminal-v4-codex-smoke/mobile.png', fullPage: true });
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.getByRole('button', { name: 'More actions', exact: true }).click();
  await mobile.getByRole('button', { name: 'New thread', exact: true }).click();
  const phoneStart = mobile.getByPlaceholder('Ask Codex to do anything…', { exact: true });
  await expect(phoneStart).toBeVisible();
  await phoneStart.fill('Start directly from the phone composer');
  await expect(mobile.locator('.pro-folder-browser')).toHaveCount(0);
  await mobile.getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(mobile.getByText('Local Codex reply', { exact: true })).toHaveCount(1);
  expect(terminalCreates).toEqual([]);
  await mobileContext.close();
});
