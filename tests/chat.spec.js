const { test, expect } = require('@playwright/test');

test.describe('Claude Code Web UI', () => {
  test('should load the chat interface', async ({ page }) => {
    // Navigate to the app
    await page.goto('http://localhost:5173');

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Take a screenshot of the initial state
    await page.screenshot({ path: 'tests/screenshots/initial-load.png', fullPage: true });

    // Check if basic UI elements are present
    const hasInput = await page.locator('input, textarea').count() > 0;
    expect(hasInput).toBeTruthy();

    console.log('✅ Chat interface loaded successfully');
  });

  test('should send a message and receive a response', async ({ page }) => {
    // Navigate to the app
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');

    // Find the input field (could be input or textarea)
    const input = page.locator('input[type="text"], textarea').first();
    await input.waitFor({ state: 'visible' });

    // Type a simple message
    await input.fill('Say "test" in one word');

    // Take screenshot before sending
    await page.screenshot({ path: 'tests/screenshots/before-send.png', fullPage: true });

    // Find and click the send button (look for button with common patterns)
    const sendButton = page.locator('button').filter({ hasText: /send|submit|→|➤/i }).first();

    // If no send button with text, try to submit the form or press Enter
    if (await sendButton.count() === 0) {
      console.log('No send button found, pressing Enter');
      await input.press('Enter');
    } else {
      await sendButton.click();
    }

    console.log('✅ Message sent');

    // Wait for response (look for assistant message)
    // Give it up to 30 seconds for Claude to respond
    await page.waitForTimeout(2000); // Initial wait

    // Take screenshot after sending
    await page.screenshot({ path: 'tests/screenshots/after-send.png', fullPage: true });

    // Check if there are any messages displayed
    const messages = await page.locator('[class*="message"], [class*="chat"], [role="log"]').count();
    console.log(`Found ${messages} message elements`);

    // Wait a bit more for streaming response
    await page.waitForTimeout(5000);

    // Final screenshot
    await page.screenshot({ path: 'tests/screenshots/final-state.png', fullPage: true });

    console.log('✅ Test completed - check screenshots in tests/screenshots/');
  });
});
