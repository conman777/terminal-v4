import { test, expect } from '@playwright/test';
import { loginIfNeeded, openDevToolsPanel } from './test-helpers';

test.describe('DevTools Integration', () => {
  test.beforeEach(async ({ page, request }) => {
    await loginIfNeeded(page, request);
    await openDevToolsPanel(page);
  });

  test('renders all primary DevTools tabs', async ({ page }) => {
    await expect(page.locator('.devtools-tab', { hasText: 'Network' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'Console' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'Storage' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'Performance' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'WebSocket' })).toBeVisible();
  });

  test('switches between Network, Console, and Storage tabs', async ({ page }) => {
    await page.click('.devtools-tab:has-text("Network")');
    await expect(page.locator('.network-tab')).toBeVisible();

    await page.click('.devtools-tab:has-text("Console")');
    await expect(page.locator('.console-tab')).toBeVisible();

    await page.click('.devtools-tab:has-text("Storage")');
    await expect(page.locator('.storage-tab')).toBeVisible();
  });

  test('supports network filtering/search controls', async ({ page }) => {
    await page.click('.devtools-tab:has-text("Network")');
    await expect(page.locator('.network-tab')).toBeVisible();

    await page.click('.devtools-filter-btn:has-text("Fetch/XHR")');
    await expect(page.locator('.devtools-filter-btn:has-text("Fetch/XHR")')).toHaveClass(/active/);

    const search = page.locator('.network-tab .devtools-search-input');
    await search.fill('api');
    await expect(search).toHaveValue('api');
  });

  test('supports console filtering controls', async ({ page }) => {
    await page.click('.devtools-tab:has-text("Console")');
    await expect(page.locator('.console-tab')).toBeVisible();

    await page.click('.devtools-filter-btn:has-text("Errors")');
    await expect(page.locator('.devtools-filter-btn:has-text("Errors")')).toHaveClass(/active/);

    const search = page.locator('.console-tab .devtools-search-input');
    await search.fill('warn');
    await expect(search).toHaveValue('warn');
  });

  test('supports storage navigation and search controls', async ({ page }) => {
    await page.click('.devtools-tab:has-text("Storage")');
    await expect(page.locator('.storage-tab')).toBeVisible();

    await page.click('.storage-tree-item:has-text("Session Storage")');
    await expect(page.locator('.storage-tree-item.active:has-text("Session Storage")')).toBeVisible();

    const search = page.locator('.storage-tab input[placeholder="Search storage..."]');
    await search.fill('token');
    await expect(search).toHaveValue('token');
  });
});
