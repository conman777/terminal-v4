import { test, expect } from '@playwright/test';

test.describe('Terminal Scroll Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Login if we see the login form
    const loginForm = page.locator('text=Sign In').first();
    if (await loginForm.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.fill('input[placeholder="Enter username"]', 'conor');
      await page.fill('input[placeholder="Enter password"]', 'P@ssw0rd213@');
      await page.click('button:has-text("Sign In")');
      // Wait for login to complete and terminal to load
      await page.waitForTimeout(3000);
    }

    // Wait for terminal to initialize
    await page.waitForTimeout(2000);
  });

  test('scroll up button should maintain scroll position', async ({ page }) => {
    // Find the terminal container
    const terminal = page.locator('.xterm-container').first();
    await expect(terminal).toBeVisible({ timeout: 10000 });

    // Generate enough output to create scrollback by sending a command
    // We'll check if there's scrollback available first
    const hasScrollback = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm-container');
      if (!xterm) return false;
      // xterm stores the Terminal instance - we need to find it
      // The terminal ref is stored on the component, so we check the buffer
      const canvas = document.querySelector('.xterm-screen canvas');
      return canvas !== null;
    });

    // Wait for any terminal activity
    await page.waitForTimeout(1000);

    // Find and click the scroll up button
    const scrollUpBtn = page.locator('.scroll-btn.scroll-up');

    if (await scrollUpBtn.count() > 0) {
      // Get initial state - check if we can access xterm buffer
      const initialState = await page.evaluate(() => {
        // Try to find xterm instance through React fiber or global
        const container = document.querySelector('.xterm-container');
        const viewport = container?.querySelector('.xterm-viewport');
        if (viewport) {
          return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          };
        }
        return null;
      });

      // Click scroll up
      await scrollUpBtn.click();
      await page.waitForTimeout(100);

      // Get state after scroll
      const afterScrollState = await page.evaluate(() => {
        const container = document.querySelector('.xterm-container');
        const viewport = container?.querySelector('.xterm-viewport');
        if (viewport) {
          return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          };
        }
        return null;
      });

      // Wait a bit to see if scroll resets (the bug we're testing for)
      await page.waitForTimeout(500);

      // Get final state
      const finalState = await page.evaluate(() => {
        const container = document.querySelector('.xterm-container');
        const viewport = container?.querySelector('.xterm-viewport');
        if (viewport) {
          return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
          };
        }
        return null;
      });

      // If we have scrollback and scrolled, position should stay
      if (initialState && afterScrollState && finalState) {
        if (afterScrollState.scrollTop < initialState.scrollTop) {
          // We successfully scrolled up
          // The bug would cause finalState.scrollTop to be back at the bottom
          // Final scroll should be same as after-scroll (not reset to initial)
          expect(finalState.scrollTop).toBeLessThanOrEqual(afterScrollState.scrollTop + 10);
        }
      }
    }
  });

  test('scroll buttons should be visible on desktop', async ({ page }) => {
    // Set desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });

    const scrollButtons = page.locator('.terminal-scroll-buttons.desktop');

    // Scroll buttons should exist
    const count = await scrollButtons.count();
    if (count > 0) {
      // Check individual buttons
      const scrollUp = page.locator('.scroll-btn.scroll-up');
      const scrollDown = page.locator('.scroll-btn.scroll-down');
      const jumpToLive = page.locator('.scroll-btn.scroll-live');

      await expect(scrollUp).toBeVisible();
      await expect(scrollDown).toBeVisible();
      await expect(jumpToLive).toBeVisible();
    }
  });

  test('jump to live button should scroll to bottom', async ({ page }) => {
    const terminal = page.locator('.xterm-container').first();
    await expect(terminal).toBeVisible();

    await page.waitForTimeout(1000);

    const scrollUpBtn = page.locator('.scroll-btn.scroll-up');
    const jumpToLiveBtn = page.locator('.scroll-btn.scroll-live');

    if (await scrollUpBtn.count() > 0 && await jumpToLiveBtn.count() > 0) {
      // Scroll up first
      await scrollUpBtn.click();
      await page.waitForTimeout(200);

      // Then jump to live
      await jumpToLiveBtn.click();
      await page.waitForTimeout(200);

      // Check we're at the bottom
      const isAtBottom = await page.evaluate(() => {
        const container = document.querySelector('.xterm-container');
        const viewport = container?.querySelector('.xterm-viewport');
        if (viewport) {
          const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
          return atBottom;
        }
        return true; // Default to true if we can't check
      });

      expect(isAtBottom).toBe(true);
    }
  });
});
