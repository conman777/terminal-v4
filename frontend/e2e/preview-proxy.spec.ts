import { test, expect } from '@playwright/test';

const previewTarget = process.env.PREVIEW_TARGET_URL;
const uiBaseUrl = process.env.BASE_URL || 'http://localhost:3020';

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

test.describe('Preview proxy', () => {
  test.skip(
    !previewTarget,
    'Set PREVIEW_TARGET_URL to a running local app (e.g. http://localhost:8787) to enable this test.'
  );

  test('uses subdomain preview for loopback targets', async ({ page }) => {
    const targetUrl = new URL(previewTarget!);
    const uiUrl = new URL(uiBaseUrl);

    await page.goto('/');

    const previewPanel = page.locator('.preview-panel');
    if (!(await previewPanel.isVisible())) {
      await page.getByRole('button', { name: 'Browser' }).click();
      await expect(previewPanel).toBeVisible();
    }

    const urlInput = page.getByLabel('Preview URL');
    await urlInput.fill(previewTarget!);
    await urlInput.press('Enter');

    const iframe = page.locator('.preview-iframe');
    await expect(iframe).toBeVisible({ timeout: 10000 });

    await expect(iframe).toHaveAttribute('src', /.+/);
    const src = await iframe.getAttribute('src');
    expect(src).toBeTruthy();

    if (isLoopbackHost(targetUrl.hostname)) {
      const expectedHost = `preview-${targetUrl.port || '80'}.localhost`;
      const expectedOrigin = `http://${expectedHost}:${uiUrl.port || '80'}`;
      expect(src).toContain(expectedOrigin);
      expect(src).not.toContain(targetUrl.origin);
    }
  });
});
