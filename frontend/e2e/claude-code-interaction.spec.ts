import { test, expect } from '@playwright/test';
import { loginIfNeeded, openMobileDrawer, selectMobileDrawerView } from './test-helpers';

test.describe('Claude Code Interaction', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginIfNeeded(page, request);
  });

  test('shows Claude view entry in mobile menu', async ({ page }) => {
    await openMobileDrawer(page);
    await expect(page.locator('.mobile-drawer-grid-btn-modern', { hasText: 'Claude' }).first()).toBeVisible();
  });

  test('switches into Claude view from menu', async ({ page }) => {
    await selectMobileDrawerView(page, 'Claude');

    await expect(page.locator('.claude-code-panel').first()).toBeVisible();
  });

  test('switches back to Terminal view from menu', async ({ page }) => {
    await selectMobileDrawerView(page, 'Claude');
    await expect(page.locator('.claude-code-panel').first()).toBeVisible();

    await selectMobileDrawerView(page, 'Terminal');
    await expect(page.locator('.terminal-pane').first()).toBeVisible();
  });
});
