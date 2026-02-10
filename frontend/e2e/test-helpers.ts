import { expect, type APIRequestContext, type Page } from '@playwright/test';

const E2E_USERNAME = process.env.E2E_USERNAME || process.env.ALLOWED_USERNAME || 'conor';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'P@ssw0rd213@';

async function ensureAccountExists(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/register', {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD }
  });

  if (response.ok()) return;

  const payload = await response.json().catch(() => ({}));
  const error = String(payload?.error || '').toLowerCase();

  // Re-running tests often hits an existing account; that is fine.
  if (response.status() === 400 && error.includes('already exists')) return;
}

export async function loginIfNeeded(page: Page, request: APIRequestContext): Promise<void> {
  await page.goto('/');

  const signInHeading = page.getByRole('heading', { name: 'Sign In' }).first();
  const appShellMarker = page.locator('.mobile-header, .terminal-pane, .desktop-layout, .preview-panel').first();

  // Account for auth-state hydration races by waiting for either app shell or sign-in UI.
  let needsLogin = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await signInHeading.isVisible({ timeout: 500 }).catch(() => false)) {
      needsLogin = true;
      break;
    }
    if (await appShellMarker.isVisible({ timeout: 500 }).catch(() => false)) {
      return;
    }
    await page.waitForTimeout(250);
  }

  if (!needsLogin) {
    needsLogin = await signInHeading.isVisible({ timeout: 2000 }).catch(() => false);
    if (!needsLogin) {
      return;
    }
  }

  await ensureAccountExists(request);
  await page.getByPlaceholder('Enter username').fill(E2E_USERNAME);
  await page.getByPlaceholder('Enter password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: /^Sign In$/ }).click();

  const loginError = page.locator('.login-error').first();
  if (await loginError.isVisible({ timeout: 2500 }).catch(() => false)) {
    const errorText = (await loginError.textContent())?.trim() || 'Unknown login error';
    throw new Error(
      `E2E login failed for "${E2E_USERNAME}": ${errorText}. ` +
      'Set E2E_USERNAME/E2E_PASSWORD to valid credentials for this environment.'
    );
  }

  await expect(signInHeading).not.toBeVisible({ timeout: 10000 });
}

export async function openPreviewPanel(page: Page): Promise<void> {
  const previewPanel = page.locator('.preview-panel').first();
  if (await previewPanel.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  const browserButton = page.getByRole('button', { name: 'Browser' }).first();
  if (await browserButton.count()) {
    await browserButton.click();
  } else {
    const previewButton = page.getByRole('button', { name: 'Preview' }).first();
    if (await previewButton.count()) {
      await previewButton.click();
    }
  }

  await expect(previewPanel).toBeVisible({ timeout: 10000 });
}

export async function openDevToolsPanel(page: Page): Promise<void> {
  await openPreviewPanel(page);
  const debugChip = page.locator('.preview-layout-chip', { hasText: 'Debug' }).first();
  await expect(debugChip).toBeVisible({ timeout: 10000 });
  await debugChip.click();
  await expect(page.locator('.devtools-panel').first()).toBeVisible({ timeout: 10000 });
}

export async function openMobileDrawer(page: Page): Promise<void> {
  const drawer = page.locator('.mobile-drawer-modern').first();
  if (await drawer.isVisible({ timeout: 300 }).catch(() => false)) {
    return;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const menuButton = page.locator('button[aria-label="Menu"]').first();
    const menuVisible = await menuButton.isVisible({ timeout: 1500 }).catch(() => false);
    if (!menuVisible) {
      await page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
      await page.waitForTimeout(150);
      continue;
    }

    await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="Menu"]');
      if (button instanceof HTMLElement) {
        button.click();
      }
    });
    if (await drawer.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.waitForTimeout(120);
      return;
    }
    await page.waitForTimeout(100);
  }

  await expect(page.locator('button[aria-label="Menu"]').first()).toBeVisible({ timeout: 10000 });
  await expect(drawer).toBeVisible({ timeout: 10000 });
}

export async function selectMobileDrawerView(page: Page, label: string): Promise<void> {
  await openMobileDrawer(page);
  const viewButton = page.locator('.mobile-drawer-grid-btn-modern', { hasText: label }).first();
  await expect(viewButton).toBeVisible({ timeout: 10000 });
  await page.evaluate((targetLabel) => {
    const normalizedTarget = String(targetLabel || '').trim().toLowerCase();
    const buttons = Array.from(document.querySelectorAll('.mobile-drawer-grid-btn-modern'));
    const target = buttons.find((button) =>
      button.textContent?.trim().toLowerCase().includes(normalizedTarget)
    );
    if (target instanceof HTMLElement) {
      target.click();
    }
  }, label);
}
