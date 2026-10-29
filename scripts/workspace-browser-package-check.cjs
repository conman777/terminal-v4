const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const app = fs.realpathSync(process.argv[2]);
  const resources = path.join(app, 'Contents/Resources');
  const runtime = path.join(resources, 'browser-runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json')));
  const { chromium } = require(path.join(runtime, 'node_modules/playwright'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-relocated-session-'));
  const origin = 'http://127.0.0.1:3020';
  await assert.rejects(fetch(origin + '/api/health'), 'Port 3020 must be unused before the package fixture');
  const fixture = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.end('<title>Relocated bundled browser</title><input aria-label="Name" style="position:absolute;left:20px;top:20px"><button style="position:absolute;left:20px;top:70px" onclick="document.title=document.querySelector(\'input\').value">Apply</button>');
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const site = `http://127.0.0.1:${fixture.address().port}`;
  const apiOnly = process.env.TERMINAL_V4_PACKAGE_API_ONLY === '1';
  const packageEnv = { HOME: temporary, PATH: '/nonexistent', TMPDIR: temporary, TERMINAL_DATA_DIR: path.join(temporary, 'data'), TERMINAL_V4_LOCAL_TESTING: '1', LANG: 'en_US.UTF-8' };
  if (apiOnly) Object.assign(packageEnv, { HOST:'127.0.0.1', PORT:'3020', TERMINAL_V4_RUNTIME_ROOT:resources, TERMINAL_V4_FRONTEND_DIR:path.join(resources, 'frontend/dist') });
  const desktop = spawn(apiOnly ? path.join(resources, 'terminal-v4-api') : path.join(app, 'Contents/MacOS/terminal_v4_desktop'), [], {
    cwd: temporary, detached: true,
    env: packageEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; desktop.stdout.on('data', value => { logs += value; }); desktop.stderr.on('data', value => { logs += value; });
  let browser, session, token;
  async function request(url, method = 'GET', body) {
    const response = await fetch(origin + url, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${await (!response.ok ? response.text() : Promise.resolve(''))}`);
    return response.status === 204 ? null : response.json();
  }
  try {
    const deadline = Date.now() + 25000;
    while (true) {
      try { await request('/api/health'); break; }
      catch (error) { if (desktop.exitCode !== null || Date.now() > deadline) throw Error(`Relocated desktop failed: ${error.message}\n${logs}`); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const login = await request('/api/auth/local-testing', 'POST', { username: 'relocated-package-fixture' }); token = login.tokens.accessToken;
    const opened = await request('/api/workspace-browser/sessions', 'POST'); session = opened.id;
    const command = value => request(`/api/workspace-browser/sessions/${session}/command`, 'POST', value);
    const state = await command({ type: 'navigate', url: site });
    assert.equal(state.tabs.find(tab => tab.id === state.activeTabId).title, 'Relocated bundled browser');
    await command({ type: 'pointer', action: 'down', x: 40, y: 30 }); await command({ type: 'pointer', action: 'up', x: 40, y: 30 });
    await command({ type: 'text', text: 'RELOCATED_RUNTIME_WORKS' }); await command({ type: 'key', key: 'Tab' });
    const clicked = await command({ type: 'key', key: 'Enter' }); assert.equal(clicked.tabs.find(tab => tab.id === clicked.activeTabId).title, 'RELOCATED_RUNTIME_WORKS');
    const frame = await request(`/api/workspace-browser/sessions/${session}/frame`); assert.ok(frame.image.length > 1000); assert.equal(frame.engine.managed, true);
    const processes = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' });
    assert.ok(processes.split('\n').some(line => line.trim() === path.join(runtime, manifest.chromium)), 'Browser executable must come from relocated package');
    browser = await chromium.launch({ executablePath: path.join(runtime, manifest.chromium), headless:true, chromiumSandbox:true });
    const page = await browser.newPage({ viewport: { width:1440, height:960 } });
    await page.goto(origin); await page.evaluate(({ token, user }) => { localStorage.setItem('terminal_access_token', token); localStorage.setItem('terminal_user', JSON.stringify(user)); }, { token, user:login.user });
    await page.reload(); await page.getByRole('button', { name:'Browser', exact:true }).click();
    await page.getByRole('tab', { name:'RELOCATED_RUNTIME_WORKS', exact:true }).waitFor();
    await page.waitForFunction(() => {
      const surface = document.querySelector('.workspace-browser-surface');
      return surface && surface.querySelector('img')?.naturalWidth === Math.floor(surface.getBoundingClientRect().width);
    });
    await page.waitForTimeout(250);
    if (process.env.TERMINAL_V4_PACKAGE_OUTPUT) await page.screenshot({ path:path.join(process.env.TERMINAL_V4_PACKAGE_OUTPUT, 'relocated-package-desktop.png') });
    console.log(`PASS relocated release ${apiOnly ? 'package API' : 'desktop'} + embedded API/frontend/Node/Chromium, empty PATH, disposable home, navigation/input/click/frame + real Browser pane`);
    if (process.env.TERMINAL_V4_PACKAGE_UI_HOLD === '1') {
      console.log('Native interface QA ready; press Enter to clean up the synthetic session.');
      process.stdin.resume(); await once(process.stdin, 'data'); process.stdin.pause();
    }
  } finally {
    if (browser) await browser.close();
    if (session) await request(`/api/workspace-browser/sessions/${session}`, 'DELETE').catch(() => {});
    try { process.kill(-desktop.pid, 'SIGTERM'); } catch {}
    await Promise.race([once(desktop, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-desktop.pid, 'SIGKILL'); } catch {}
    fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
    fs.rmSync(temporary, { recursive:true, force:true });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
