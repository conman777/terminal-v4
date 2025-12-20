import { test, expect } from '@playwright/test';

test.describe('Claude Code Interaction', () => {
  test('should switch to Claude mode and see session selector', async ({ page }) => {
    await page.goto('/');

    // Click the Claude mode button
    const claudeBtn = page.locator('.mode-btn', { hasText: 'Claude' });
    await claudeBtn.click();

    // Should show Claude Code session selector or empty state
    const claudePanel = await page.locator('.claude-code-panel, .empty-state').first();
    await expect(claudePanel).toBeVisible();
  });

  test('should create new Claude Code session', async ({ page }) => {
    await page.goto('/');

    // Switch to Claude mode
    await page.locator('.mode-btn', { hasText: 'Claude' }).click();

    // Look for "New Claude Code Session" button
    const newSessionBtn = page.locator('button', { hasText: /New Claude Code Session/i });

    if (await newSessionBtn.isVisible()) {
      await newSessionBtn.click();

      // Wait for session to be created - should see the panel
      await page.waitForSelector('.claude-code-panel', { timeout: 5000 });

      // Should have messages area
      const messagesArea = page.locator('.claude-code-messages');
      await expect(messagesArea).toBeVisible();

      // Should have input area
      const input = page.locator('.claude-code-input textarea');
      await expect(input).toBeVisible();

      // Should show status bar
      const statusBar = page.locator('.claude-status-bar');
      await expect(statusBar).toBeVisible();
    }
  });

  test('should show connection status in status bar', async ({ page }) => {
    await page.goto('/');

    // Switch to Claude mode
    await page.locator('.mode-btn', { hasText: 'Claude' }).click();

    // Create or select session
    const newSessionBtn = page.locator('button', { hasText: /New Claude Code Session/i });
    if (await newSessionBtn.isVisible()) {
      await newSessionBtn.click();
    } else {
      // If sessions exist, use session selector
      const sessionSelector = page.locator('.claude-session-selector .session-dropdown-btn');
      if (await sessionSelector.isVisible()) {
        await sessionSelector.click();
        // Click first session
        const firstSession = page.locator('.session-item .session-select-btn').first();
        if (await firstSession.isVisible()) {
          await firstSession.click();
        }
      }
    }

    // Wait for panel and status bar
    await page.waitForSelector('.claude-code-panel', { timeout: 5000 });

    // Check status bar shows connected after a moment
    await page.waitForTimeout(2000);
    const statusDot = page.locator('.claude-status-bar .status-dot.connected');
    await expect(statusDot).toBeVisible({ timeout: 10000 });
  });

  test('should allow typing in input when connected', async ({ page }) => {
    await page.goto('/');

    // Switch to Claude mode
    await page.locator('.mode-btn', { hasText: 'Claude' }).click();

    // Create session if needed
    const newSessionBtn = page.locator('button', { hasText: /New Claude Code Session/i });
    if (await newSessionBtn.isVisible()) {
      await newSessionBtn.click();
    }

    await page.waitForSelector('.claude-code-panel', { timeout: 5000 });

    // Wait for connection
    await page.waitForSelector('.claude-status-bar .status-dot.connected', { timeout: 10000 });

    // Input should be enabled
    const input = page.locator('.claude-code-input textarea');
    await expect(input).toBeEnabled();

    // Type something
    await input.fill('test message');
    await expect(input).toHaveValue('test message');
  });

  test('should show user message after sending', async ({ page }) => {
    await page.goto('/');

    // Switch to Claude mode
    await page.locator('.mode-btn', { hasText: 'Claude' }).click();

    // Create session
    const newSessionBtn = page.locator('button', { hasText: /New Claude Code Session/i });
    if (await newSessionBtn.isVisible()) {
      await newSessionBtn.click();
    }

    await page.waitForSelector('.claude-code-panel', { timeout: 5000 });
    await page.waitForSelector('.claude-status-bar .status-dot.connected', { timeout: 10000 });

    // Type and send
    const input = page.locator('.claude-code-input textarea');
    await input.fill('hello test');

    // Click send button
    const sendBtn = page.locator('.claude-code-input button[type="submit"]');
    await sendBtn.click();

    // Should see user message appear
    const userMessage = page.locator('.cc-user-message', { hasText: 'hello test' });
    await expect(userMessage).toBeVisible({ timeout: 5000 });
  });
});
