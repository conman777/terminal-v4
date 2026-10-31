import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const fixture of [{ width: 320, height: 640, mobile: true }, { width: 390, height: 844, mobile: true }, { width: 1280, height: 800, mobile: false }]) {
  test.describe(`${fixture.width}px`, () => {
    test.use({ viewport: { width: fixture.width, height: fixture.height }, isMobile: fixture.mobile, hasTouch: fixture.mobile });
    test('keeps the first task usable and setup details available', async ({ page }, testInfo) => {
      const checks = [
        { id: 'data', label: 'Data folder', ok: true, required: true, detail: 'Ready' },
        { id: 'git', label: 'Git', ok: true, required: true, detail: 'Ready' },
        { id: 'codex', label: 'Codex', ok: false, required: false, detail: 'Not found', fix: 'Install Codex.' },
        { id: 'claude', label: 'Claude Code', ok: false, required: false, detail: 'Not found', fix: 'Install Claude.' },
        { id: 'gh', label: 'GitHub CLI', ok: false, required: false, detail: 'Not found', fix: 'Install GitHub CLI.' },
      ];
      let checksRun = 0;
      await page.route('**/api/system/doctor', route => { checksRun++; return route.fulfill({ json: { ready: false, agentReady: false, checks } }); });
      await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, capabilities: { structured: true },
        models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'] }] } }));
      await page.route('**/api/workspace/profile*', route => route.fulfill({ json: { memory: '', skills: [] } }));
      await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/setup-welcome-fixture', parent: null, folders: [] } }));
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`setup-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const start = page.getByRole('region', { name: 'Workspace start' });
      const notice = start.getByRole('region', { name: 'Setup check' });
      await expect(notice).toContainText('Other configured agents may still work.');
      const details = notice.getByRole('button', { name: 'Setup details' });
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await expect(notice.getByText('Install Codex.')).toBeHidden();
      const bounds = await notice.boundingBox();
      expect(bounds!.height).toBeLessThan(180);
      await expect(start.getByRole('textbox', { name: 'Command composer' })).toBeInViewport();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (fixture.mobile) {
        for (const control of [details, notice.getByRole('button', { name: 'Dismiss' })]) {
          const box = await control.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`setup-${fixture.width}.png`) });
      await details.click();
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await expect(notice.getByText('Install Codex.')).toBeVisible();
      await notice.getByRole('button', { name: 'Check again' }).click();
      await expect.poll(() => checksRun).toBe(2);
      await details.click();
      await notice.getByRole('button', { name: 'Dismiss' }).click();
      await expect(notice).toHaveCount(0);
      await page.reload();
      await expect(start.getByRole('textbox', { name: 'Command composer' })).toBeVisible();
      await expect(notice).toHaveCount(0);
      await start.getByRole('button', { name: 'Project', exact: true }).click();
      await page.getByRole('button', { name: 'Open here', exact: true }).click();
      const input = start.getByRole('textbox', { name: 'Command composer' });
      if (fixture.mobile) await expect(input).not.toBeFocused();
      await input.fill('Build the first feature');
      await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    });
  });
}
