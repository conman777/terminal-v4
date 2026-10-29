const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../../../..');
const runtime = path.join(projectRoot, '.runtime/browser');
const { chromium } = require(require.resolve('playwright', {
  paths: [runtime, path.join(projectRoot, 'frontend'), path.join(projectRoot, 'backend')],
}));
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'));
const source = fs.readFileSync(path.join(__dirname, 'script_inject.rs'), 'utf8');
const template = source.match(/r#"(<script data-preview-debug="true">[\s\S]*?<\/script>)"#/)[1];
const port = 4173;
const parentOrigin = 'http://127.0.0.1:43001';
const outsiderOrigin = 'http://127.0.0.1:43003';

function injectedHtml(previewBasePath, { controllerOrigin = parentOrigin, expiresAt = Math.floor(Date.now() / 1000) + 900, evaluationEnabled = true } = {}) {
  const controller = controllerOrigin ? { origin: controllerOrigin, expiresAt } : null;
  const script = template.replaceAll('{{', '{').replaceAll('}}', '}')
    .replaceAll('{port}', String(port)).replaceAll('{api_origin}', 'http://localhost:3020')
    .replaceAll('{preview_base_path}', previewBasePath).replaceAll('{evaluation_enabled}', String(evaluationEnabled))
    .replace('  var previewController = null;', `  var previewController = ${JSON.stringify(controller)};`);
  return `${script}<button id="target">Fixture</button><iframe src="${outsiderOrigin}/child"></iframe><script>addEventListener('message',e=>{if(e.data?.fixtureBarrier)window.fixtureBarrier=e.data.fixtureBarrier;});window.fixtureReady = true;</script>`;
}

async function fixture(t, { previewOrigin = parentOrigin, previewPath = '/preview/4173/page', sandbox = false, controllerPageOrigin = parentOrigin, ...binding } = {}) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || path.resolve(runtime, manifest.chromium),
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const previewUrl = `${previewOrigin}${previewPath}?previewToken=synthetic-read-only-grant`;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, '127.0.0.1', 'fixture must never contact a real host');
    let body = '<!doctype html><p>Disposable outsider</p>';
    if (url.pathname === '/controller') {
      body = `<script>window.messages=[];addEventListener('message',e=>messages.push(e.data));</script><iframe id="preview" ${sandbox ? 'sandbox="allow-scripts"' : ''} src="${previewUrl}"></iframe><iframe id="sibling" src="${outsiderOrigin}/sibling"></iframe>`;
    } else if (url.href === previewUrl) {
      body = injectedHtml(previewPath.startsWith('/preview/') ? '/preview/4173' : '', binding);
    }
    return route.fulfill({ contentType: 'text/html', body });
  });
  await page.goto(`${controllerPageOrigin}/controller`);
  const frame = page.frames().find(candidate => candidate.url() === previewUrl);
  assert.ok(frame, 'preview frame loaded');
  await frame.waitForFunction(() => window.fixtureReady);
  const child = frame.childFrames()[0];
  const sibling = page.frames().find(candidate => candidate.url() === `${outsiderOrigin}/sibling`);
  await child.waitForLoadState();
  await sibling.waitForLoadState();
  return { page, frame, child, sibling, previewUrl };
}

async function send(page, payload) {
  await page.evaluate(payload => document.querySelector('#preview').contentWindow.postMessage(payload, '*'), payload);
}

const commands = [
  { type: 'preview-evaluate', expression: 'window.unexpectedEvaluation = true' },
  { type: 'preview-storage-operation', storageType: 'localStorage', operation: 'set', key: 'outsider', value: 'injected' },
  { type: 'preview-storage-restore', port, local: { restoredByOutsider: 'injected' }, session: { restoredByOutsider: 'injected' } },
  { type: 'preview-clear-storage' },
];

test('real child, sibling and self postMessages cannot evaluate, restore, mutate or clear preview storage', async t => {
  const { page, frame, child, sibling } = await fixture(t);
  for (const sender of ['child', 'sibling', 'self']) {
    await frame.evaluate(() => {
      delete window.unexpectedEvaluation;
      localStorage.clear(); sessionStorage.clear();
      localStorage.setItem('keep', 'local'); sessionStorage.setItem('keep', 'session');
    });
    const messages = [...commands, { fixtureBarrier: sender }];
    if (sender === 'child') await child.evaluate(commands => commands.forEach(data => parent.postMessage(data, '*')), messages);
    if (sender === 'sibling') await sibling.evaluate(commands => commands.forEach(data => parent.frames[0].postMessage(data, '*')), messages);
    if (sender === 'self') await frame.evaluate(commands => commands.forEach(data => window.postMessage(data, '*')), messages);
    await frame.waitForFunction(sender => window.fixtureBarrier === sender, sender);
    const actual = await frame.evaluate(() => ({
      evaluated: window.unexpectedEvaluation === true,
      local: Object.fromEntries(Object.keys(localStorage).filter(key => typeof localStorage[key] === 'string').map(key => [key, localStorage.getItem(key)])),
      session: Object.fromEntries(Object.keys(sessionStorage).filter(key => typeof sessionStorage[key] === 'string').map(key => [key, sessionStorage.getItem(key)])),
    }));
    assert.deepEqual(actual, { evaluated: false, local: { keep: 'local' }, session: { keep: 'session' } }, sender);
  }
  await send(page, { type: 'preview-evaluate', expression: 'window.authorizedEvaluation = 42' });
  await frame.waitForFunction(() => window.authorizedEvaluation === 42);
});

test('a top-level preview cannot command itself', async t => {
  const { page, previewUrl } = await fixture(t);
  await page.goto(previewUrl);
  await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(commands => {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('keep', 'local'); sessionStorage.setItem('keep', 'session');
    [...commands, { fixtureBarrier: 'top' }].forEach(data => window.postMessage(data, '*'));
  }, commands);
  await page.waitForFunction(() => window.fixtureBarrier === 'top');
  assert.deepEqual(await page.evaluate(() => ({
    evaluated: window.unexpectedEvaluation === true,
    local: Object.fromEntries(Object.keys(localStorage).filter(key => typeof localStorage[key] === 'string').map(key => [key, localStorage.getItem(key)])),
    session: Object.fromEntries(Object.keys(sessionStorage).filter(key => typeof sessionStorage[key] === 'string').map(key => [key, sessionStorage.getItem(key)])),
  })), { evaluated: false, local: { keep: 'local' }, session: { keep: 'session' } });
});

for (const transport of [
  { name: 'same-host path', previewPath: '/preview/4173/page' },
  { name: 'different-origin subdomain equivalent', previewOrigin: 'http://127.0.0.1:43002', previewPath: '/page' },
  { name: 'Home paired path', previewPath: '/api/environments/synthetic/proxy/preview/4173/page' },
]) {
  test(`authorized parent retains eval and storage workflows over ${transport.name}`, async t => {
    const { page, frame } = await fixture(t, transport);
    await send(page, { type: 'preview-storage-restore', port, local: { restored: 'local' }, session: { restored: 'session' } });
    await frame.waitForFunction(() => localStorage.getItem('restored') === 'local' && sessionStorage.getItem('restored') === 'session');
    for (const storageType of ['localStorage', 'sessionStorage']) {
      await send(page, { type: 'preview-storage-operation', storageType, operation: 'set', key: 'fixture', value: 'set' });
      await frame.waitForFunction(type => window[type].getItem('fixture') === 'set', storageType);
      await send(page, { type: 'preview-storage-operation', storageType, operation: 'remove', key: 'fixture' });
      await frame.waitForFunction(type => window[type].getItem('fixture') === null, storageType);
      await send(page, { type: 'preview-storage-operation', storageType, operation: 'import', entries: { imported: 'yes' } });
      await frame.waitForFunction(type => window[type].getItem('imported') === 'yes', storageType);
    }
    await send(page, { type: 'preview-clear-storage' });
    await frame.waitForFunction(() => localStorage.length === 0 && sessionStorage.length === 0);
    await send(page, { type: 'preview-evaluate', expression: 'window.authorizedEvaluation = 42' });
    await frame.waitForFunction(() => window.authorizedEvaluation === 42);
    await page.waitForFunction(() => messages.some(message => message.type === 'preview-console' && message.message === '42'));
    await page.waitForFunction(() => messages.some(message => message.type === 'preview-log-batch'));
  });
}

test('opaque sandbox retains parent evaluation/logging and reports storage unavailable', async t => {
  const { page, frame, child } = await fixture(t, { sandbox: true });
  await child.evaluate(commands => commands.forEach(data => parent.postMessage(data, '*')), [...commands, { fixtureBarrier: 'opaque' }]);
  await frame.waitForFunction(() => window.fixtureBarrier === 'opaque');
  assert.equal(await frame.evaluate(() => window.unexpectedEvaluation === true), false);
  await send(page, { type: 'preview-evaluate', expression: 'window.authorizedEvaluation = 42' });
  await frame.waitForFunction(() => window.authorizedEvaluation === 42);
  assert.equal(await frame.evaluate(() => { try { localStorage.getItem('fixture'); return 'accessible'; } catch (error) { return error.name; } }), 'SecurityError');
  await page.waitForFunction(() => messages.some(message => message.type === 'preview-storage-sync' && message.available.localStorage === false && message.available.sessionStorage === false));
  await page.waitForFunction(() => messages.some(message => message.type === 'preview-log-batch'));
});

for (const binding of [
  { name: 'no controller grant', controllerOrigin: null },
  { name: 'a different actual parent origin', controllerPageOrigin: outsiderOrigin },
  { name: 'an expired controller grant', expiresAt: 1 },
]) {
  test(`parent control stays denied with ${binding.name}`, async t => {
    const { page, frame } = await fixture(t, binding);
    await frame.evaluate(() => { localStorage.clear(); localStorage.setItem('keep', 'local'); });
    for (const command of [...commands, { fixtureBarrier: 'denied' }]) await send(page, command);
    await frame.waitForFunction(() => window.fixtureBarrier === 'denied');
    assert.deepEqual(await frame.evaluate(() => ({
      evaluated: window.unexpectedEvaluation === true,
      keep: localStorage.getItem('keep'), injected: localStorage.getItem('outsider'), restored: localStorage.getItem('restoredByOutsider'),
    })), { evaluated: false, keep: 'local', injected: null, restored: null });
    await page.waitForFunction(() => messages.some(message => message.type === 'preview-storage-sync'));
  });
}

test('receiver enforces the server eval opt-in even for its authorized parent', async t => {
  const { page, frame } = await fixture(t, { evaluationEnabled: false });
  await send(page, commands[0]);
  await send(page, { fixtureBarrier: 'eval-disabled' });
  await frame.waitForFunction(() => window.fixtureBarrier === 'eval-disabled');
  assert.equal(await frame.evaluate(() => window.unexpectedEvaluation === true), false);
  await send(page, { type: 'preview-storage-operation', storageType: 'localStorage', operation: 'set', key: 'allowed', value: 'storage' });
  await frame.waitForFunction(() => localStorage.getItem('allowed') === 'storage');
});

test('null-source and non-parent ancestors cannot supply controller commands', async t => {
  const { page, frame } = await fixture(t);
  await frame.evaluate(({ commands, origin }) => commands.forEach(data => dispatchEvent(new MessageEvent('message', { data, origin, source: null }))), { commands, origin: parentOrigin });
  assert.equal(await frame.evaluate(() => window.unexpectedEvaluation === true), false);
  await frame.evaluate(() => {
    const nested = document.createElement('iframe'); nested.id = 'nested-preview'; document.body.appendChild(nested);
  });
  const nested = frame.childFrames().find(candidate => candidate.url() === 'about:blank');
  await nested.setContent(injectedHtml(''));
  await page.evaluate(commands => commands.forEach(data => frames[0].frames[1].postMessage(data, '*')), [...commands, { fixtureBarrier: 'ancestor' }]);
  await nested.waitForFunction(() => window.fixtureBarrier === 'ancestor');
  assert.equal(await nested.evaluate(() => window.unexpectedEvaluation === true), false);
});

test('actual HTTP Tailscale gateway, signed grant and opaque receiver retain their control boundary', {
  skip: !process.env.PREVIEW_CONTROLLER_FIXTURE_API,
}, async t => {
  const http = require('node:http');
  const { pathToFileURL } = require('node:url');
  const { createGateway } = await import(pathToFileURL(path.join(projectRoot, 'scripts/tailscale-local-proxy.mjs')).href);
  const api = new URL(process.env.PREVIEW_CONTROLLER_FIXTURE_API);
  assert.equal(api.hostname, '127.0.0.1');
  const previewPort = Number(process.env.PREVIEW_CONTROLLER_FIXTURE_PORT);
  const evalEnabled = process.env.PREVIEW_CONTROLLER_FIXTURE_EVAL === 'true';
  const externalHost = 'synthetic-controller.synthetic-tail.ts.net';
  const origin = `http://${externalHost}:8080`;
  const gateway = await createGateway({ allowedLogin: 'synthetic-controller', externalHost, externalOrigin: origin, upstreamPort: Number(api.port), port: 0 });
  t.after(() => new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: path.resolve(runtime, manifest.chromium) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'only the synthetic gateway may be addressed');
    if (url.pathname === '/fixture-controller') {
      return route.fulfill({ contentType: 'text/html', body: '<script>window.messages=[];addEventListener("message",e=>messages.push(e.data));</script><iframe id="preview" sandbox="allow-scripts"></iframe>' });
    }
    const result = await new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port: gateway.address().port,
        method: request.method(), path: url.pathname + url.search,
        headers: { ...request.headers(), host: `${externalHost}:8080`, 'tailscale-user-login': 'synthetic-controller',
          'x-terminal-preview-controller-origin': 'http://attacker.synthetic.invalid:8080' },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      outgoing.on('error', reject);
      outgoing.end(request.postDataBuffer());
    });
    return route.fulfill(result);
  });
  const page = await context.newPage();
  await page.goto(`${origin}/fixture-controller`);
  const minted = await page.evaluate(async ({ previewPort, token }) => {
    const response = await fetch('/api/preview/resource-auth', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath: `/preview/${previewPort}/` }),
    });
    return { status: response.status, data: await response.json() };
  }, { previewPort, token: process.env.PREVIEW_CONTROLLER_FIXTURE_TOKEN });
  assert.equal(minted.status, 200);
  assert.equal(typeof minted.data.previewToken, 'string');
  const claims = JSON.parse(Buffer.from(minted.data.previewToken.split('.')[1], 'base64url'));
  assert.equal(claims.controller_origin, origin, 'gateway must overwrite forged forwarding before the API signs it');
  await page.evaluate(({ previewPort, ticket }) => {
    document.querySelector('#preview').src = `/preview/${previewPort}/?previewToken=${encodeURIComponent(ticket)}`;
  }, { previewPort, ticket: minted.data.previewToken });
  await page.waitForFunction(() => messages.some(message => message.type === 'preview-storage-request'));
  const frame = page.frames().find(candidate => candidate.url().includes(`/preview/${previewPort}/`));
  assert.ok(frame);
  assert.equal(await frame.evaluate(() => { try { localStorage.getItem('synthetic'); return 'accessible'; } catch (error) { return error.name; } }), 'SecurityError');
  const preflight = await page.evaluate(async ({ previewPort, token }) => (await fetch(`/api/preview/${previewPort}/client-operation`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'evaluate', expression: 'window.authorizedEvaluation = 42' }),
  })).status, { previewPort, token: process.env.PREVIEW_CONTROLLER_FIXTURE_TOKEN });
  assert.equal(preflight, evalEnabled ? 200 : 403);
  await frame.evaluate(() => {
    addEventListener('message', e => { if (e.data?.fixtureBarrier) window.fixtureBarrier = e.data.fixtureBarrier; });
    const child = document.createElement('iframe'); child.srcdoc = '<p>Disposable nested outsider</p>'; document.body.appendChild(child);
  });
  const child = frame.childFrames()[0];
  await child.waitForLoadState();
  await child.evaluate(() => {
    parent.postMessage({ type: 'preview-evaluate', expression: 'window.unexpectedEvaluation = true' }, '*');
    parent.postMessage({ fixtureBarrier: 'actual-child' }, '*');
  });
  await frame.waitForFunction(() => window.fixtureBarrier === 'actual-child');
  assert.equal(await frame.evaluate(() => window.unexpectedEvaluation === true), false);
  await send(page, { type: 'preview-evaluate', expression: 'window.authorizedEvaluation = 42' });
  await send(page, { fixtureBarrier: 'actual-parent' });
  await frame.waitForFunction(() => window.fixtureBarrier === 'actual-parent');
  assert.equal(await frame.evaluate(() => window.authorizedEvaluation === 42), evalEnabled);
  if (evalEnabled) await page.waitForFunction(() => messages.some(message => message.type === 'preview-log-batch'));
});
