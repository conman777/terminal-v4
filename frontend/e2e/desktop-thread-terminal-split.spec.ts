import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_TERMINAL_WORKSPACE,
  'Requires an isolated local backend and disposable terminal workspace.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1280, height: 900 } });

test('keeps real thread terminals alive while switching and restoring a stacked split', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`split-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
  const threadId = await page.evaluate(async cwd => {
    const response = await fetch('/api/structured/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` },
      body: JSON.stringify({ cwd, provider: 'deepseek', model: 'deepseek-chat', title: 'Stacked terminal fixture' }),
    });
    if (!response.ok) throw new Error(`Could not create fixture conversation: ${response.status}`);
    return (await response.json()).id;
  }, process.env.E2E_TERMINAL_WORKSPACE!);
  await page.reload();
  await page.getByRole('button', { name: 'Select Stacked terminal fixture', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Keep this draft');
  const toggle = page.getByRole('button', { name: 'Toggle terminal drawer', exact: true });
  await toggle.click();
  const terminal = page.getByRole('region', { name: 'Thread terminal', exact: true });
  await expect(terminal.locator('.xterm')).toHaveCount(1);
  const companions = () => page.evaluate(async parent => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
    const data = await (await fetch('/api/terminal', { headers })).json();
    return data.sessions.filter((item: any) => item.thread?.companionOf === parent).map((item: any) => item.id);
  }, threadId);
  const output = (id: string) => page.evaluate(async sessionId => {
    const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` };
    const response = await fetch(`/api/terminal/${sessionId}/history`, { headers });
    return JSON.stringify((await response.json()).history);
  }, id);
  await expect.poll(async () => (await companions()).length).toBe(1);
  const firstId = (await companions())[0];
  await terminal.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type("printf 'first-pane-ready\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => output(firstId)).toContain('first-pane-ready');
  const firstTerminal = await terminal.locator('.xterm').first().elementHandle();
  await terminal.getByRole('button', { name: 'Split terminal', exact: true }).click();
  await expect(terminal.locator('.xterm')).toHaveCount(2);
  await expect.poll(async () => (await companions()).length).toBe(2);
  const secondId = (await companions()).find((id: string) => id !== firstId)!;
  await terminal.getByRole('button', { name: 'Stack terminals', exact: true }).click();
  const separator = terminal.getByRole('separator', { name: 'Resize terminal split', exact: true });
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
  expect(await firstTerminal!.evaluate(node => node.isConnected)).toBe(true);
  const panes = terminal.locator('.thread-terminal-pane');
  const top = await panes.nth(0).boundingBox(), bottom = await panes.nth(1).boundingBox();
  expect(bottom!.y).toBeGreaterThan(top!.y + top!.height - 1);
  await separator.focus();
  await page.keyboard.press('ArrowDown');
  await expect(separator).toHaveAttribute('aria-valuenow', '55');
  const divider = (await separator.boundingBox())!;
  const splitBounds = (await terminal.locator('.thread-terminal-panes').boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(divider.x + divider.width / 2, splitBounds.y + splitBounds.height * 0.4);
  await page.mouse.up();
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(39);
  await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(41);
  await terminal.locator('.xterm-helper-textarea').nth(1).focus();
  await page.keyboard.type("printf 'second-pane-ready\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => output(secondId)).toContain('second-pane-ready');
  await expect(composer).toHaveValue('Keep this draft');
  await expect.poll(() => page.evaluate(id => Object.entries(localStorage).some(([key, value]) => key.includes('threadDrawerLayout:v1:') && key.includes(id) && value.includes('"direction":"stacked"')), threadId)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('stacked-terminal.png'), animations: 'disabled' });
  await toggle.click();
  await toggle.click();
  await expect(terminal.getByRole('separator', { name: 'Resize terminal split' })).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(terminal.locator('.xterm')).toHaveCount(2);
  await expect(composer).toHaveValue('Keep this draft');
  await page.reload();
  await page.getByRole('button', { name: 'Select Stacked terminal fixture', exact: true }).click();
  await toggle.click();
  await expect(terminal.getByRole('separator', { name: 'Resize terminal split' })).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(terminal.locator('.xterm')).toHaveCount(2);
  expect((await companions()).sort()).toEqual([firstId, secondId].sort());
  await expect(composer).toHaveValue('Keep this draft');
  await terminal.getByRole('button', { name: 'Show terminals side by side' }).click();
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical');
});
