import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_MOBILE_SIGNOUT_FIXTURE !== '1', 'Requires the isolated mobile sign-out fixture.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const width of [320, 393]) {
  test(`mobile sign out is reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/e2e/fixtures/mobile-signout.html');
    const draft = page.getByLabel('Unsent draft');
    await draft.fill('Keep the synthetic draft');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
    await drawer.getByRole('button', { name: 'Close menu' }).click();
    await expect(draft).toHaveValue('Keep the synthetic draft');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const signout = drawer.getByRole('button', { name: 'Sign out', exact: true });
    await signout.scrollIntoViewIfNeeded();
    expect((await signout.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await signout.click();
    await expect(page.getByRole('status')).toHaveText('Sign out calls: 1');
    await expect(drawer).toBeHidden();
  });
}
