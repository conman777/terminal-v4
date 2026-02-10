import { test, expect } from '@playwright/test';
import { loginIfNeeded, openPreviewPanel } from './test-helpers';

const baseUrl = process.env.BASE_URL || 'http://localhost:3020';

async function openWebContainerToolsMenu(page) {
  await openPreviewPanel(page);

  const toolsButton = page.getByRole('button', { name: 'More browser tools' }).first();
  if (!(await toolsButton.isVisible({ timeout: 3000 }).catch(() => false))) {
    return null;
  }

  await toolsButton.click();
  const toggleItem = page.locator('.preview-tools-menu-item').filter({
    hasText: /Use WebContainer|Use Proxy Mode/
  }).first();

  return { toolsButton, toggleItem };
}

test.describe('WebContainer Integration', () => {
  // Note: COEP/COOP headers removed to fix cross-origin preview iframe
  // WebContainers now use `coep: 'none'` which relies on Chrome's Origin Trial
  // SharedArrayBuffer availability depends on the browser (Chrome only with Origin Trial)

  test('WebContainer toggle option exists in browser tools menu', async ({ page, request }) => {
    await loginIfNeeded(page, request);
    const menu = await openWebContainerToolsMenu(page);
    if (!menu) {
      test.skip(true, 'Preview/browser tools are not available in this environment.');
      return;
    }

    await expect(menu.toggleItem).toBeVisible({ timeout: 5000 });
  });

  test('WebContainer toggle option can be toggled when supported', async ({ page, request }) => {
    await loginIfNeeded(page, request);
    const menu = await openWebContainerToolsMenu(page);
    if (!menu) {
      test.skip(true, 'Preview/browser tools are not available in this environment.');
      return;
    }

    await expect(menu.toggleItem).toBeVisible({ timeout: 5000 });
    const isDisabled = await menu.toggleItem.isDisabled();
    if (!isDisabled) {
      const initialText = ((await menu.toggleItem.textContent()) || '').trim();
      await menu.toggleItem.click();

      await menu.toolsButton.click();
      const expectedNextLabel = initialText.includes('Use WebContainer') ? 'Use Proxy Mode' : 'Use WebContainer';
      await expect(
        page.locator('.preview-tools-menu-item').filter({ hasText: expectedNextLabel }).first()
      ).toBeVisible({ timeout: 5000 });
    } else {
      test.skip(true, 'WebContainer toggle is disabled in this browser/runtime.');
    }
  });

  // Note: Preview proxy header test removed - no longer relevant since
  // COEP/COOP headers are not set server-side anymore

  test('WebContainer files API endpoint exists', async ({ page }) => {
    // Test the API endpoint exists (will return error without valid path, but endpoint should exist)
    const response = await page.request.get(`${baseUrl}/api/webcontainer/files`);

    // Should return 400 (missing path) or 401 (unauthorized), not 404
    expect(response.status()).not.toBe(404);
  });
});
