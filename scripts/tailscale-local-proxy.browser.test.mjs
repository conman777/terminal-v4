import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createGateway } from './tailscale-local-proxy.mjs';

// Opt in only against an isolated local-testing API, never an existing user profile.
test('actual production app loads opaque preview modules through the identity gateway', { skip: process.env.TAILSCALE_GATEWAY_BROWSER_TEST !== '1', timeout: 45000 }, async t => {
  const scratch = await mkdtemp('/private/tmp/tailscale-gateway-browser-');
  for (const directory of ['claude', 'codex', 'hermes']) await mkdir(`${scratch}/${directory}`);
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const apiPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const processApi = spawn(new URL('../rust/target/debug/terminal-v4-api', import.meta.url).pathname, [], {
    env: { PATH: '/usr/bin:/bin', HOME: scratch, HOST: '127.0.0.1', PORT: String(apiPort), TERMINAL_DATA_DIR: `${scratch}/data`, TERMINAL_V4_LOCAL_TESTING: '1', JWT_SECRET: `synthetic-${randomUUID()}`, CLAUDE_CONFIG_DIR: `${scratch}/claude`, CODEX_HOME: `${scratch}/codex`, HERMES_HOME: `${scratch}/hermes` }, stdio: 'ignore'
  });
  t.after(async () => {
    processApi.kill('SIGTERM');
    if (processApi.exitCode === null && processApi.signalCode === null) await new Promise(resolve => { const timer = setTimeout(() => processApi.kill('SIGKILL'), 2000); processApi.once('exit', () => { clearTimeout(timer); resolve(); }); });
    await rm(scratch, { recursive: true, force: true });
  });
  const api = new URL(`http://127.0.0.1:${apiPort}`);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { ready = (await fetch(`${api.origin}/api/auth/mode`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'synthetic API started');
  const require = createRequire(import.meta.url);
  const { chromium } = require(require.resolve('playwright', { paths: [new URL('../frontend/', import.meta.url).pathname, new URL('../backend/', import.meta.url).pathname, new URL('../', import.meta.url).pathname] }));
  const externalHost = 'synthetic-device.synthetic-tail.ts.net';
  const allowedLogin = 'synthetic-browser-owner';
  const gateway = await createGateway({ allowedLogin, externalHost, upstreamPort: Number(api.port), port: 0 });
  const upstream = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture.test').pathname;
    if (path.endsWith('.js')) {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(path === '/main.js' ? "import {label} from './dep.js';document.querySelector('#result').textContent=label;" : "export const label='Opaque module through identity gateway';");
    } else if (path.endsWith('.css')) {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end('body{font:18px system-ui;background:#eff6ff;padding:32px}#result{color:rgb(18,52,86)}');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><h1 id="result">Loading opaque modules</h1><script type="module" src="/main.js"></script></body></html>');
    }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); });
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/*', socket => socket.close());
  const opaqueResponses = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== externalHost || url.protocol !== 'https:' || /\/stream(?:\?|$)|\/log-stream(?:\?|$)/.test(url.pathname)) { await route.abort(); return; }
    const result = await new Promise((resolve, reject) => {
      const headers = { ...request.headers(), host: externalHost, 'tailscale-user-login': allowedLogin };
      const outgoing = http.request({ hostname: '127.0.0.1', port: gateway.address().port, method: request.method(), path: url.pathname + url.search, headers }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      outgoing.on('error', reject);
      outgoing.end(request.postDataBuffer());
    });
    if (request.headers().origin === 'null') opaqueResponses.push({ path: url.pathname, status: result.status });
    await route.fulfill(result);
  });
  await page.goto(`https://${externalHost}`);
  console.log('Synthetic gateway app loaded');
  await page.getByLabel('Username', { exact: true }).fill(`gateway-browser-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('button', { name: 'New thread', exact: true }).waitFor();
  console.log('Synthetic gateway username flow authenticated');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByLabel('Preview URL', { exact: true }).fill(`http://127.0.0.1:${upstream.address().port}`);
  await page.getByLabel('Preview URL', { exact: true }).press('Enter');
  const heading = page.frameLocator('.preview-iframe').locator('#result');
  await heading.getByText('Opaque module through identity gateway', { exact: true }).waitFor();
  console.log('Opaque module rendered');
  assert.equal(await heading.evaluate(node => getComputedStyle(node).color), 'rgb(18, 52, 86)');
  assert.ok(opaqueResponses.some(response => response.path.endsWith('/main.js')));
  assert.ok(opaqueResponses.some(response => response.path.endsWith('/dep.js')));
  assert.ok(opaqueResponses.every(response => response.status === 200));
  assert.equal(await page.frameLocator('.preview-iframe').locator('body').evaluate(() => { try { localStorage.getItem('terminal_access_token'); return 'accessible'; } catch (error) { return error.name; } }), 'SecurityError');
  await mkdir('/private/tmp/terminal-v4-tailscale-gateway-browser', { recursive: true });
  await page.screenshot({ path: '/private/tmp/terminal-v4-tailscale-gateway-browser/opaque-preview-gateway.png' });
});
