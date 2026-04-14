import { expect, test } from '@playwright/test';

const E2E_USERNAME = process.env.E2E_USERNAME || process.env.ALLOWED_USERNAME || 'conor';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'P@ssw0rd213@';

test.describe('Mobile keyboard viewport restoration', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      const listeners = new Map<string, Set<(event: Event) => void>>();
      const state = {
        width: window.innerWidth,
        height: window.innerHeight,
        offsetTop: 0,
      };

      const getListeners = (eventName: string) => {
        let bucket = listeners.get(eventName);
        if (!bucket) {
          bucket = new Set();
          listeners.set(eventName, bucket);
        }
        return bucket;
      };

      const visualViewportMock = {
        get width() {
          return state.width;
        },
        get height() {
          return state.height;
        },
        get offsetTop() {
          return state.offsetTop;
        },
        addEventListener(eventName: string, listener: (event: Event) => void) {
          getListeners(eventName).add(listener);
        },
        removeEventListener(eventName: string, listener: (event: Event) => void) {
          getListeners(eventName).delete(listener);
        },
      };

      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: visualViewportMock,
      });

      (window as typeof window & {
        __setMockVisualViewport?: (next: Partial<typeof state>) => void;
      }).__setMockVisualViewport = (next) => {
        if (typeof next.width === 'number') {
          state.width = next.width;
        }
        if (typeof next.height === 'number') {
          state.height = next.height;
        }
        if (typeof next.offsetTop === 'number') {
          state.offsetTop = next.offsetTop;
        }
        const resizeEvent = new Event('resize');
        const scrollEvent = new Event('scroll');
        getListeners('resize').forEach((listener) => listener(resizeEvent));
        getListeners('scroll').forEach((listener) => listener(scrollEvent));
      };
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const appShellMarker = page.locator(
      '.threads-sidebar, .main-container, .terminal-main, .session-tab-bar-modern, .mobile-header, .terminal-pane, .preview-panel'
    ).first();

    if (!(await appShellMarker.isVisible({ timeout: 1000 }).catch(() => false))) {
      const usernameInput = page.getByRole('textbox', { name: 'Username' }).first();
      const passwordInput = page.getByRole('textbox', { name: 'Password' }).first();
      await expect(usernameInput).toBeVisible({ timeout: 10000 });
      await expect(passwordInput).toBeVisible({ timeout: 10000 });
      await usernameInput.fill(E2E_USERNAME);
      await passwordInput.fill(E2E_PASSWORD);
      await page.getByRole('button', { name: /^Initialize Session$|^Sign In$/ }).first().click();
    }

    await expect(appShellMarker).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);
  });

  test('restores full shell height after keyboard close even if visual viewport height lags behind', async ({ page }) => {
    const composer = page.getByLabel('Command composer').first();
    if (!(await composer.isVisible().catch(() => false))) {
      const createSessionButton = page.getByRole('button', { name: /Initialize Session|New Terminal|Create session/i }).first();
      if (await createSessionButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await createSessionButton.click();
        await page.waitForTimeout(1500);
      }
    }
    await expect(composer).toBeVisible({ timeout: 15000 });

    const readShellMetrics = () => page.evaluate(() => {
      const layout = document.querySelector('.layout.mobile');
      const header = document.querySelector('.mobile-header');
      const composerInput = document.querySelector('[aria-label="Command composer"]');
      if (!(layout instanceof HTMLElement) || !(header instanceof HTMLElement)) {
        return null;
      }
      const layoutRect = layout.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      return {
        layoutTop: Math.round(layoutRect.top),
        layoutHeight: Math.round(layoutRect.height),
        headerTop: Math.round(headerRect.top),
        focusedTag: composerInput === document.activeElement ? (composerInput as HTMLElement).tagName : '',
        viewportHeightVar: getComputedStyle(layout).getPropertyValue('--mobile-viewport-height').trim(),
        viewportOffsetVar: getComputedStyle(layout).getPropertyValue('--mobile-viewport-offset').trim(),
        windowInnerHeight: Math.round(window.innerHeight),
      };
    });

    const initialMetrics = await readShellMetrics();
    expect(initialMetrics).toBeTruthy();
    expect(initialMetrics?.layoutTop).toBe(0);

    await composer.focus();
    await page.evaluate(() => {
      (window as typeof window & {
        __setMockVisualViewport?: (next: { height?: number; offsetTop?: number }) => void;
      }).__setMockVisualViewport?.({ height: 402, offsetTop: 248 });
    });
    await page.waitForTimeout(700);

    const keyboardOpenMetrics = await readShellMetrics();
    expect(keyboardOpenMetrics).toBeTruthy();
    expect(keyboardOpenMetrics?.layoutTop).toBe(248);
    expect(keyboardOpenMetrics?.layoutHeight).toBe(402);
    expect(keyboardOpenMetrics?.headerTop).toBe(keyboardOpenMetrics?.layoutTop);

    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="Command composer"]');
      if (input instanceof HTMLElement) {
        input.blur();
      }
      if (document.body instanceof HTMLElement) {
        document.body.tabIndex = -1;
        document.body.focus();
      }
      (window as typeof window & {
        __setMockVisualViewport?: (next: { height?: number; offsetTop?: number }) => void;
      }).__setMockVisualViewport?.({ height: 402, offsetTop: 0 });
      window.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await page.waitForTimeout(900);

    const keyboardClosedMetrics = await readShellMetrics();
    expect(keyboardClosedMetrics).toBeTruthy();
    expect(keyboardClosedMetrics?.layoutTop).toBe(0);
    expect(keyboardClosedMetrics?.headerTop).toBe(0);
    expect(keyboardClosedMetrics?.layoutHeight).toBeGreaterThanOrEqual((keyboardClosedMetrics?.windowInnerHeight ?? 0) - 2);
    expect(keyboardClosedMetrics?.viewportHeightVar).toBe(`${keyboardClosedMetrics?.windowInnerHeight}px`);
    expect(keyboardClosedMetrics?.viewportOffsetVar).toBe('0px');
  });
});
