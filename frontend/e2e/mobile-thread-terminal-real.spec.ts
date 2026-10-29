import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_TERMINAL_WORKSPACE,
  'Requires an isolated local backend and disposable terminal workspace.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, isMobile: true, hasTouch: true });

for (const width of [320, 390]) {
  test(`a mobile thread terminal accepts real PTY input and preserves the conversation at ${width}px`, async ({ page }, testInfo) => {
    const cwd = process.env.E2E_TERMINAL_WORKSPACE!;
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`tt-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
    const thread = await page.evaluate(async project => {
      const create = async (title: string) => {
        const response = await fetch('/api/structured/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` },
          body: JSON.stringify({ cwd: project, provider: 'deepseek', model: 'deepseek-chat', title }),
        });
        if (!response.ok) throw new Error(`Could not create fixture conversation: ${response.status}`);
        return response.json();
      };
      const first = await create('Terminal fixture conversation');
      await create('Second fixture conversation');
      return first;
    }, cwd);
    await page.reload();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Terminal fixture conversation/ }).click();
    await expect(page.locator('.mobile-header')).toContainText('Terminal fixture conversation');
    const title = page.getByRole('button', { name: 'Show full thread title: Terminal fixture conversation', exact: true });
    const headerControls = [page.getByRole('button', { name: 'Menu', exact: true }), title,
      page.getByRole('button', { name: 'Show thread terminal', exact: true }),
      page.getByRole('button', { name: 'Files', exact: true }), page.getByRole('button', { name: 'Git', exact: true }),
      page.getByRole('button', { name: 'More actions', exact: true })];
    for (const control of headerControls) {
      const bounds = await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await title.click();
    const titlePanel = page.getByRole('dialog', { name: 'Thread title', exact: true });
    await expect(titlePanel).toBeInViewport({ ratio: 1 });
    await expect(titlePanel.getByText('Terminal fixture conversation', { exact: true })).toBeVisible();
    await expect(titlePanel.getByText(thread.cwd, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('full-thread-title.png'), animations: 'disabled' });
    await titlePanel.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(title).toBeFocused();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep the conversation draft');
    await page.getByRole('button', { name: 'Show thread terminal', exact: true }).click();
    const terminal = page.getByRole('region', { name: 'Thread terminal' });
    await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
    await expect.poll(async () => page.evaluate(async parent => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const response = await fetch('/api/terminal', { headers });
      const data = await response.json();
      return data.sessions.find((item: any) => item.thread?.companionOf === parent)?.id || null;
    }, thread.id)).not.toBeNull();
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'thread-%s\\n' pty-visible");
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async parent => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const inventory = await (await fetch('/api/terminal', { headers })).json();
      const target = inventory.sessions.find((item: any) => item.thread?.companionOf === parent);
      if (!target) return '';
      const history = await (await fetch(`/api/terminal/${target.id}/history`, { headers })).json();
      return JSON.stringify(history.history);
    }, thread.id)).toContain('thread-pty-visible');
    await expect(terminal.locator('.xterm-rows')).toContainText('thread-pty-visible');
    await expect(composer).toHaveValue('Keep the conversation draft');
    await page.screenshot({ path: testInfo.outputPath('real-thread-terminal.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Hide thread terminal', exact: true }).click();
    await expect(terminal).toHaveCount(0);
    await expect(composer).toHaveValue('Keep the conversation draft');
    await page.getByRole('button', { name: 'Show thread terminal', exact: true }).click();
    await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.setViewportSize({ width, height: 402 });
    await expect(terminal).toBeInViewport();
    await page.setViewportSize({ width, height: 720 });
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Second fixture conversation/ }).click();
    await expect(page.locator('.mobile-header')).toContainText('Second fixture conversation');
    await expect(terminal).toHaveCount(0);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Terminal fixture conversation/ }).click();
    await expect(composer).toHaveValue('Keep the conversation draft');
    await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
    const companions = await page.evaluate(async parent => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const data = await (await fetch('/api/terminal', { headers })).json();
      return data.sessions.filter((item: any) => item.thread?.companionOf === parent).map((item: any) => item.id);
    }, thread.id);
    expect(companions).toHaveLength(1);

    await page.reload();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Terminal fixture conversation/ }).click();
    await expect(composer).toHaveValue('Keep the conversation draft');
    await page.getByRole('button', { name: 'Show thread terminal', exact: true }).click();
    await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('sleep 1; exit');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Hide thread terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const inventory = await (await fetch('/api/terminal', { headers })).json();
      return inventory.sessions.find((item: any) => item.id === id)?.isActive;
    }, companions[0])).toBe(false);

    await page.reload();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Terminal fixture conversation/ }).click();
    await expect(composer).toHaveValue('Keep the conversation draft');
    await page.getByRole('button', { name: 'Show thread terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(async id => {
      const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
      const inventory = await (await fetch('/api/terminal', { headers })).json();
      return inventory.sessions.find((item: any) => item.id === id)?.isActive;
    }, companions[0])).toBe(true);
    await terminal.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf 'restored-%s\\n' thread-pty");
    await page.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('restored-thread-pty');
    await page.screenshot({ path: testInfo.outputPath('restored-thread-terminal.png'), animations: 'disabled' });
  });
}
