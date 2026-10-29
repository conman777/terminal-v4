import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_THREAD_SETTLEMENT_FIXTURE !== '1', 'Requires the isolated thread settlement fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { branches: {} } }));
});

for (const width of [320, 393]) {
  test(`settled work stays visible and a request wakes it at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/e2e/fixtures/thread-settlement.html');
    await page.getByLabel('Unsent draft').fill('A draft I want to keep');
    await page.getByRole('button', { name: 'More actions' }).click();
    const settle = page.getByRole('button', { name: 'Settle thread', exact: true });
    await expect(settle).toBeVisible();
    expect((await settle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await settle.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Settled threads' })).toContainText('Synthetic thread');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await page.getByRole('button', { name: 'Simulate pending request' }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Settled threads' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Synthetic thread/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(page.getByLabel('Unsent draft')).toHaveValue('A draft I want to keep');
  });
}

test('desktop settlement is reversible and preserves the draft', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/e2e/fixtures/thread-settlement.html?layout=desktop');
  await page.getByLabel('Unsent draft').fill('Keep this draft');
  await page.getByRole('button', { name: 'Thread actions for Synthetic thread' }).click();
  await page.getByRole('menuitem', { name: 'Settle thread', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Settled threads' })).toContainText('Synthetic thread');
  await page.getByRole('button', { name: 'Thread actions for Synthetic thread' }).click();
  await page.getByRole('menuitem', { name: 'Un-settle thread', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Settled threads' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Synthetic thread' })).toBeVisible();
  await expect(page.getByLabel('Unsent draft')).toHaveValue('Keep this draft');
});

test('desktop Working section stays visible and searchable', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/e2e/fixtures/thread-settlement.html?layout=desktop&working=1');
  await expect(page.getByRole('region', { name: 'Working threads' })).toContainText('Background thread');
  await expect(page.getByRole('button', { name: 'Select Background thread' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search threads' }).fill('Background');
  await expect(page.getByRole('button', { name: 'Select Background thread' })).toBeVisible();
});
