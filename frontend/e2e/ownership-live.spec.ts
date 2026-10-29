import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`live server loads sessions with ownership at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const inventory = page.waitForResponse(response =>
      /\/api\/structured\/sessions(?:\?.*)?$/.test(response.url())
      && response.request().method() === 'GET',
    );
    await page.getByLabel('Username', { exact: true }).fill(`ownership-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    expect((await inventory).status()).toBe(200);
    const status = await page.evaluate(async () => {
      const token = localStorage.getItem('terminal_access_token');
      const response = await fetch('/api/structured/ownership', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    });
    expect(status).toEqual({ status: 200, body: { state: 'owned' } });
    await expect(page.getByRole('region', { name: 'Session loading problem' })).toHaveCount(0);
  });
}
