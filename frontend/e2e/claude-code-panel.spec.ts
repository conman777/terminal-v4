import { test, expect } from '@playwright/test';
import { loginIfNeeded, selectMobileDrawerView } from './test-helpers';

test.describe('Claude Code Panel', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginIfNeeded(page, request);
  });

  test('displays app title', async ({ page }) => {
    await expect(page).toHaveTitle(/Terminal/i);
  });

  test('renders Claude panel container when Claude view is selected', async ({ page }) => {
    await selectMobileDrawerView(page, 'Claude');
    await expect(page.locator('.claude-code-panel').first()).toBeVisible();
  });

  test('shows either empty Claude state or terminal stream in Claude view', async ({ page }) => {
    await selectMobileDrawerView(page, 'Claude');

    const emptyState = page.locator('.claude-code-empty').first();
    const terminalStream = page.locator('.xterm-container, .terminal-chat').first();

    const emptyVisible = await emptyState.isVisible({ timeout: 1000 }).catch(() => false);
    if (emptyVisible) {
      await expect(emptyState).toContainText('Claude Code');
    } else {
      await expect(terminalStream).toBeVisible();
    }
  });
});

test.describe('Style Assets', () => {
  test.beforeEach(async ({ page, request }) => {
    await loginIfNeeded(page, request);
  });

  test('loads diff styles', async ({ page }) => {
    const hasDiffStyles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('.diff-add') || rule.cssText?.includes('.diff-remove')) {
              return true;
            }
          }
        } catch {
          // Skip inaccessible stylesheets.
        }
      }
      return false;
    });

    expect(hasDiffStyles).toBe(true);
  });

  test('loads copy button styles', async ({ page }) => {
    const hasCopyStyles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('.copy-btn')) {
              return true;
            }
          }
        } catch {
          // Skip inaccessible stylesheets.
        }
      }
      return false;
    });

    expect(hasCopyStyles).toBe(true);
  });
});
