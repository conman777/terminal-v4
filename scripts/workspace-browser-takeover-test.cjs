const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = process.env.TERMINAL_V4_BROWSER_RUNTIME_DIR;
const { chromium } = require(path.join(runtime, 'node_modules/playwright'));
const manifest = require(path.join(runtime, 'runtime.json'));

(async () => {
  const browser = await chromium.launch({ executablePath: path.join(runtime, manifest.chromium), headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(process.env.TERMINAL_V4_BROWSER_TEST_UI + '/e2e/fixtures/browser-takeover.html');
    await page.evaluate(token => localStorage.setItem('terminal_access_token', token), process.env.TERMINAL_V4_BROWSER_TEST_APP_TOKEN);
    await page.reload();
    const address = page.getByRole('textbox', { name: 'Browser address' });
    await address.fill(process.env.TERMINAL_V4_BROWSER_TEST_SITE);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByRole('tab', { name: 'Takeover target' }).waitFor();
    const press = page.evaluate(() => fetch('/api/__test_browser_press', { method: 'POST' }).then(response => response.json()));
    await page.getByText('Synthetic keyboard modal').waitFor();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByText('Finishing the agent’s keyboard action').waitFor();
    assert.equal(await page.getByRole('button', { name: 'New browser tab' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Let agents control' }).count(), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Let agents control' }).waitFor();
    await page.getByRole('tab', { name: 'KEY_RELEASED' }).waitFor();
    assert.match((await press).error, /dialog/i);

    await page.getByRole('button', { name: 'Let agents control' }).click();
    await address.fill(process.env.TERMINAL_V4_BROWSER_TEST_SITE + '?focus=1');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByRole('tab', { name: 'Takeover target' }).waitFor();
    const interrupted = page.evaluate(() => fetch('/api/__test_browser_press', { method: 'POST' }).then(response => response.json()));
    await page.getByText('Synthetic focus modal').waitFor();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('button', { name: 'Let agents control' }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('tab', { name: 'FOCUS_DONE' }).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('tab', { name: 'KEY_DOWN' }).count(), 0);
    assert.match((await interrupted).error, /dialog/i);
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
