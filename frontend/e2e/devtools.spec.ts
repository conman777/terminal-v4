import { test, expect } from '@playwright/test';

/**
 * E2E Tests for DevTools Panel
 *
 * These tests verify the DevTools integration works correctly with real browser environments.
 * Run with: npm run test:e2e devtools.spec.ts
 */

test.describe('DevTools Integration', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to a page with DevTools enabled
    // Adjust URL based on your setup
    await page.goto('/preview/3000');

    // Wait for DevTools to load
    await page.waitForSelector('.devtools-panel', { timeout: 10000 });
  });

  test('should render all DevTools tabs', async ({ page }) => {
    await expect(page.locator('.devtools-tab', { hasText: 'Network' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'Console' })).toBeVisible();
    await expect(page.locator('.devtools-tab', { hasText: 'Storage' })).toBeVisible();
  });

  test('should switch between tabs', async ({ page }) => {
    // Click Console tab
    await page.click('.devtools-tab:has-text("Console")');
    await expect(page.locator('.console-tab')).toBeVisible();

    // Click Storage tab
    await page.click('.devtools-tab:has-text("Storage")');
    await expect(page.locator('.storage-tab')).toBeVisible();

    // Click Network tab
    await page.click('.devtools-tab:has-text("Network")');
    await expect(page.locator('.network-tab')).toBeVisible();
  });
});

test.describe('Network Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/preview/3000');
    await page.waitForSelector('.devtools-panel');
    await page.click('.devtools-tab:has-text("Network")');
  });

  test('should capture network requests', async ({ page }) => {
    // Trigger a network request in the preview iframe
    await page.evaluate(() => {
      fetch('/api/test').catch(() => {});
    });

    // Wait for request to appear in network table
    await page.waitForSelector('.network-table tbody tr', { timeout: 5000 });

    const requestRow = page.locator('.network-table tbody tr').first();
    await expect(requestRow).toBeVisible();
  });

  test('should filter requests by type', async ({ page }) => {
    // Click on Fetch/XHR filter
    await page.click('.devtools-filter-btn:has-text("Fetch/XHR")');

    // Verify filter is active
    await expect(page.locator('.devtools-filter-btn:has-text("Fetch/XHR")')).toHaveClass(/active/);
  });

  test('should search requests', async ({ page }) => {
    // Type in search box
    await page.fill('.devtools-search-input', 'api');

    // Verify search is applied
    const searchInput = page.locator('.devtools-search-input');
    await expect(searchInput).toHaveValue('api');
  });

  test('should show request details', async ({ page }) => {
    // Wait for at least one request
    await page.waitForSelector('.network-table tbody tr', { timeout: 5000 });

    // Click on first request
    await page.click('.network-table tbody tr:first-child');

    // Verify details panel is shown
    await expect(page.locator('.network-details')).toBeVisible();
    await expect(page.locator('.network-details-tabs button:has-text("Headers")')).toBeVisible();
    await expect(page.locator('.network-details-tabs button:has-text("Request")')).toBeVisible();
    await expect(page.locator('.network-details-tabs button:has-text("Response")')).toBeVisible();
  });

  test('should clear network logs', async ({ page }) => {
    // Click clear button
    await page.click('[title="Clear network log"]');

    // Verify table is empty
    await expect(page.locator('.network-table tbody tr')).toHaveCount(0);
  });

  test('should handle 1000+ network requests efficiently', async ({ page }) => {
    // Generate many network requests
    await page.evaluate(() => {
      for (let i = 0; i < 1000; i++) {
        fetch(`/api/test/${i}`).catch(() => {});
      }
    });

    // Wait for requests to be logged
    await page.waitForTimeout(2000);

    // Verify UI is still responsive
    await page.click('.devtools-filter-btn:has-text("All")');
    await expect(page.locator('.devtools-filter-btn:has-text("All")')).toHaveClass(/active/);
  });
});

test.describe('Console Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/preview/3000');
    await page.waitForSelector('.devtools-panel');
    await page.click('.devtools-tab:has-text("Console")');
  });

  test('should capture console logs', async ({ page }) => {
    // Trigger console logs in preview iframe
    await page.evaluate(() => {
      console.log('Test log message');
      console.warn('Test warning');
      console.error('Test error');
    });

    // Wait for logs to appear
    await page.waitForSelector('.console-log', { timeout: 5000 });

    // Verify logs are displayed
    await expect(page.locator('.console-log:has-text("Test log message")')).toBeVisible();
    await expect(page.locator('.console-log:has-text("Test warning")')).toBeVisible();
    await expect(page.locator('.console-log:has-text("Test error")')).toBeVisible();
  });

  test('should filter logs by level', async ({ page }) => {
    // Trigger various log levels
    await page.evaluate(() => {
      console.log('Log message');
      console.warn('Warning message');
      console.error('Error message');
    });

    await page.waitForSelector('.console-log');

    // Filter by errors only
    await page.click('.devtools-filter-btn:has-text("Errors")');

    // Verify only errors are shown
    await expect(page.locator('.console-log:has-text("Error message")')).toBeVisible();
    await expect(page.locator('.console-log:has-text("Log message")')).not.toBeVisible();
  });

  test('should evaluate JavaScript expressions in REPL', async ({ page }) => {
    // Type expression in REPL
    const replInput = page.locator('.repl-input');
    await replInput.fill('1 + 1');
    await replInput.press('Enter');

    // Wait for result
    await page.waitForTimeout(500);

    // Verify evaluation was triggered (result handling depends on implementation)
    await expect(replInput).toHaveValue('');
  });

  test('should navigate REPL history', async ({ page }) => {
    const replInput = page.locator('.repl-input');

    // Execute first command
    await replInput.fill('console.log("first")');
    await replInput.press('Enter');

    // Execute second command
    await replInput.fill('console.log("second")');
    await replInput.press('Enter');

    // Navigate up in history
    await replInput.press('ArrowUp');
    await expect(replInput).toHaveValue('console.log("second")');

    await replInput.press('ArrowUp');
    await expect(replInput).toHaveValue('console.log("first")');

    // Navigate down in history
    await replInput.press('ArrowDown');
    await expect(replInput).toHaveValue('console.log("second")');
  });

  test('should clear console logs', async ({ page }) => {
    // Add some logs
    await page.evaluate(() => {
      console.log('Test message');
    });

    await page.waitForSelector('.console-log');

    // Click clear button
    await page.click('[title="Clear console"]');

    // Verify logs are cleared
    await expect(page.locator('.console-log')).toHaveCount(0);
  });

  test('should handle 10K+ console logs efficiently', async ({ page }) => {
    // Generate many console logs
    await page.evaluate(() => {
      for (let i = 0; i < 10000; i++) {
        console.log(`Log message ${i}`);
      }
    });

    // Wait for logs to be rendered
    await page.waitForTimeout(2000);

    // Verify UI is still responsive (virtual scrolling should handle this)
    await page.click('.devtools-filter-btn:has-text("All")');
    await expect(page.locator('.devtools-filter-btn:has-text("All")')).toHaveClass(/active/);

    // Verify scrolling works
    const logViewer = page.locator('.log-viewer');
    await logViewer.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // UI should still be responsive
    await page.click('.devtools-filter-btn:has-text("Logs")');
  });
});

test.describe('Storage Tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/preview/3000');
    await page.waitForSelector('.devtools-panel');
    await page.click('.devtools-tab:has-text("Storage")');
  });

  test('should display localStorage items', async ({ page }) => {
    // Set some localStorage items in preview
    await page.evaluate(() => {
      localStorage.setItem('test_key', 'test_value');
      localStorage.setItem('user_id', '12345');
    });

    // Wait for storage to sync
    await page.waitForTimeout(500);

    // Click on Local Storage
    await page.click('.storage-tree-item:has-text("Local Storage")');

    // Verify items are displayed
    await expect(page.locator('text=test_key')).toBeVisible();
    await expect(page.locator('text=test_value')).toBeVisible();
  });

  test('should add new storage item', async ({ page }) => {
    // Click add button
    await page.click('[title="Add new item"]');

    // Fill in key and value
    await page.fill('input[placeholder="Key"]', 'new_key');
    await page.fill('input[placeholder="Value"]', 'new_value');

    // Click Add button
    await page.click('button:has-text("Add")');

    // Verify item was added
    await expect(page.locator('text=new_key')).toBeVisible();
  });

  test('should edit storage item', async ({ page }) => {
    // Set initial value
    await page.evaluate(() => {
      localStorage.setItem('editable_key', 'original_value');
    });

    await page.waitForTimeout(500);

    // Click edit button for the item
    const row = page.locator('tr:has-text("editable_key")');
    await row.locator('[title="Edit"]').click();

    // Change value
    const editInput = row.locator('input.edit-input');
    await editInput.fill('updated_value');

    // Save changes
    await row.locator('[title="Save"]').click();

    // Verify value was updated
    await expect(page.locator('text=updated_value')).toBeVisible();
  });

  test('should delete storage item', async ({ page }) => {
    // Set initial value
    await page.evaluate(() => {
      localStorage.setItem('deletable_key', 'deletable_value');
    });

    await page.waitForTimeout(500);

    // Mock confirm dialog
    page.on('dialog', dialog => dialog.accept());

    // Click delete button for the item
    const row = page.locator('tr:has-text("deletable_key")');
    await row.locator('[title="Delete"]').click();

    // Verify item was deleted
    await expect(page.locator('text=deletable_key')).not.toBeVisible();
  });

  test('should clear all storage items', async ({ page }) => {
    // Set some values
    await page.evaluate(() => {
      localStorage.setItem('key1', 'value1');
      localStorage.setItem('key2', 'value2');
    });

    await page.waitForTimeout(500);

    // Mock confirm dialog
    page.on('dialog', dialog => dialog.accept());

    // Click clear all button
    await page.click('[title="Clear all"]');

    // Verify all items were cleared
    await expect(page.locator('.storage-empty')).toBeVisible();
  });

  test('should search storage items', async ({ page }) => {
    // Set some values
    await page.evaluate(() => {
      localStorage.setItem('search_test_1', 'value1');
      localStorage.setItem('other_key', 'value2');
    });

    await page.waitForTimeout(500);

    // Search for "search_test"
    await page.fill('input[placeholder="Search storage..."]', 'search_test');

    // Verify only matching items are shown
    await expect(page.locator('text=search_test_1')).toBeVisible();
    await expect(page.locator('text=other_key')).not.toBeVisible();
  });

  test('should switch between storage types', async ({ page }) => {
    // Set values in different storage types
    await page.evaluate(() => {
      localStorage.setItem('local_key', 'local_value');
      sessionStorage.setItem('session_key', 'session_value');
    });

    await page.waitForTimeout(500);

    // Verify localStorage is shown by default
    await expect(page.locator('text=local_key')).toBeVisible();

    // Click Session Storage
    await page.click('.storage-tree-item:has-text("Session Storage")');

    // Verify sessionStorage items are shown
    await expect(page.locator('text=session_key')).toBeVisible();
    await expect(page.locator('text=local_key')).not.toBeVisible();
  });
});
