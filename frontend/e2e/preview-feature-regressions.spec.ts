import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openPreviewPanel, openDevToolsPanel } from './test-helpers';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated loopback app with synthetic local-testing accounts.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER, args: ['--host-resolver-rules=MAP api.preview.test 127.0.0.1, MAP ui.preview.test 127.0.0.1', '--no-proxy-server'] } });

async function enterSyntheticWorkspace(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`preview-check-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New thread', exact: true })).toBeVisible();
}

async function api(page: Page, endpoint: string, method = 'GET', body?: unknown) {
  return page.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(endpoint, {
      method, signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`${method} ${endpoint}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { endpoint, method, body });
}

test('real preview proxy injects inspector, loads modules, edits cookies and captures an element', async ({ page, request }, testInfo) => {
  test.setTimeout(90000);
  const fixture = createServer((incoming, response) => {
    const url = new URL(incoming.url || '/', 'http://fixture.test');
    if (url.pathname === '/style.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end("@import './nested.css';body{font:16px system-ui;padding:24px}");
    } else if (url.pathname === '/nested.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end("#target{display:block;width:200px;height:80px;background:#dbeafe;color:#123456;border:0;margin:0;position:absolute;top:200px;left:40px;background-image:url('./pixel.svg')}");
    } else if (url.pathname === '/pixel.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
    } else if (url.pathname === '/main.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end("import { label } from '/dep.js'; import { middle } from './relative.js'; const { tail } = await import('./lazy.js'); document.querySelector('#module').textContent = label + middle + tail; console.log('Synthetic preview console');");
    } else if (url.pathname === '/dep.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end("export const label = 'Module ';");
    } else if (url.pathname === '/relative.js' || url.pathname === '/lazy.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(url.pathname === '/relative.js' ? "export const middle = 'dependency ';" : "export const tail = 'loaded';");
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html', ...(!incoming.headers.cookie?.includes('session=') ? { 'Set-Cookie': 'session=initial; Path=/' } : {}) });
      response.end(`<!doctype html><html><head><title>Synthetic preview fixture</title><link rel="stylesheet" href="/style.css"></head><body><h1>Preview runtime fixture</h1><p id="module">Loading module</p><button id="target">Inspect this element</button><button id="navigate" onclick="history.pushState(null, '', '/current?theme=blue&amp;token=business-current#next')">Navigate route</button><p id="cookie">${incoming.headers.cookie || 'No cookie yet'}</p><script type="module" src="/main.js"></script></body></html>`);
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/preview/') || url.pathname === '/api/preview') requests.push(`${response.status()} ${url.pathname}`); });
  page.on('console', message => { if (message.type() === 'error') requests.push(message.text().replace(/token=[^&\s"']+/g, 'token=[redacted]')); });
  let screenshotFilename: string | undefined;
  try {
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && [new URL(testInfo.project.use.baseURL as string).port, String(port)].includes(url.port)) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
      if (window.top !== window) return;
      (window as any).__previewMessages = [];
      window.addEventListener('message', event => {
        if (String(event.data?.type || '').startsWith('preview-')) (window as any).__previewMessages.push(event.data);
      });
    });
    page.on('pageerror', error => errors.push(error.message));
    await enterSyntheticWorkspace(page);
    await openPreviewPanel(page);
    await page.getByLabel('Preview URL', { exact: true }).fill(`http://127.0.0.1:${port}`);
    await page.getByLabel('Preview URL', { exact: true }).press('Enter');
    const frame = page.frameLocator('.preview-iframe');
    await expect(frame.getByRole('heading', { name: 'Preview runtime fixture' })).toBeVisible();
    await expect(frame.locator('#module')).toHaveText('Module dependency loaded');
    await expect(frame.locator('#target')).toHaveCSS('width', '200px');
    await expect(page.locator('.preview-iframe')).toHaveAttribute('src', new RegExp(`/preview/${port}/`));
    expect(new URL((await page.locator('.preview-iframe').getAttribute('src'))!, testInfo.project.use.baseURL as string).searchParams.has('token')).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).__previewMessages.some((message: any) => message.type === 'preview-inspector-ready'))).toBe(true);
    await page.getByRole('button', { name: 'Inspect element', exact: true }).click();
    await frame.locator('#target').click();
    const inspector = page.locator('.preview-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('.preview-inspector-selector')).toHaveText('#target');
    await expect.poll(() => page.evaluate(() => (window as any).__previewMessages.find((message: any) => message.type === 'preview-element-selected')?.element?.rect?.width)).toBe(200);
    await page.screenshot({ path: testInfo.outputPath('proxy-inspector-selection.png'), animations: 'disabled' });
    await inspector.getByRole('button', { name: 'Edit styles', exact: true }).click();
    const styleEditor = inspector.locator('.style-editor');
    await expect(styleEditor).toBeVisible();
    await styleEditor.locator('.style-control').filter({ has: page.locator('label', { hasText: /^Width$/ }) }).locator('input[type=number]').fill('240');
    await expect(frame.locator('#target')).toHaveCSS('width', '240px');
    await styleEditor.getByRole('button', { name: 'Revert', exact: true }).click();
    await expect(frame.locator('#target')).toHaveCSS('width', '200px');
    await expect.poll(async () => { const data = await api(page, `/api/preview/${port}/performance`); return data.metrics?.runtimeMetrics?.some((metric: any) => Number.isFinite(metric.data?.fps) && metric.data.fps > 0) || false; }, { timeout: 7000 }).toBe(true);
    await expect.poll(async () => (await api(page, `/api/preview/${port}/logs`)).logs.some((entry: any) => entry.message === 'Synthetic preview console')).toBe(true);
    await page.getByRole('button', { name: 'Exit inspect element', exact: true }).click();
    await frame.locator('#navigate').click();
    await expect(page.getByLabel('Preview URL', { exact: true })).toHaveValue(`http://localhost:${port}/current?theme=blue&token=business-current#next`);
    await openDevToolsPanel(page);
    await page.locator('.devtools-tab', { hasText: 'Storage' }).click();
    await page.locator('.storage-tree-item', { hasText: 'Cookies' }).click();
    const row = page.locator('.storage-row').filter({ has: page.locator('.col-key code', { hasText: /^session$/ }) });
    expect((await api(page, `/api/preview/${port}/cookies`)).cookies.find((cookie: { name: string }) => cookie.name === 'session').value).toBe('initial');
    await expect(row.locator('.value-display')).toHaveText('initial', { timeout: 15000 });
    await row.getByTitle('Edit', { exact: true }).click();
    await row.locator('.edit-input').fill('edited-through-devtools');
    await row.getByTitle('Save', { exact: true }).click();
    await expect(row.locator('.value-display')).toHaveText('edited-through-devtools');
    expect((await api(page, `/api/preview/${port}/cookies`)).cookies.find((cookie: { name: string }) => cookie.name === 'session').value).toBe('edited-through-devtools');
    await page.getByRole('button', { name: 'Reload preview', exact: true }).click();
    await expect(page.locator('.preview-iframe')).toHaveAttribute('src', new RegExp(`/preview/${port}/current\\?`));
    const refreshed = new URL((await page.locator('.preview-iframe').getAttribute('src'))!, testInfo.project.use.baseURL as string);
    expect([refreshed.pathname, refreshed.searchParams.get('token'), refreshed.hash]).toEqual([`/preview/${port}/current`, 'business-current', '#next']);
    await expect(frame.locator('#cookie')).toContainText('session=edited-through-devtools');
    await expect(frame.locator('#module')).toHaveText('Module dependency loaded');
    await page.screenshot({ path: testInfo.outputPath('proxy-cookie-edit-reloaded.png'), animations: 'disabled' });
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Open preview in new tab', exact: true }).click();
    const popup = await popupPromise;
    try {
      await expect(popup.locator('#module')).toHaveText('Module dependency loaded');
      expect(new URL(popup.url()).searchParams.get('token')).toBe('business-current');
      expect(await popup.evaluate(() => ['localStorage', 'sessionStorage'].map(name => {
        try { window[name as 'localStorage' | 'sessionStorage'].getItem('terminal_access_token'); return 'accessible'; }
        catch (error) { return (error as Error).name; }
      }))).toEqual(['SecurityError', 'SecurityError']);
      await popup.screenshot({ path: testInfo.outputPath('top-level-preview-isolated.png'), animations: 'disabled' });
    } finally { await popup.close(); await page.bringToFront(); }

    const capture = await api(page, `/api/preview/${port}/screenshot/element`, 'POST', { selector: '#target', width: 640, height: 480 });
    screenshotFilename = capture.filename;
    const token = await page.evaluate(() => localStorage.getItem('terminal_access_token'));
    const downloaded = await request.get(`/api/preview/screenshots/${capture.filename}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(downloaded.ok()).toBe(true);
    const png = await downloaded.body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([200, 80]);
    await testInfo.attach('api-element-screenshot', { body: png, contentType: 'image/png' });
    expect(errors).toEqual([]);
  } finally {
    await testInfo.attach('preview-network', { body: requests.join('\n'), contentType: 'text/plain' });
    const messages = await page.evaluate(() => (window as any).__previewMessages?.filter((message: any) => ['preview-inspector-ready', 'preview-element-selected'].includes(message.type)) || []).catch(() => []);
    writeFileSync(testInfo.outputPath('preview-inspector-messages.json'), JSON.stringify(messages, null, 2));
    await testInfo.attach('preview-inspector-messages', { body: JSON.stringify(messages, null, 2), contentType: 'application/json' });
    if (screenshotFilename) await api(page, `/api/preview/screenshots/${screenshotFilename}`, 'DELETE').catch(() => {});
    await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
  }
});

test('static query preview renders nested CSS and module dependencies with escaped filenames', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_PREVIEW_WORKSPACE, 'Set E2E_PREVIEW_WORKSPACE to a scratch directory allowed by PREVIEW_PROJECT_ROOT.');
  const directory = mkdtempSync(path.join(process.env.E2E_PREVIEW_WORKSPACE!, 'preview-browser-'));
  mkdirSync(path.join(directory, 'pages', 'assets'), { recursive: true });
  writeFileSync(path.join(directory, 'pages', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/style%20+%C3%A9.css"></head><body><h1 id="static">Loading static module</h1><script type="module" src="app.js"></script></body></html>');
  writeFileSync(path.join(directory, 'pages', 'assets', 'style +é.css'), '#static{color:rgb(34,51,68);font:28px system-ui}body{padding:36px;background:#eff6ff}');
  writeFileSync(path.join(directory, 'pages', 'app.js'), "import { label } from './dep.js'; document.querySelector('#static').textContent=label;");
  writeFileSync(path.join(directory, 'pages', 'dep.js'), "export const label='Static module dependency loaded';");
  try {
    await enterSyntheticWorkspace(page);
    await openPreviewPanel(page);
    await page.getByLabel('Preview URL', { exact: true }).fill(path.join(directory, 'pages', 'index.html'));
    await page.getByLabel('Preview URL', { exact: true }).press('Enter');
    const heading = page.frameLocator('.preview-iframe').locator('#static');
    await expect(heading).toHaveText('Static module dependency loaded');
    await expect(heading).toHaveCSS('color', 'rgb(34, 51, 68)');
    expect(new URL((await page.locator('.preview-iframe').getAttribute('src'))!, testInfo.project.use.baseURL as string).searchParams.has('token')).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('static-css-module-dependencies.png'), animations: 'disabled' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('paired preview modules render through scoped local resources while the remote grant stays authoritative', async ({ page, request }, testInfo) => {
  test.setTimeout(90000);
  const root = mkdtempSync(path.join(tmpdir(), 'preview-paired-browser-'));
  for (const directory of ['claude', 'codex', 'hermes', 'workspace']) mkdirSync(path.join(root, directory));
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const apiPort = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const remoteBase = `http://127.0.0.1:${apiPort}`;
  const binary = process.env.E2E_API_BINARY || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../rust/target/debug/terminal-v4-api');
  const remote = spawn(binary, [], {
    env: { PATH: '/usr/bin:/bin', HOST: '127.0.0.1', HOME: root, PORT: String(apiPort), TERMINAL_DATA_DIR: path.join(root, 'data'), TERMINAL_V4_LOCAL_TESTING: '1', JWT_SECRET: `synthetic-preview-${Date.now()}`, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), HERMES_HOME: path.join(root, 'hermes') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  remote.stdout.on('data', chunk => appendFileSync(testInfo.outputPath('remote-api.log'), chunk));
  remote.stderr.on('data', chunk => appendFileSync(testInfo.outputPath('remote-api.log'), chunk));
  const fixture = createServer((incoming, response) => {
    const url = new URL(incoming.url || '/', 'http://fixture.test');
    expect(url.searchParams.has('previewToken')).toBe(false);
    expect(incoming.headers.authorization).toBeUndefined();
    if (url.pathname.endsWith('.js')) {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(url.pathname === '/main.js' ? "import { first } from '/absolute.js'; import { second } from './relative.js'; const { third } = await import('./lazy.js'); document.querySelector('#paired-module').textContent=first+second+third;" : url.pathname === '/absolute.js' ? "export const first='Paired ';" : url.pathname === '/relative.js' ? "export const second='module ';" : "export const third='dependencies loaded';");
    } else if (url.pathname.endsWith('.css')) {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end(url.pathname === '/style.css' ? "@import './nested.css';" : 'body{background:#eff6ff;padding:28px;font:18px system-ui}#paired-module{color:rgb(18,52,86)}');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1 id="paired-module">Loading paired modules</h1><script type="module" src="/main.js"></script></body></html>');
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (fixture.address() as { port: number }).port;
  let environment: any;
  try {
    await expect.poll(async () => (await request.get(`${remoteBase}/api/auth/mode`).catch(() => null))?.ok() || false).toBe(true);
    const authResponse = await request.post(`${remoteBase}/api/auth/local-testing`, { data: { username: 'synthetic-paired-preview' } });
    expect(authResponse.ok()).toBe(true);
    const remoteAuth = await authResponse.json();
    const codeResponse = await request.post(`${remoteBase}/api/environments/pairing-code`, { headers: { Authorization: `Bearer ${remoteAuth.tokens.accessToken}` }, data: { label: 'Synthetic preview browser', profile: 'observer' } });
    const code = await codeResponse.json();
    await enterSyntheticWorkspace(page);
    environment = await api(page, '/api/environments/connect', 'POST', { url: remoteBase, code: code.code, label: 'Synthetic preview remote' });
    await page.reload();
    await page.getByRole('region', { name: 'Active environment' }).getByRole('button', { name: /Environment Home server/ }).click();
    await page.getByRole('button', { name: 'Use Synthetic preview remote', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Active environment' })).toContainText('Synthetic preview remote');
    const closeEnvironmentDialog = page.getByRole('button', { name: 'Close environments', exact: true });
    if (await closeEnvironmentDialog.isVisible()) await closeEnvironmentDialog.click();
    await expect(page.getByRole('dialog', { name: 'Environments', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.preview-panel')).toBeVisible();
    await page.getByLabel('Preview URL', { exact: true }).fill(`http://127.0.0.1:${upstreamPort}`);
    await page.getByLabel('Preview URL', { exact: true }).press('Enter');
    const heading = page.frameLocator('.preview-iframe').locator('#paired-module');
    await expect(heading).toHaveText('Paired module dependencies loaded');
    await expect(heading).toHaveCSS('color', 'rgb(18, 52, 86)');
    await expect.poll(async () => { const data = await api(page, `/api/environments/${environment.id}/proxy/api/preview/${upstreamPort}/performance`); return data.metrics?.runtimeMetrics?.some((metric: any) => Number.isFinite(metric.data?.fps) && metric.data.fps > 0) || false; }, { timeout: 7000 }).toBe(true);
    expect(new URL((await page.locator('.preview-iframe').getAttribute('src'))!, testInfo.project.use.baseURL as string).searchParams.has('token')).toBe(false);
    await expect(page.locator('.preview-iframe')).toHaveAttribute('src', new RegExp(`/api/environments/${environment.id}/proxy/preview/${upstreamPort}/`));
    await page.screenshot({ path: testInfo.outputPath('paired-module-dependencies.png'), animations: 'disabled' });
    const requests = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    expect(requests.some(url => url.includes('tv4pair.'))).toBe(false);
    await page.getByRole('button', { name: 'Return home', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Active environment' })).toContainText('Home server');
  } finally {
    if (environment) await api(page, `/api/environments/${environment.id}`, 'DELETE').catch(() => {});
    remote.kill('SIGTERM');
    await new Promise<void>(resolve => { if (remote.exitCode !== null || remote.signalCode !== null) { resolve(); return; } const timer = setTimeout(() => remote.kill('SIGKILL'), 2000); remote.once('exit', () => { clearTimeout(timer); resolve(); }); });
    await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
    rmSync(root, { recursive: true, force: true });
  }
});

test('separate-origin production frontend prepares a preview without credentialed cookies or token URLs', async ({ page, request, context }, testInfo) => {
  test.skip(process.env.E2E_CROSS_ORIGIN_PREVIEW !== '1', 'Opt in to the scratch production build with E2E_CROSS_ORIGIN_PREVIEW=1.');
  test.setTimeout(120000);
  const scratch = mkdtempSync(path.join(tmpdir(), 'preview-cross-origin-'));
  const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const apiPort = new URL(testInfo.project.use.baseURL as string).port;
  const apiOrigin = `http://api.preview.test:${apiPort}`;
  const output = path.join(scratch, 'dist');
  execFileSync(process.execPath, [path.join(frontend, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', output], { cwd: frontend, env: { PATH: process.env.PATH, VITE_API_URL: apiOrigin }, stdio: 'pipe', timeout: 90000 });
  const ui = createServer((incoming, response) => {
    let relative = decodeURIComponent(new URL(incoming.url || '/', 'http://ui.preview.test').pathname);
    if (relative === '/') relative = '/index.html';
    const file = path.resolve(output, '.' + relative);
    if (!file.startsWith(output + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404); response.end(); return; }
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  const uiOrigin = `http://ui.preview.test:${(ui.address() as { port: number }).port}`;
  const fixture = createServer((incoming, response) => {
    if (incoming.url?.startsWith('/main.js')) {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end("document.querySelector('#cross-origin').textContent='Cross-origin preview module loaded';");
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head></head><body><h1 id="cross-origin">Loading cross-origin module</h1><script type="module" src="/main.js"></script></body></html>');
    }
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.address() as { port: number }).port;
  try {
    const authResponse = await request.post('/api/auth/local-testing', { data: { username: `cross-preview-${Date.now()}` } });
    expect(authResponse.ok()).toBe(true);
    const auth = await authResponse.json();
    await page.addInitScript(auth => {
      if (window.top !== window || location.hostname !== 'ui.preview.test') return;
      localStorage.setItem('terminal_access_token', auth.tokens.accessToken);
      localStorage.setItem('terminal_refresh_token', auth.tokens.refreshToken);
      localStorage.setItem('terminal_user', JSON.stringify(auth.user));
    }, auth);
    await page.route('**/*', route => ['ui.preview.test', 'api.preview.test'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(uiOrigin);
    await expect(page.getByRole('button', { name: 'New thread', exact: true })).toBeVisible();
    expect((await context.cookies(apiOrigin)).filter(cookie => cookie.name === 'terminal_preview_token')).toEqual([]);
    await openPreviewPanel(page);
    await page.getByLabel('Preview URL', { exact: true }).fill(`http://127.0.0.1:${fixturePort}`);
    await page.getByLabel('Preview URL', { exact: true }).press('Enter');
    const heading = page.frameLocator('.preview-iframe').locator('#cross-origin');
    await expect(heading).toHaveText('Cross-origin preview module loaded');
    const frameUrl = new URL((await page.locator('.preview-iframe').getAttribute('src'))!);
    expect(frameUrl.origin).toBe(apiOrigin);
    expect(frameUrl.searchParams.has('token')).toBe(false);
    expect(frameUrl.searchParams.has('previewToken')).toBe(true);
    expect((await context.cookies(apiOrigin)).filter(cookie => cookie.name === 'terminal_preview_token')).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('cross-origin-cookie-free-preview.png'), animations: 'disabled' });
  } finally {
    await new Promise<void>(resolve => { ui.close(() => resolve()); ui.closeAllConnections(); });
    await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
    rmSync(scratch, { recursive: true, force: true });
  }
});


test('actual PiP component prepares fresh scoped grants on refresh and minimize-expand', async ({ page, request }, testInfo) => {
  test.skip(process.env.E2E_CROSS_ORIGIN_PREVIEW !== '1', 'Opt in to scratch component production builds.');
  test.setTimeout(90000);
  const scratch = mkdtempSync('/private/tmp/preview-pip-browser-');
  const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const apiOrigin = `http://api.preview.test:${new URL(testInfo.project.use.baseURL as string).port}`;
  const fixture = createServer((_incoming, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><head></head><body><h1>Actual PiP preview loaded</h1></body></html>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixturePort = (fixture.address() as { port: number }).port;
  writeFileSync(path.join(scratch, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  writeFileSync(path.join(scratch, 'main.jsx'), `import React from 'react';import {createRoot} from 'react-dom/client';import {PreviewPip} from ${JSON.stringify(path.join(frontend, 'src/components/PreviewPip.jsx'))};import ${JSON.stringify(path.join(frontend, 'src/styles.css'))};createRoot(document.getElementById('root')).render(<PreviewPip url="http://127.0.0.1:${fixturePort}" position={{x:40,y:40}} size={{width:500,height:340}} />);`);
  const output = path.join(scratch, 'dist');
  const buildScript = `import {build} from ${JSON.stringify(path.join(frontend, 'node_modules/vite/dist/node/index.js'))};await build({configFile:false,root:${JSON.stringify(scratch)},esbuild:{jsx:'automatic'},resolve:{alias:{react:${JSON.stringify(path.join(frontend, 'node_modules/react'))},'react-dom':${JSON.stringify(path.join(frontend, 'node_modules/react-dom'))}}},define:{'import.meta.env.VITE_API_URL':${JSON.stringify(JSON.stringify(apiOrigin))}},build:{outDir:${JSON.stringify(output)}}});`;
  try { execFileSync(process.execPath, ['--input-type=module', '-e', buildScript], { cwd: frontend, stdio: 'pipe', timeout: 60000 }); } catch (error) { await new Promise<void>(resolve => fixture.close(() => resolve())); rmSync(scratch, { recursive: true, force: true }); throw error; }
  const ui = createServer((incoming, response) => {
    const relative = new URL(incoming.url || '/', 'http://ui.preview.test').pathname;
    const file = path.join(output, relative === '/' ? 'index.html' : relative);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404); response.end(); return; }
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(readFileSync(file));
  });
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve));
  try {
    const authResponse = await request.post('/api/auth/local-testing', { data: { username: `pip-preview-${Date.now()}` } });
    expect(authResponse.ok()).toBe(true);
    const auth = await authResponse.json();
    await page.addInitScript(auth => { if (window.top === window && location.hostname === 'ui.preview.test') { localStorage.setItem('terminal_access_token', auth.tokens.accessToken); localStorage.setItem('terminal_refresh_token', auth.tokens.refreshToken); localStorage.setItem('terminal_user', JSON.stringify(auth.user)); } }, auth);
    await page.route('**/*', route => ['ui.preview.test', 'api.preview.test'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    let grants = 0;
    page.on('request', incoming => { if (incoming.method() === 'POST' && new URL(incoming.url()).pathname === '/api/preview/resource-auth') grants += 1; });
    await page.goto(`http://ui.preview.test:${(ui.address() as { port: number }).port}`);
    const heading = () => page.frameLocator('.pip-iframe').getByRole('heading', { name: 'Actual PiP preview loaded' });
    await expect(heading()).toBeVisible();
    const firstGrants = grants;
    expect(firstGrants).toBeGreaterThan(0);
    expect(new URL((await page.locator('.pip-iframe').getAttribute('src'))!).searchParams.has('token')).toBe(false);
    await page.getByTitle('Refresh', { exact: true }).click();
    await expect.poll(() => grants).toBeGreaterThan(firstGrants);
    await expect(heading()).toBeVisible();
    const refreshGrants = grants;
    await page.getByTitle('Minimize', { exact: true }).click();
    await expect(page.locator('.pip-iframe')).toHaveCount(0);
    await page.getByTitle('Expand', { exact: true }).click();
    await expect.poll(() => grants).toBeGreaterThan(refreshGrants);
    await expect(heading()).toBeVisible();
    expect(await page.frameLocator('.pip-iframe').locator('body').evaluate(() => { try { localStorage.getItem('terminal_access_token'); return 'accessible'; } catch (error) { return (error as Error).name; } })).toBe('SecurityError');
    await page.screenshot({ path: testInfo.outputPath('actual-pip-component-refreshed.png'), animations: 'disabled' });
  } finally {
    await new Promise<void>(resolve => { ui.close(() => resolve()); ui.closeAllConnections(); });
    await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
    rmSync(scratch, { recursive: true, force: true });
  }
});
