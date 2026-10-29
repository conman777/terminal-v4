let chromium;
try {
  ({ chromium } = require(require.resolve('playwright', { paths: [process.cwd()] })));
} catch (_) {
  throw new Error('Playwright runtime unavailable. Run npm install in the Terminal V4 runtime directory.');
}

async function main() {
  const env = process.env;
  const url = env.TERMINAL_V4_SCREENSHOT_URL;
  const output = env.TERMINAL_V4_SCREENSHOT_OUTPUT;
  const selector = env.TERMINAL_V4_SCREENSHOT_SELECTOR;
  const width = Number(env.TERMINAL_V4_SCREENSHOT_WIDTH);
  const height = Number(env.TERMINAL_V4_SCREENSHOT_HEIGHT);
  if (!url || !output || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Missing screenshot configuration');
  const browser = await chromium.launch({
    headless: true,
    ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(10000);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    if (selector) await page.locator(selector).first().screenshot({ path: output, timeout: 10000 });
    else await page.screenshot({ path: output, fullPage: env.TERMINAL_V4_SCREENSHOT_FULL_PAGE === 'true' });
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error && error.stack ? error.stack : String(error)); if (String(error).includes("Executable doesn't exist")) console.error('Install Chromium with npx playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium browser.'); process.exitCode = 1; });
