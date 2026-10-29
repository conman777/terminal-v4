const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const projectRoot = path.resolve(__dirname, '../../../../..');
let playwrightWorkdir = projectRoot;
try { require.resolve('playwright', { paths: [projectRoot] }); }
catch (_) { playwrightWorkdir = path.join(projectRoot, 'backend'); }

test('screenshots use the browser locator API, honor viewport/full-page and reject missing elements', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-screenshot-'));
  try {
    const html = '<style>body{margin:0;height:1100px}#target{width:200px;height:80px;background:red}</style><div id="target"></div>';
    function capture(name, selector, fullPage) {
      const output = path.join(dir, name + '.png');
      const result = spawnSync(process.execPath, [path.join(__dirname, 'screenshot.js')], {
        env: { ...process.env, TERMINAL_V4_SCREENSHOT_URL: 'data:text/html,' + encodeURIComponent(html), TERMINAL_V4_SCREENSHOT_OUTPUT: output, TERMINAL_V4_SCREENSHOT_SELECTOR: selector, TERMINAL_V4_SCREENSHOT_FULL_PAGE: String(fullPage), TERMINAL_V4_SCREENSHOT_WIDTH: '640', TERMINAL_V4_SCREENSHOT_HEIGHT: '480' },
        cwd: playwrightWorkdir, timeout: 45000, encoding: 'utf8'
      });
      return { result, output };
    }
    for (const [name, selector, fullPage, dimensions] of [['element', '#target', false, [200, 80]], ['viewport', '', false, [640, 480]], ['full', '', true, [640, 1100]]]) {
      const { result, output } = capture(name, selector, fullPage);
      assert.equal(result.status, 0, result.stderr);
      const png = fs.readFileSync(output);
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], dimensions);
    }
    const missing = capture('missing', '#missing', false);
    assert.notEqual(missing.result.status, 0);
    assert.equal(fs.existsSync(missing.output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a packaged runtime without Playwright reports the install action', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-runtime-missing-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'screenshot.js')], { cwd: dir, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Playwright runtime unavailable\. Run npm install/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
