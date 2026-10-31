import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const prior = { id: 'ss-prior-start', provider: 'codex', runtime: 'codex', title: 'Earlier investigation', cwd: '/tmp/start-mention-fixture',
  status: 'completed', model: 'gpt-6.1-sol', createdAt: '2026-10-25T10:00:00Z' };
for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
  test(`new-thread suggestions and a held start at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true,
      capabilities: { structured: true }, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }], reasoningLevels: ['high'] }] } }));
    await page.route('**/api/workspace/profile*', route => route.fulfill({ json: { memory: '', skills: [] } }));
    await page.route('**/api/workspace/files?*', route => route.fulfill({ json: { files: ['src/login.js'] } }));
    await page.route('**/api/workspace/skills?*', route => route.fulfill({ json: { skills: [{ name: 'review', path: '/tmp/start-mention-fixture/.skills/review/SKILL.md' }] } }));
    await page.route('**/api/workspace/git/pull-request?*', route => route.fulfill({ json: { pullRequest: { number: 7, title: 'Login fix', url: 'https://github.com/example/repo/pull/7' } } }));
    await page.route('**/api/fs/list**', route => route.fulfill({ json: { path: '/tmp/start-mention-fixture', parent: null, folders: [] } }));
    let starts = 0;
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => {
      if (route.request().method() === 'POST') { starts++; return route.abort('failed'); }
      return route.fulfill({ json: [prior] });
    });
    await page.route(`**/api/structured/sessions/${prior.id}`, route => route.fulfill({ json: prior }));
    await page.route(`**/api/structured/sessions/${prior.id}/approval-capability`, route => route.fulfill({ json: { protocol: 1, mode: 'legacy', outstanding: false } }));
    await page.routeWebSocket(`**/api/structured/sessions/${prior.id}/ws*`, ws => ws.send(JSON.stringify({ __terminal_meta: true,
      type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Earlier work is ready.', messageId: 'prior', turnId: 'turn', seq: 1 } })));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`sm-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('Earlier work is ready.')).toBeVisible();
    const openNewThread = async () => {
      if (viewport.width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('button', { name: 'New thread', exact: true }).click();
    };
    await openNewThread();
    const start = page.getByRole('region', { name: 'Workspace start' });
    const input = start.getByRole('textbox', { name: 'Command composer' });
    await expect(input).toBeVisible();
    const project = start.getByRole('button', { name: 'Project', exact: true });
    if ((await project.getAttribute('title')) !== '/tmp/start-mention-fixture') {
      await project.click();
      const add = page.getByRole('menuitem', { name: /Add project folder/ });
      if (await add.count()) await add.click();
      await page.getByRole('button', { name: 'Open here', exact: true }).click();
    }
    await input.fill('Review @Earlier');
    await page.getByRole('option', { name: /Earlier investigation/ }).click();
    await input.fill('Review @Login');
    await page.getByRole('option', { name: /#7 Login fix/ }).click();
    await input.fill('Review @log');
    await page.getByRole('option', { name: /src\/login.js/ }).click();
    await expect(input).toHaveValue('Review @src/login.js ');
    await input.fill('/review');
    await page.getByRole('option', { name: /\/review/ }).click();
    await expect(input).toHaveValue('Use the "review" skill (instructions: /tmp/start-mention-fixture/.skills/review/SKILL.md). ');
    await expect(start.getByRole('list', { name: 'Attached context' })).toContainText('Earlier investigation');
    await expect(start.getByRole('list', { name: 'Attached context' })).toContainText('#7 Login fix');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`start-mentions-${viewport.width}.png`) });
    await start.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(start.getByText(/This task may have started/)).toBeVisible();
    await expect(start.getByRole('list', { name: 'Attached context' })).toContainText('Earlier investigation');
    await expect.poll(() => starts).toBe(1);
    await page.reload();
    await expect(page.getByText('Earlier work is ready.')).toBeVisible();
    await openNewThread();
    await expect(start.getByText(/This task may have started/)).toBeVisible();
    await expect(start.getByRole('list', { name: 'Attached context' })).toContainText('#7 Login fix');
    await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
    expect(starts).toBe(1);
  });
}
