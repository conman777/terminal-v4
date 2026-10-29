import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 684 }, { width: 1440, height: 900 }]) {
  test.describe(`${viewport.width}px`, () => {
  test.use({ viewport, isMobile: viewport.width <= 768, hasTouch: viewport.width <= 768 });
  test(`pickers, new-thread setup and Tools share a usable layout at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const project = '/tmp/ui-consistency-fixture';
    await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: project, parent: '/', folders: ['src'] } }));
    await page.route('**/api/workspace/profile*', route => route.fulfill({ json: { memory: '', skills: [] } }));
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [
      { id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true },
        models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }], reasoningLevels: ['low', 'high', 'xhigh'] },
      { id: 'claude', label: 'Claude Code', runtime: 'claude', available: true, status: 'ready', models: [{ id: 'sonnet', label: 'Sonnet' }], reasoningLevels: ['low', 'high'] },
      { id: 'local-api', label: 'Local API', runtime: 'v4', available: true, status: 'ready', capabilities: { structured: true }, models: [], reasoningLevels: [] },
    ] } }));
    await page.route('**/api/workspace/git/status*', route => route.fulfill({ json: { branch: 'main', files: [] } }));
    await page.route('**/api/workspace/git/worktrees*', route => route.fulfill({ json: [] }));
    await page.route('**/api/workspace/git/checkpoints*', route => route.fulfill({ json: [] }));
    await page.route('**/api/workspace/history*', route => route.fulfill({ json: [] }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`ui-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.getByRole('region', { name: 'Workspace start', exact: true });
    const composer = start.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Preserve this task while I configure the workspace.');
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    await start.getByRole('button', { name: 'Codex model GPT-6.1-Sol', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Choose Codex model', exact: true });
    await expect(popup).toBeInViewport({ ratio: 1 });
    await popup.getByRole('searchbox', { name: 'Search Codex models' }).fill('astra');
    await popup.getByRole('option', { name: 'GPT-6-Astra', exact: true }).click();
    await popup.getByRole('button', { name: /^Reasoning:/ }).click();
    await popup.getByRole('option', { name: 'Low', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('shared-start-picker.png') });
    await popup.getByRole('button', { name: 'Close model settings', exact: true }).click();
    await expect(start.getByRole('button', { name: 'Codex model GPT-6-Astra', exact: true })).toContainText(/low/i);
    await expect(composer).toHaveValue('Preserve this task while I configure the workspace.');

    await start.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Local API', exact: true }).click();
    await start.getByRole('button', { name: 'Local API model Provider default', exact: true }).click();
    const custom = page.getByRole('dialog', { name: 'Choose Local API model', exact: true });
    await custom.getByRole('button', { name: 'Enter custom model ID', exact: true }).click();
    await custom.getByRole('textbox', { name: 'Custom model ID', exact: true }).fill('local/my-model');
    await custom.getByRole('button', { name: 'Use custom model', exact: true }).click();
    await custom.getByRole('button', { name: 'Close model settings', exact: true }).click();
    await expect(start.getByRole('button', { name: 'Local API model local/my-model', exact: true })).toBeVisible();
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();

    if (viewport.width <= 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const navigation = viewport.width <= 768
      ? page.getByRole('dialog', { name: 'Mobile menu', exact: true })
      : page.getByRole('complementary', { name: 'Threads', exact: true });
    await navigation.getByRole('button', { name: 'New terminal', exact: true }).click();
    const launcher = page.getByRole('dialog', { name: 'New terminal', exact: true });
    await expect(launcher).toBeVisible();
    if (viewport.width <= 768) {
      await expect(launcher.getByRole('textbox', { name: 'Search folders' })).toHaveCSS('font-size', '16px');
      const close = launcher.getByRole('button', { name: 'Close folder browser' });
      await expect.poll(async () => { const box = await close.boundingBox(); return Math.min(box!.width, box!.height); }).toBeGreaterThanOrEqual(44);
    }
    await expect(launcher.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0);
    if (viewport.width <= 768) {
      await expect(launcher.getByRole('textbox', { name: 'Search folders' })).toHaveCSS('font-size', '16px');
      const close = launcher.getByRole('button', { name: 'Close folder browser' });
      await expect.poll(async () => { const box = await close.boundingBox(); return Math.min(box!.width, box!.height); }).toBeGreaterThanOrEqual(44);
    }
    await expect(launcher).toHaveJSProperty('inert', false);
    await page.screenshot({ path: testInfo.outputPath('new-thread-setup.png') });
    await page.keyboard.press('Escape');
    await expect(launcher).toHaveCount(0);

    if (viewport.width <= 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const toolsTrigger = page.getByRole('button', { name: 'Project tools', exact: true });
    await toolsTrigger.click();
    const tools = page.locator('.workspace-tools-dialog');
    await expect(tools).toBeInViewport({ ratio: 1 });
    if (viewport.width <= 768) await expect.poll(async () => (await tools.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 20);
    await expect(tools.getByRole('tab')).toHaveCount(9);
    await page.screenshot({ path: testInfo.outputPath('tools-navigation.png') });
    if (viewport.width <= 768) {
      await page.setViewportSize({ width: viewport.width, height: 402 });
      const replay = tools.getByRole('tab', { name: 'Session replay', exact: true });
      await replay.scrollIntoViewIfNeeded();
      await expect(replay).toBeInViewport({ ratio: 1 });
      await expect(tools.getByRole('button', { name: 'Close workspace tools', exact: true })).toBeInViewport({ ratio: 1 });
      await page.setViewportSize(viewport);
    }
    const history = tools.getByRole('tab', { name: 'History', exact: true });
    await history.click();
    if (viewport.width <= 768) await expect(tools.getByRole('button', { name: 'All tools', exact: true })).toBeFocused();
    const search = tools.getByRole('textbox', { name: 'Search saved conversations' });
    await search.fill('Keep this history search');
    if (viewport.width <= 768) {
      await expect(tools.getByRole('tablist')).toBeHidden();
      await page.setViewportSize({ width: viewport.width, height: 402 });
      await expect(search).toHaveCSS('font-size', '16px');
      await expect(search).toBeInViewport({ ratio: 1 });
      await expect(tools).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath('tools-history.png') });
      await page.keyboard.press('Escape');
      await expect(history).toBeFocused();
      await history.click();
      await expect(search).toHaveValue('Keep this history search');
      await tools.getByRole('button', { name: 'All tools', exact: true }).click();
      await expect(history).toBeFocused();
    } else {
      await expect(tools.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
      await expect(history).toHaveAttribute('aria-selected', 'true');
    }
    await tools.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
    await expect(tools).toHaveCount(0);
    await expect(toolsTrigger).toBeFocused();
    if (viewport.width <= 768) await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    await expect(page.locator('#root')).toHaveJSProperty('inert', false);
    await expect(composer).toHaveValue('Preserve this task while I configure the workspace.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    expect(errors).toEqual([]);
  });
  });
}
