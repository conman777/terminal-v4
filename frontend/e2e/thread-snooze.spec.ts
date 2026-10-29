import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_THREAD_SNOOZE_FIXTURE !== '1', 'Requires the isolated thread snooze fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { branches: {} } }));
});

for (const width of [320, 393]) {
  test(`snooze and request wake remain reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/e2e/fixtures/thread-snooze.html');
    await page.getByLabel('Unsent draft').fill('A draft I want to keep');
    await page.getByRole('button', { name: 'More actions' }).click();
    const snooze = page.getByRole('button', { name: 'Snooze for one hour' });
    await expect(snooze).toBeVisible();
    expect((await snooze.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await snooze.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Snoozed threads' })).toContainText('Synthetic thread');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await page.getByRole('button', { name: 'Simulate pending request' }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Snoozed threads' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Synthetic thread/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(page.getByLabel('Unsent draft')).toHaveValue('A draft I want to keep');
  });
}

test('desktop snooze keeps its row visible and restores focus after a request', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/e2e/fixtures/thread-snooze.html?layout=desktop');
  await page.getByRole('button', { name: 'Thread actions for Synthetic thread' }).click();
  await page.getByRole('menuitem', { name: 'Snooze for one hour' }).click();
  await expect(page.getByRole('region', { name: 'Snoozed threads' })).toContainText('Synthetic thread');
  await page.getByRole('button', { name: 'Select Synthetic thread' }).focus();
  await page.getByRole('button', { name: 'Simulate pending request' }).click();
  await expect(page.getByRole('region', { name: 'Snoozed threads' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Synthetic thread' })).toBeVisible();
});
