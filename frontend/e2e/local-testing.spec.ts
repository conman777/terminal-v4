import { test, expect } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated loopback backend with TERMINAL_V4_LOCAL_TESTING=1.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

test('username-only testing reopens the same account and separates different names', async ({ page }) => {
  const username = `testing-${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('heading', {name:'Choose your username'})).toBeVisible();
  await expect(page.getByLabel('Password', {exact:true})).toHaveCount(0);
  async function enter(name: string) {
    await page.getByLabel('Username', {exact:true}).fill(name);
    await page.getByRole('button', {name:'Open workspace',exact:true}).click();
    await expect(page.getByRole('button',{name:'New thread',exact:true})).toBeVisible();
    return page.evaluate(() => JSON.parse(localStorage.getItem('terminal_user') || 'null'));
  }
  const first = await enter(username);
  await page.reload();
  await expect(page.getByRole('button',{name:'New thread',exact:true})).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('terminal_user') || 'null').id)).toBe(first.id);
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button',{name:'Logout',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Choose your username'})).toBeVisible();
  const reopened = await enter(username.toUpperCase());
  expect(reopened.id).toBe(first.id);
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button',{name:'Logout',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Choose your username'})).toBeVisible();
  const other = await enter(username+'-other');
  expect(other.id).not.toBe(first.id);
});
