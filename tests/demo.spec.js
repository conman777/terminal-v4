const { test, expect } = require('@playwright/test');

test('Interactive demo - watch the app work', async ({ page }) => {
  console.log('🚀 Starting demo test...');

  // Navigate to the app
  console.log('📱 Opening http://localhost:5173');
  await page.goto('http://localhost:5173');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // Pause so you can see the initial screen

  console.log('✅ App loaded!');

  // Find the input field
  const input = page.locator('input[type="text"], textarea').first();
  await input.waitFor({ state: 'visible' });

  // Type slowly so you can see it
  console.log('⌨️  Typing message...');
  await input.fill('');
  await page.waitForTimeout(500);
  await input.type('Say hello and tell me one interesting fact', { delay: 100 });
  await page.waitForTimeout(1000);

  console.log('🖱️  Clicking send button...');
  // Find send button
  const sendButton = page.locator('button').filter({ hasText: /send|submit|enter/i }).first();

  if (await sendButton.count() === 0) {
    console.log('No send button found, pressing Enter');
    await input.press('Enter');
  } else {
    await sendButton.click();
  }

  console.log('⏳ Waiting for Claude to respond...');
  await page.waitForTimeout(3000);

  console.log('📊 Checking for response...');
  // Wait and watch for streaming
  for (let i = 0; i < 10; i++) {
    const status = await page.locator('text=/streaming/i').count();
    if (status > 0) {
      console.log('   ⚡ Response is streaming...');
    }
    await page.waitForTimeout(2000);
  }

  console.log('✅ Demo complete!');
  console.log('🖼️  Final screenshot saved');
  await page.screenshot({ path: 'tests/screenshots/demo-final.png', fullPage: true });

  // Keep browser open a bit longer so you can see
  await page.waitForTimeout(3000);
});
