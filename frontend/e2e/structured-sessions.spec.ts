import { test, expect } from '@playwright/test';
import {
  deleteStructuredSessionsByTitle,
  loginIfNeeded,
  updateUserSettings,
} from './test-helpers';

const WORKSPACE_PATH =
  process.env.E2E_WORKSPACE_PATH
  || 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4';

function getProjectName(folderPath: string) {
  return folderPath.replace(/[\\/]+$/, '').split(/[/\\]/).filter(Boolean).pop() || folderPath;
}

test.describe('Structured sessions', () => {
  test('creates, renames, and pins a structured thread that survives reload', async ({ page, request }) => {
    const workspaceName = getProjectName(WORKSPACE_PATH);
    const initialTitle = `Structured E2E ${Date.now()}`;
    const renamedTitle = `${initialTitle} Renamed`;
    const terminalRouteConsoleNoise: string[] = [];

    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('/api/terminal/ss-')) {
        terminalRouteConsoleNoise.push(`${message.type()}: ${text}`);
      }
    });

    await deleteStructuredSessionsByTitle(request, [initialTitle, renamedTitle]);
    await updateUserSettings(request, {
      recentFolders: [WORKSPACE_PATH],
      sidebarProjects: [{ path: WORKSPACE_PATH, name: workspaceName }]
    });

    await page.addInitScript(({ workspacePath, projectName }) => {
      localStorage.setItem('recentFolders', JSON.stringify([workspacePath]));
      localStorage.setItem('sidebarProjects', JSON.stringify([{ path: workspacePath, name: projectName }]));
      localStorage.removeItem('lastActiveSession');
    }, { workspacePath: WORKSPACE_PATH, projectName: workspaceName });

    try {
      await loginIfNeeded(page, request);

      const sidebar = page.locator('.threads-sidebar');
      await expect(sidebar).toBeVisible({ timeout: 10000 });

      await page.locator('.ts-new-thread-btn').click();
      const folderModal = page.locator('.folder-browser-modal');
      await expect(folderModal).toBeVisible({ timeout: 10000 });

      const aiSelect = page.locator('#folder-browser-ai-select');
      await expect(aiSelect).toBeVisible();
      await aiSelect.selectOption('claude');

      const tabNameInput = page.locator('#folder-browser-tabname-input');
      await tabNameInput.fill(initialTitle);
      await page.getByRole('button', { name: 'Open here' }).click();

      const activeThread = page.locator('.threads-session-item.active').filter({
        has: page.locator('.threads-session-topic', { hasText: initialTitle })
      }).first();
      await expect(activeThread).toBeVisible({ timeout: 15000 });
      await expect(page.locator('textarea[aria-label="Command composer"]').first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.status-ai-selector-label').first()).toHaveText(/Claude Code/i, { timeout: 15000 });

      await activeThread.hover();
      await activeThread.getByRole('button', { name: 'Rename session' }).click();
      const renameInput = page.locator('.threads-session-edit').first();
      await expect(renameInput).toBeVisible({ timeout: 10000 });
      await renameInput.fill(renamedTitle);
      await renameInput.press('Enter');

      const renamedThread = page.locator('.threads-session-item').filter({
        has: page.locator('.threads-session-topic', { hasText: renamedTitle })
      }).first();
      await expect(renamedThread).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.threads-session-topic', { hasText: renamedTitle }).first()).toBeVisible({ timeout: 15000 });

      await renamedThread.hover();
      await renamedThread.locator('button[title="Pin"]').first().click();

      const pinnedSection = page.locator('.threads-section').filter({
        has: page.locator('.threads-section-header', { hasText: 'Pinned' })
      }).first();
      await expect(pinnedSection).toBeVisible({ timeout: 10000 });
      await expect(
        pinnedSection.locator('.threads-session-item .threads-session-topic', { hasText: renamedTitle }).first()
      ).toBeVisible({ timeout: 15000 });

      await page.reload();
      await expect(sidebar).toBeVisible({ timeout: 10000 });
      await expect(
        pinnedSection.locator('.threads-session-item .threads-session-topic', { hasText: renamedTitle }).first()
      ).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.threads-session-topic', { hasText: renamedTitle }).first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator('textarea[aria-label="Command composer"]').first()).toBeVisible({ timeout: 15000 });
      expect(terminalRouteConsoleNoise).toEqual([]);
    } finally {
      await deleteStructuredSessionsByTitle(request, [initialTitle, renamedTitle]).catch(() => {});
    }
  });
});
