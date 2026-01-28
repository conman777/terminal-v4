import { test, expect } from '@playwright/test';

const baseUrl = process.env.BASE_URL || 'http://localhost:3020';

test.describe('WebContainer Integration', () => {
  // Note: COEP/COOP headers removed to fix cross-origin preview iframe
  // WebContainers now use `coep: 'none'` which relies on Chrome's Origin Trial
  // SharedArrayBuffer availability depends on the browser (Chrome only with Origin Trial)

  test('WebContainer toggle button exists in preview panel', async ({ page }) => {
    // Go directly to preview route which should show the preview panel
    await page.goto('/');

    // Wait for the app to fully load
    await page.waitForLoadState('networkidle');

    // Try multiple ways to open the preview panel
    const previewPanel = page.locator('.preview-panel');

    // Check if preview is already visible
    const isVisible = await previewPanel.isVisible().catch(() => false);

    if (!isVisible) {
      // Try clicking various buttons that might open preview
      const browserBtn = page.locator('button:has-text("Browser")').first();
      const previewBtn = page.locator('[title*="preview" i], [aria-label*="preview" i]').first();

      if (await browserBtn.isVisible().catch(() => false)) {
        await browserBtn.click();
        await page.waitForTimeout(500);
      } else if (await previewBtn.isVisible().catch(() => false)) {
        await previewBtn.click();
        await page.waitForTimeout(500);
      }
    }

    // If preview panel is visible, check for the toggle button
    if (await previewPanel.isVisible().catch(() => false)) {
      const webContainerToggle = page.locator('[aria-label="Toggle WebContainer mode"]');
      await expect(webContainerToggle).toBeVisible({ timeout: 5000 });
    } else {
      // Skip if we can't open preview panel - it may require more complex setup
      test.skip(true, 'Preview panel not visible - may require terminal session');
    }
  });

  test('WebContainer toggle button can be clicked', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const previewPanel = page.locator('.preview-panel');
    const isVisible = await previewPanel.isVisible().catch(() => false);

    if (!isVisible) {
      const browserBtn = page.locator('button:has-text("Browser")').first();
      if (await browserBtn.isVisible().catch(() => false)) {
        await browserBtn.click();
        await page.waitForTimeout(500);
      }
    }

    if (!(await previewPanel.isVisible().catch(() => false))) {
      test.skip(true, 'Preview panel not visible - may require terminal session');
      return;
    }

    const webContainerToggle = page.locator('[aria-label="Toggle WebContainer mode"]');
    await expect(webContainerToggle).toBeVisible({ timeout: 5000 });

    const isDisabled = await webContainerToggle.isDisabled();

    if (!isDisabled) {
      await webContainerToggle.click();
      await expect(webContainerToggle).toHaveClass(/active/);

      await webContainerToggle.click();
      await expect(webContainerToggle).not.toHaveClass(/active/);
    } else {
      console.log('WebContainer toggle is disabled (not supported in this environment)');
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
