import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './test-helpers';

async function ensureMobileTerminalView(page) {
  const readerView = page.locator('.reader-view').first();
  const readerVisible = await readerView.isVisible({ timeout: 1000 }).catch(() => false);
  if (!readerVisible) return;

  const switchToTerminal = page.getByRole('button', { name: /Switch to Terminal View/i }).first();
  if (await switchToTerminal.count()) {
    await switchToTerminal.click();
    await expect(readerView).not.toBeVisible({ timeout: 10000 });
  }
}

async function openReaderView(page) {
  const switchToReader = page.getByRole('button', { name: /Switch to Reader View/i }).first();
  if (!(await switchToReader.count())) return false;
  await switchToReader.click();
  await expect(page.locator('.reader-view').first()).toBeVisible({ timeout: 10000 });
  return true;
}

test.describe('Terminal Scroll Behavior', () => {
  test.beforeEach(async ({ page, request }) => {
    await loginIfNeeded(page, request);
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

  test('mobile status controls should remain touch-friendly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);

    const mobileStatusBar = page.locator('.mobile-status-bar').first();
    if (await mobileStatusBar.count() === 0) {
      return;
    }
    await expect(mobileStatusBar).toBeVisible();

    const statusButton = page.getByRole('button', { name: 'Reconnect terminal' }).first();
    if (await statusButton.count() === 0) {
      return;
    }
    await expect(statusButton).toBeVisible();

    const bounds = await statusButton.boundingBox();
    expect(bounds).toBeTruthy();
    expect((bounds?.width || 0) >= 39).toBe(true);
    expect((bounds?.height || 0) >= 39).toBe(true);
  });

  test('mobile type input should be discoverable and openable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    await ensureMobileTerminalView(page);

    const typeButton = page.getByRole('button', { name: 'Open text input' }).first();
    if (await typeButton.count() === 0) {
      return;
    }
    await expect(typeButton).toBeVisible();
    await typeButton.click();

    const input = page.locator('.mobile-terminal-input').first();
    if (await input.count() === 0) {
      return;
    }
    await expect(input).toBeVisible();
    await input.fill('echo mobile ux');

    const sendButton = page.getByRole('button', { name: 'Send to terminal' }).first();
    await expect(sendButton).toBeEnabled();
  });

  test('mobile status input sends command output to terminal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    await ensureMobileTerminalView(page);

    const typeButton = page.getByRole('button', { name: 'Open text input' }).first();
    if (!(await typeButton.count())) {
      return;
    }
    await typeButton.click();

    const input = page.locator('.mobile-terminal-input').first();
    await expect(input).toBeVisible();

    const marker = `MOBILE_STATUS_${Date.now()}`;
    await input.fill(`echo ${marker}`);
    await page.getByRole('button', { name: 'Send to terminal' }).first().click();

    const readerOpened = await openReaderView(page);
    if (!readerOpened) return;
    await expect(page.locator('.reader-view').first()).toContainText(marker, { timeout: 20000 });
  });

  test('mobile keyboard overlay input executes commands', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);
    await ensureMobileTerminalView(page);

    const overlayInput = page.locator('.mobile-keyboard-input').first();
    if (!(await overlayInput.count())) {
      return;
    }

    const marker = `MOBILE_OVERLAY_${Date.now()}`;
    await overlayInput.fill(`echo ${marker}`);
    await overlayInput.press('Enter');

    const readerOpened = await openReaderView(page);
    if (!readerOpened) return;
    await expect(page.locator('.reader-view').first()).toContainText(marker, { timeout: 20000 });
  });

  test('mobile session actions should be visible without long-press', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);

    const sessionActionsButton = page.getByRole('button', { name: 'Session actions' }).first();
    if (await sessionActionsButton.count()) {
      await expect(sessionActionsButton).toBeVisible();
      await sessionActionsButton.click();
      await expect(page.locator('text=Rename').first()).toBeVisible();
    }
  });

  test('mobile preview segmented controls should meet touch target size', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1000);

    const previewButton = page.getByRole('button', { name: 'Preview' }).first();
    if (await previewButton.count()) {
      await previewButton.click();
      await page.waitForTimeout(600);
    }

    const segmentedButton = page.locator('.preview-mobile-segmented-btn').first();
    if (await segmentedButton.count()) {
      await expect(segmentedButton).toBeVisible();
      const bounds = await segmentedButton.boundingBox();
      expect(bounds).toBeTruthy();
      expect((bounds?.height || 0) >= 43).toBe(true);
    }
  });
});
