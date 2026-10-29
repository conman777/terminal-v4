import { test, expect } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 1221, height: 1023 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`workspace start has clear actions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/fs/list**', route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      return route.fulfill({ json: path?.endsWith('/Developer')
        ? { path: '/tmp/workspace-start-fixture/Developer', parent: '/tmp/workspace-start-fixture', folders: ['api', 'web'] }
        : { path: '/tmp/workspace-start-fixture', parent: null, folders: ['Developer', 'docs', 'src'] } });
    });
    const catalog = { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', capabilities: { structured: true }, available: true, status: 'ready', help: 'Uses local Codex.', models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }] };
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: catalog }));
    await page.route('**/api/workspace/profile*', route => route.fulfill({ json: { memory: '', skills: [] } }));
    await page.route('**/api/files/attachment', route => route.fulfill({ json: { path: '/tmp/synthetic-attachment.txt' } }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`start-ui-${viewport.width}-${Date.now()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.locator('section[aria-label="Workspace start"]');
    await expect(start.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await expect(start.getByRole('button', { name: 'Workspace tools' })).toHaveCount(0);
    await expect(start.getByRole('button', { name: 'Workspace knowledge' })).toHaveCount(0);
    await expect(start.getByPlaceholder('Ask Codex to do anything…')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.width > 768) {
      await expect(page.locator('header.desktop-header')).toHaveCount(0);
      const panel = await page.locator('.pro-sidebar-panel').boundingBox();
      const utilities = await page.locator('.pro-sidebar-footer').boundingBox();
      expect(utilities!.y).toBeGreaterThan(panel!.y + panel!.height - 1);
      expect(Math.abs(utilities!.x - panel!.x)).toBeLessThan(1);
      const sidebar = await page.locator('.pro-sidebar').boundingBox();
      const settings = await page.locator('.pro-sidebar').getByRole('button', { name: 'Settings', exact: true }).boundingBox();
      expect(settings!.x + settings!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
      await page.getByRole('button', { name: 'Workspace apps' }).click();
      await expect(page.getByRole('menu', { name: 'Workspace apps' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pro-sidebar-rail')).toHaveCount(0);
      const composer = await start.locator('.status-composer-shell').boundingBox();
      const surface = await start.boundingBox();
      expect(Math.abs(composer!.x + composer!.width / 2 - surface!.x - surface!.width / 2)).toBeLessThan(2);
    }
    await start.getByPlaceholder('Ask Codex to do anything…').fill('Review this project and explain how it works');
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Choose project' })).toBeVisible();
    const folderSearch = page.getByRole('textbox', { name: 'Search folders' });
    await folderSearch.fill('dev');
    await page.getByRole('button', { name: 'Developer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'api', exact: true })).toBeVisible();
    await expect(folderSearch).toHaveValue('');
    await page.screenshot({ path: `/tmp/terminal-v4-folder-navigation-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await folderSearch.fill('missing');
    await expect(page.getByText('No folders match “missing”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear folder search' }).click();
    await expect(page.getByRole('button', { name: 'web', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Go up', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Developer', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    await expect(page.locator('.pro-folder-browser')).toHaveCount(0);
    await expect(start.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('title', '/tmp/workspace-start-fixture');
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    const chooser = page.waitForEvent('filechooser');
    await start.getByRole('button', { name: 'Attach file' }).click();
    await (await chooser).setFiles({ name: 'synthetic-attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment') });
    await expect(start.getByRole('button', { name: 'Remove synthetic-attachment.txt' })).toBeVisible();
    await expect(start.getByPlaceholder('Ask Codex to do anything…')).toHaveValue('Review this project and explain how it works');
    await start.getByRole('button', { name: 'Remove synthetic-attachment.txt' }).click();
    await expect(start.getByRole('button', { name: 'Remove synthetic-attachment.txt' })).toHaveCount(0);
    await start.getByRole('button', { name: 'Codex model GPT-6.1-Sol', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Choose Codex model' })).toBeVisible();
    await page.getByRole('option', { name: 'GPT-6.1-Sol', exact: true }).click();
    await page.getByRole('button', { name: /^Reasoning:/ }).click();
    await page.getByRole('option', { name: 'High', exact: true }).click();
    await page.getByRole('button', { name: 'Close model settings', exact: true }).click();
    await expect(page.locator('.pro-folder-browser')).toHaveCount(0);
    await expect(start.getByPlaceholder('Ask Codex to do anything…')).toHaveValue('Review this project and explain how it works');
    await page.screenshot({ path: `/tmp/terminal-v4-start-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    if (viewport.width === 1221) await start.locator('.workspace-start-composer-shell').screenshot({ path: '/tmp/terminal-v4-composer-controls.png', animations: 'disabled' });
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(start.getByRole('menu', { name: 'Project', exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/terminal-v4-project-menu-${viewport.width}.png`, fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    if (viewport.width > 768) {
      await page.getByRole('button', { name: 'Minimize sidebar', exact: true }).click();
      await expect(page.locator('.pro-sidebar')).toHaveClass(/collapsed/);
      await page.locator('.pro-sidebar').getByRole('button', { name: 'Show threads', exact: true }).click();
      await expect(page.locator('.pro-sidebar-panel')).toBeVisible();
      await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
      await page.getByRole('button', { name: 'Toggle Theme', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: '/tmp/terminal-v4-start-light.png', fullPage: true, animations: 'disabled' });
      await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
      await page.getByRole('button', { name: 'Toggle Theme', exact: true }).click();
    } else {
      catalog.agents.push({ id: 'lmstudio', label: 'LM Studio', runtime: 'v4', capabilities: { structured: true }, available: true, status: 'ready', help: '', models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: [] });
      await page.reload();
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Agent', exact: true });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      await menu.getByRole('menuitemradio', { name: 'LM Studio', exact: true }).click();
      await expect(page.getByPlaceholder('Ask LM Studio to do anything…')).toBeVisible();
    }
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 1440, height: 900 }]) {
  test(`unconfirmed text-only start remains held after reload at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/workspace-start-fixture', parent: null, folders: [] } }));
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', capabilities: { structured: true }, available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: ['high'] }] } }));
    let starts = 0;
    await page.route('**/api/structured/sessions', route => {
      if (route.request().method() !== 'POST') return route.continue();
      starts += 1;
      return route.abort('failed');
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`hold-${viewport.width}-${Date.now()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const start = page.getByRole('region', { name: 'Workspace start' });
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Open here', exact: true }).click();
    const composer = start.getByRole('textbox', { name: 'Command composer' });
    await composer.fill('Keep this task until the start is confirmed.');
    await start.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(start.getByText(/This task may have started/)).toBeVisible();
    await expect(composer).toHaveValue('Keep this task until the start is confirmed.');
    await expect.poll(() => starts).toBe(1);
    await page.reload();
    await expect(start.getByText(/This task may have started/)).toBeVisible();
    await expect(start.getByText('Project selected. Describe your task above, then send to start.')).toHaveCount(0);
    await expect(composer).toHaveValue('Keep this task until the start is confirmed.');
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
    expect(starts).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('held-start.png'), animations: 'disabled' });
  });
}
