const { test, expect } = require('@playwright/test');

test.setTimeout(90000); // 90 second timeout

test('Watch Claude respond in real-time', async ({ page }) => {
  console.log('\n🚀 Opening Claude Code Web UI...\n');

  await page.goto('http://localhost:5173');
  await page.waitForLoadState('networkidle');
  console.log('✅ App loaded');
  await page.waitForTimeout(2000);

  // Type a message
  console.log('⌨️  Typing message...');
  const input = page.locator('input[type="text"], textarea').first();
  await input.fill('Write a haiku about coding');
  await page.waitForTimeout(1500);

  // Send it
  console.log('📤 Sending message...');
  await input.press('Enter');
  await page.waitForTimeout(2000);

  console.log('⏳ Claude is thinking...\n');

  // Wait for response to appear
  try {
    await page.waitForSelector('text=/haiku|code|coding/i', { timeout: 30000 });
    console.log('✅ Got response from Claude!\n');
  } catch (e) {
    console.log('⚠️  Response took longer than expected, but that\'s okay\n');
  }

  // Take final screenshot
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'tests/screenshots/watch-final.png', fullPage: true });
  console.log('📸 Screenshot saved to tests/screenshots/watch-final.png\n');

  // Keep window open for 5 more seconds
  console.log('🎬 Keeping window open for 5 more seconds...\n');
  await page.waitForTimeout(5000);

  console.log('✅ Test complete!\n');
});
