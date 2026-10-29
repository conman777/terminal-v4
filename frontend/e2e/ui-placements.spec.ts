import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const session = { id: 'ss-placement-fixture', provider: 'codex', runtime: 'codex', title: 'Review the interface placements',
  cwd: '/tmp/placement-fixture', status: 'completed', model: 'fixture-model', reasoning: 'high',
  createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' };

for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 684 }, { width: 820, height: 900 }, { width: 1440, height: 900 }]) {
  const mobile = viewport.width <= 768;
  test.describe(`${viewport.width}px placements`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: viewport.width <= 820 });
    test('keeps thread controls, project navigation and composer actions in their own places', async ({ page }, testInfo) => {
      const errors: string[] = [];
      const writes: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        const branchLookup = request.method() === 'POST' && new URL(request.url()).pathname === '/api/workspace/git/branches';
        if (request.method() !== 'GET' && !branchLookup && /\/api\/(workspace|structured)/.test(request.url())) writes.push(request.url());
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: ['high'] }] } }));
      await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
      await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
      await page.route('**/api/workspace-browser/approvals*', route => route.fulfill({ json: { requests: [] } }));
      await page.route('**/api/workspace/git/status*', route => route.fulfill({ json: { branch: 'main', files: [] } }));
      await page.route('**/api/workspace/git/branches', route => route.fulfill({ json: { branches: {} } }));
      await page.route('**/api/workspace/git/worktrees*', route => route.fulfill({ json: [] }));
      await page.route('**/api/workspace/git/checkpoints*', route => route.fulfill({ json: [] }));
      await page.route('**/api/workspace/profile*', route => route.fulfill({ json: { memory: 'Fixture project context', skills: [] } }));
      await page.route('**/api/workspace/tasks*', route => route.fulfill({ json: { tasks: [], schedules: [] } }));
      await page.route('**/api/fs/list*', route => route.fulfill({ json: { path: session.cwd, parent: '/tmp', folders: [], files: [] } }));
      await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
        for (const event of [
          { type: 'message_completed', role: 'user', content: 'Check the interface.', messageId: 'user', turnId: 'turn', seq: 1 },
          { type: 'message_completed', role: 'assistant', content: 'This is a synthetic placement test workspace.', messageId: 'assistant', turnId: 'turn', seq: 2 },
          { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
        ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`placements-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await expect(page.getByText('This is a synthetic placement test workspace.', { exact: true })).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
      await composer.fill('Preserve this draft through navigation.');
      const composerShell = page.locator('.workspace-composer');
      await expect(composerShell.getByRole('button', { name: 'Project tools', exact: true })).toHaveCount(0);
      await expect(composerShell.getByRole('button', { name: 'Workspace knowledge', exact: true })).toHaveCount(0);
      await expect(page.locator('.status-composer-footer-row')).toHaveCount(0);
      if (mobile) await composerShell.getByLabel('More composer actions', { exact: true }).click();
      const context = composerShell.getByRole('button', { name: 'Session context', exact: true });
      await context.click();
      const contextPanel = page.getByRole('dialog', { name: 'Session context', exact: true });
      await expect(contextPanel).toBeInViewport({ ratio: 1 });
      await expect(contextPanel.getByText(session.cwd, { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(context).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('placements.png') });

      if (mobile) {
        await expect(page.locator('.remote-environment-bar')).toHaveCount(0);
        const header = page.locator('.mobile-header');
        expect((await header.boundingBox())!.height).toBe(52);
        const terminalId = 'placement-companion';
        const terminalRequests: unknown[] = [];
        await page.route('**/api/terminal', async route => {
          if (route.request().method() !== 'POST') return route.fallback();
          terminalRequests.push(route.request().postDataJSON());
          return route.fulfill({ json: { session: { id: terminalId, cwd: session.cwd, isActive: true } } });
        });
        await page.route(`**/api/terminal/${terminalId}/thread`, route => route.fulfill({ json: { thread: { companionOf: session.id } } }));
        await page.routeWebSocket(`**/api/terminal/${terminalId}/ws*`, () => {});
        await header.getByRole('button', { name: 'Show thread terminal', exact: true }).click();
        const terminal = page.getByRole('region', { name: 'Thread terminal', exact: true });
        await expect(terminal).toBeVisible();
        await expect(terminal.locator('.terminal-chat')).toBeVisible();
        await expect(terminal.getByRole('tab', { name: 'Terminal 1', exact: true })).toBeVisible();
        expect(terminalRequests).toEqual([{ cwd: session.cwd, title: 'Terminal', companionOf: session.id, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) }]);
        const terminalBounds = await terminal.boundingBox();
        expect(terminalBounds!.height).toBeGreaterThan(80);
        await page.screenshot({ path: testInfo.outputPath('thread-terminal.png') });
        await header.getByRole('button', { name: 'Hide thread terminal', exact: true }).click();
        await expect(terminal).toHaveCount(0);
        await expect(composer).toHaveValue('Preserve this draft through navigation.');
        const git = header.getByRole('button', { name: 'Git', exact: true });
        await expect(git).toBeEnabled();
        await git.click();
        const gitDialog = page.getByRole('dialog', { name: 'Git & worktrees', exact: true });
        await expect(gitDialog).toBeInViewport({ ratio: 1 });
        await expect(gitDialog.getByRole('button', { name: 'Refresh Git' })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('direct-git.png') });
        await gitDialog.getByRole('button', { name: 'Close workspace tools' }).click();
        await expect(git).toBeFocused();
        await header.getByRole('button', { name: 'Files', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Files', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close files', exact: true }).click();
        await header.getByRole('button', { name: 'More actions', exact: true }).click();
        const threadActions = header.getByRole('group', { name: 'More actions', exact: true });
        await expect(threadActions.getByRole('button', { name: 'Rename thread' })).toBeVisible();
        await expect(threadActions.getByRole('button', { name: 'Light mode' })).toHaveCount(0);
        await expect(threadActions.getByRole('button', { name: 'Process Manager' })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await header.getByRole('button', { name: 'Menu', exact: true }).click();
      }

      const navigation = mobile ? page.getByRole('dialog', { name: 'Mobile menu', exact: true }) : page.getByRole('complementary', { name: 'Threads', exact: true });
      if (mobile) {
        const server = navigation.getByRole('button', { name: 'Switch server, This server', exact: true });
        await expect(server).toBeInViewport({ ratio: 1 });
        await server.click();
        await expect(page.getByRole('dialog', { name: 'Switch server', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close server chooser', exact: true }).click();
        await expect(server).toBeFocused();
      }
      const knowledge = navigation.getByRole('button', { name: 'Workspace knowledge', exact: true });
      await knowledge.click();
      const knowledgeDialog = page.getByRole('dialog', { name: 'Workspace knowledge', exact: true });
      await expect(knowledgeDialog).toBeVisible();
      const insert = knowledgeDialog.getByRole('button', { name: 'Add to prompt', exact: true });
      await insert.click();
      await expect(knowledgeDialog).toHaveCount(0);
      if (mobile) await navigation.getByRole('button', { name: 'Close menu', exact: true }).click();
      await expect(composer).toHaveValue(/Fixture project context[\s\S]*Preserve this draft through navigation\./);
      if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await navigation.getByRole('button', { name: 'Project tools', exact: true }).click();
      const tools = page.locator('.workspace-tools-dialog');
      await tools.getByRole('tab', { name: 'Tasks & schedules', exact: true }).click();
      await tools.getByRole('button', { name: 'Use latest answer', exact: true }).click();
      await expect(tools.getByRole('textbox', { name: 'Task prompt', exact: true })).toHaveValue('This is a synthetic placement test workspace.');
      await tools.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
      if (mobile) await navigation.getByRole('button', { name: 'Close menu', exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      expect(errors).toEqual([]);
      expect(writes).toEqual([]);
    });
  });
}
