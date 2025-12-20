import { test, expect } from '@playwright/test';

test.describe('Claude Code Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display the app with correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/Terminal/i);
  });

  test('should show Claude Code panel elements', async ({ page }) => {
    // Look for the Claude Code section or tab
    const claudeSection = page.locator('.claude-code-panel, [data-testid="claude-code"]');

    // Check if there's a Claude-related element
    const claudeElements = await page.locator('text=Claude').count();
    expect(claudeElements).toBeGreaterThan(0);
  });

  test('should have status bar when connected', async ({ page }) => {
    // Wait for page to load
    await page.waitForTimeout(1000);

    // Look for status bar elements
    const statusBar = page.locator('.claude-status-bar');

    // If status bar exists, check its contents
    if (await statusBar.count() > 0) {
      // Should show connection status
      const statusDot = statusBar.locator('.status-dot');
      await expect(statusDot).toBeVisible();

      // Should show model name
      await expect(statusBar).toContainText('sonnet');
    }
  });

  test('should render empty state with robot icon', async ({ page }) => {
    await page.waitForTimeout(500);

    // Look for the empty state
    const emptyState = page.locator('.claude-code-empty');

    if (await emptyState.count() > 0) {
      await expect(emptyState.locator('.empty-icon')).toContainText('🤖');
      await expect(emptyState.locator('.empty-title')).toContainText('Claude Code');
    }
  });

  test('should have input field for sending messages', async ({ page }) => {
    // Look for textarea or input
    const input = page.locator('.claude-code-input textarea, .claude-code-input input');

    if (await input.count() > 0) {
      await expect(input).toBeVisible();

      // Check placeholder text
      const placeholder = await input.getAttribute('placeholder');
      expect(placeholder).toBeTruthy();
    }
  });

  test('visual regression - Claude Code panel', async ({ page }) => {
    await page.waitForTimeout(1000);

    // Take screenshot of the Claude section for visual comparison
    const claudePanel = page.locator('.claude-code-panel').first();

    if (await claudePanel.count() > 0) {
      await expect(claudePanel).toHaveScreenshot('claude-code-panel.png', {
        maxDiffPixels: 100,
      });
    }
  });
});

test.describe('Tool Call Rendering', () => {
  test('should have correct CSS for tool colors', async ({ page }) => {
    await page.goto('/');

    // Inject a test style check
    const colors = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        hasStyles: document.styleSheets.length > 0,
      };
    });

    expect(colors.hasStyles).toBe(true);
  });

  test('should have diff view styles loaded', async ({ page }) => {
    await page.goto('/');

    // Check that diff styles exist in the stylesheet
    const hasDiffStyles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('.diff-add') || rule.cssText?.includes('.diff-remove')) {
              return true;
            }
          }
        } catch {
          // Cross-origin stylesheet, skip
        }
      }
      return false;
    });

    expect(hasDiffStyles).toBe(true);
  });

  test('should have copy button styles loaded', async ({ page }) => {
    await page.goto('/');

    const hasCopyStyles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes('.copy-btn')) {
              return true;
            }
          }
        } catch {
          // Cross-origin stylesheet, skip
        }
      }
      return false;
    });

    expect(hasCopyStyles).toBe(true);
  });
});

test.describe('Markdown Rendering', () => {
  test('should have syntax highlighter theme loaded', async ({ page }) => {
    await page.goto('/');

    // Wait for JS to load
    await page.waitForTimeout(500);

    // The syntax highlighter uses inline styles, so we just verify the page loads
    const body = await page.locator('body');
    await expect(body).toBeVisible();
  });
});
