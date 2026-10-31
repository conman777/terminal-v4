import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1' || !process.env.E2E_PROJECT_ROOT,
  'Requires an isolated local backend and disposable project.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const fixture of [{ width: 320, height: 720, mobile: true }, { width: 1280, height: 800, mobile: false }]) {
  test(`opens an owned file from a conversation at ${fixture.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (value: string) => { (window as any).__copiedFixtureLocation = value; } } }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`file-link-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
    const root = process.env.E2E_PROJECT_ROOT!;
    const session = await page.evaluate(async cwd => {
      const response = await fetch('/api/structured/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` },
        body: JSON.stringify({ cwd, provider: 'deepseek', model: 'deepseek-chat', title: 'File link fixture' }),
      });
      if (!response.ok) throw new Error(`Could not create fixture conversation: ${response.status}`);
      return response.json();
    }, root);
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      for (const event of [
        { type: 'message_completed', role: 'user', content: 'Review the project.', messageId: 'prompt', turnId: 'turn', seq: 1 },
        { type: 'tool_started', toolName: 'run_command', toolCallId: 'check-one', toolInput: { command: 'check' }, turnId: 'turn', seq: 2 },
        { type: 'tool_completed', toolName: 'run_command', toolCallId: 'check-one', result: 'sample.js:2:3', turnId: 'turn', seq: 3 },
        { type: 'tool_started', toolName: 'run_command', toolCallId: 'check-two', toolInput: { command: 'check other' }, turnId: 'turn', seq: 4 },
        { type: 'tool_completed', toolName: 'run_command', toolCallId: 'check-two', result: 'Other output', turnId: 'turn', seq: 5 },
        { type: 'message_completed', role: 'assistant', content: `Review [source](${root}/sample.js#L2-L3).`, messageId: 'answer', turnId: 'turn', seq: 6 },
        { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 7 },
      ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    await page.reload();
    if (fixture.mobile) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /File link fixture/ }).click();
    } else await page.getByRole('button', { name: 'Select File link fixture', exact: true }).click();
    const link = page.getByRole('button', { name: 'Open source at line 2', exact: true });
    await link.click();
    const dialog = page.getByRole('dialog', { name: 'File preview: sample.js, line 2', exact: true });
    await expect(dialog.getByText('const target = true;')).toHaveAttribute('aria-current', 'true');
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Copy file location' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Location copied');
    expect(await page.evaluate(() => (window as any).__copiedFixtureLocation)).toBe(`${root}/sample.js:2`);
    await page.screenshot({ path: testInfo.outputPath(`file-preview-${fixture.width}.png`), animations: 'disabled' });
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error('fixture denied'); };
      document.execCommand = () => false;
    });
    await dialog.getByRole('button', { name: 'Copy file location' }).click();
    await expect(dialog.getByRole('textbox', { name: 'File location' })).toHaveValue(`${root}/sample.js:2`);
    await expect(dialog.getByRole('status')).toContainText('Could not copy');
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`file-preview-fallback-${fixture.width}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Next lines' }).click();
    const nextPage = page.getByRole('dialog', { name: 'File preview: sample.js, line 17', exact: true });
    await expect(nextPage.getByText('// fixture line 24')).toBeVisible();
    await expect(nextPage.getByText('Lines 10–24 of 35')).toBeVisible();
    await expect(nextPage).toBeInViewport({ ratio: 1 });
    await nextPage.getByRole('button', { name: 'Previous lines' }).click();
    await expect(dialog.getByText('const target = true;')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(link).toBeFocused();
    await page.getByRole('button', { name: /^Worked/ }).click();
    await page.getByText('Ran 2 commands').click();
    await page.getByRole('button', { name: /Run command\s+check\s+Completed/ }).click();
    const toolLink = page.getByRole('button', { name: 'Open sample.js:2:3 at line 2' });
    await toolLink.click();
    await expect(dialog.getByText('const target = true;')).toHaveAttribute('aria-current', 'true');
    await page.screenshot({ path: testInfo.outputPath(`tool-file-preview-${fixture.width}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Show in Files' }).click();
    await expect(dialog).toHaveCount(0);
    const files = page.getByRole('region', { name: 'Files', exact: true });
    await expect(files.getByText('Project files · read-only')).toBeVisible();
    await expect(files.getByRole('button', { name: 'Select file sample.js' })).toHaveAttribute('aria-pressed', 'true');
    await expect(files.getByRole('button', { name: 'Go up' })).toBeDisabled();
    await expect(files.getByRole('button', { name: 'New folder' })).toHaveCount(0);
    await expect(files.getByRole('button', { name: 'Download sample.js' })).toHaveCount(0);
    await expect(files).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`project-files-${fixture.width}.png`), animations: 'disabled' });
    const openFile = files.getByRole('button', { name: 'Preview sample.js' });
    if (fixture.mobile) expect((await openFile.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await openFile.click();
    const firstLine = page.getByRole('dialog', { name: 'File preview: sample.js, line 1', exact: true });
    await expect(firstLine.getByText('const first = true;')).toHaveAttribute('aria-current', 'true');
    await expect(firstLine).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`project-file-open-${fixture.width}.png`), animations: 'disabled' });
    await firstLine.getByRole('button', { name: 'Next lines' }).click();
    const openedNext = page.getByRole('dialog', { name: 'File preview: sample.js, line 16', exact: true });
    await expect(openedNext.getByText('// fixture line 23')).toBeVisible();
    if (fixture.mobile) expect((await openedNext.getByRole('button', { name: 'Previous lines' }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');
    await expect(openedNext).toHaveCount(0);
    await expect(openFile).toBeFocused();
    await files.getByRole('button', { name: 'Preview empty.txt' }).click();
    const empty = page.getByRole('dialog', { name: 'File preview: empty.txt, line 1', exact: true });
    await expect(empty.getByText('This file is empty.')).toBeVisible();
    await expect(empty).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await files.getByRole('button', { name: 'Close files' }).click();
  });
}
