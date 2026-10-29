const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const { browserUrl, viewport, browserKey, createBrowser } = require('../rust/crates/api/src/workspace_browser.cjs');

test('browser addresses and viewports reject host files, credentials and unbounded sizes', () => {
  for (const address of ['file:///private/test', 'javascript:alert(1)', 'data:text/html,test', 'chrome://settings', 'https://user:password@example.test']) assert.throws(() => browserUrl(address));
  assert.equal(browserUrl('https://example.test/path?q=kept'), 'https://example.test/path?q=kept');
  for (const size of [[0, 800], [1921, 800], [1280, 1201], [640.5, 480]]) assert.throws(() => viewport(...size));
  assert.deepEqual(viewport(1280, 800), { width: 1280, height: 800 });
});

test('browser key descriptions reject ambiguous modifiers and support common shortcuts', () => {
  assert.deepEqual(browserKey('Control+Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2, text: '' });
  assert.deepEqual(browserKey('Shift+1'), { key: '!', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 8, text: '!' });
  for (const value of ['', 'Control+Control+A', 'F13', 'Ctrl+A', '__proto__', 'A+B', 'Control+', null]) assert.throws(() => browserKey(value));
});

test('RPC response serialization rejects oversized UTF-8 output with the same ID and bounded metadata', () => {
  const lines = [], state = { activeTabId: 'synthetic-tab', tabs: [{ id: 'synthetic-tab', documentId: 'synthetic-document', url: 'https://synthetic.test/' }] };
  const small = { id: 77, ok: true, value: 'small response', state };
  const large = { id: 78, ok: true, value: '🌍'.repeat(2_000_001), state };
  const helper = fs.readFileSync(path.resolve(__dirname, '../rust/crates/api/src/workspace_browser.cjs'), 'utf8');
  vm.runInNewContext(helper + '\nwriteResponse(small);writeResponse(large);', { require, Buffer, module: { exports: {} }, process: { stdout: { write: line => lines.push(line) } }, small, large });
  assert.deepEqual(lines.map(line => JSON.parse(line)), [small, { id: 78, ok: false, error: 'Browser response exceeds 8 MB. Reduce the viewport or requested output.', state }]);
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 8_000_000));
});

test('a real isolated browser supports navigation, pointer, keyboard, tabs and screenshots', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(`<title>${req.url === '/second' ? 'Second' : 'Browser fixture'}</title><input aria-label="Name" style="position:absolute;left:10px;top:10px;width:240px;height:40px"><button style="position:absolute;left:10px;top:70px" onclick="document.title=document.querySelector('input').value">Apply</button><a href="/second" style="position:absolute;left:10px;top:110px">Second</a>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const session = await createBrowser(); t.after(() => session.close());
  assert.ok(session.executablePath.startsWith(session.runtimeRoot + require('node:path').sep));
  assert.equal((await session.command({ type: 'state' })).engine.managed, true);
  assert.equal((await session.command({ type: 'frame' })).image, null);
  const base = `http://127.0.0.1:${server.address().port}`;
  await session.command({ type: 'navigate', url: base });
  await session.command({ type: 'pointer', action: 'down', x: 30, y: 30 });
  await session.command({ type: 'pointer', action: 'up', x: 30, y: 30 });
  await session.command({ type: 'text', text: 'Typed through browser' });
  await session.command({ type: 'key', key: 'Tab' });
  const typed = await session.command({ type: 'key', key: 'Enter' });
  assert.equal(typed.tabs[0].title, 'Typed through browser');
  const frame = await session.command({ type: 'frame' });
  assert.equal(Buffer.from(frame.image, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  const first = frame.activeTabId;
  let state = await session.command({ type: 'newTab', url: base + '/second' });
  assert.equal(state.tabs.length, 2); assert.equal(state.tabs.find(tab => tab.id === state.activeTabId).title, 'Second');
  await session.command({ type: 'closeTab', id: state.activeTabId });
  state = await session.command({ type: 'switchTab', id: first });
  assert.equal(state.tabs.length, 1); assert.equal(state.activeTabId, first);
  await assert.rejects(session.command({ type: 'navigate', url: 'file:///etc/hosts' }));
});

test('human and agent commands use the same bundled page with isolated refs and origin policy', async t => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Shared browser</title><label>Name<input id="name"></label><input type="password" value="synthetic-secret"><button onclick="document.title=document.querySelector(\'#name\').value">Apply</button>');
  });
  let otherHits = 0;
  const other = http.createServer((_req, res) => { otherHits++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('other fixture'); });
  server.listen(0, '127.0.0.1'); other.listen(0, '127.0.0.1'); await Promise.all([once(server, 'listening'), once(other, 'listening')]);
  t.after(async () => { for (const value of [server, other]) { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); } });
  const origin = `http://127.0.0.1:${server.address().port}`, otherOrigin = `http://127.0.0.1:${other.address().port}`;
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: origin, human: true });
  const humanTab = (await session.command({ type: 'state' })).activeTabId;
  const call = async (name, input = {}) => session.command({ type: 'agent', name, input, target: await session.command({ type: 'target', tabId: input.tabId }), allowedOrigins: [origin], label: 'synthetic-coding-agent' });
  const snapshot = await call('browser_snapshot');
  assert.equal(snapshot.elements.find(row => row.tag === 'input' && row.value === '[redacted]').value, '[redacted]');
  const name = snapshot.elements.find(row => row.name === 'Name'), button = snapshot.elements.find(row => row.name === 'Apply');
  await call('browser_type', { ref: name.ref, text: 'SHARED_AGENT_INPUT' });
  await call('browser_click', { ref: button.ref });
  const visible = await session.command({ type: 'state' });
  assert.equal(visible.activeTabId, humanTab); assert.equal(visible.tabs.find(tab => tab.id === humanTab).title, 'SHARED_AGENT_INPUT');
  const page = session.browser.contexts()[0].pages()[0];
  assert.equal(await page.evaluate(() => typeof globalThis.__v4refs), 'undefined');
  assert.equal(await page.evaluate(async url => fetch(url).then(() => 'allowed', () => 'blocked'), otherOrigin), 'blocked');
  assert.equal(otherHits, 0);
  await call('browser_navigate', { url: origin + '/new-document' });
  await assert.rejects(call('browser_type', { ref: name.ref, text: 'must not type into a new document' }), /Stale element ref/);
  await assert.rejects(call('browser_navigate', { url: otherOrigin }), /not allowed/);
  await session.command({ type: 'navigate', url: otherOrigin, human: true });
  assert.ok(otherHits > 0);
  assert.deepEqual((await call('browser_tabs')).tabs, []);
  await assert.rejects(call('browser_snapshot'), /outside the agent allowed origins/);
});

test('image inventory is bounded and tied to the approved tab and document', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/other') return res.end('<title>Other document</title>');
    res.end('<title>Image fixture</title><img src="/asset.png?size=small" alt="Synthetic chart"><img src="data:image/png;base64,AA==" alt="Inline image">' + '<img src="data:,x" alt="extra">'.repeat(205));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: origin, human: true });
  const target = await session.command({ type: 'target' });
  const call = (binding, allowedOrigins = [origin]) => session.command({ type: 'agent', name: 'browser_get_images', input: {}, target: binding, allowedOrigins, label: 'synthetic-agent', humanReading: true });
  const result = await call(target);
  assert.equal(result.images.length, 200);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.images.slice(0, 2), [
    { url: `${origin}/asset.png?size=small`, alt: 'Synthetic chart', inline: false },
    { url: null, alt: 'Inline image', inline: true },
  ]);
  await assert.rejects(call(target, []), /outside the agent allowed origins/);
  await session.command({ type: 'navigate', url: origin + '/other', human: true });
  await assert.rejects(call(target), /document changed/);
});

test('image inventory handles shadow roots, long values and UTF-8 limits', async t => {
  const allowed = await fixture(t, (_req, res) => res.end('<title>Synthetic images</title>'));
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const target = await session.command({ type: 'target' });
  const call = () => session.command({ type: 'agent', name: 'browser_get_images', input: {}, target, allowedOrigins: [allowed.origin], label: 'synthetic-agent', humanReading: true });
  const page = session.browser.contexts()[0].pages()[0];
  await page.evaluate(() => {
    document.body.innerHTML = '<img src="data:,x" alt="  first   image  ">'.repeat(199) + '<div id="host"></div>';
    document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<img src="data:,x" alt="shadow">';
  });
  const exact = await call();
  assert.equal(exact.images.length, 200);
  assert.equal(exact.truncated, false);
  assert.equal(exact.images[0].alt, 'first image');
  assert.equal(exact.images.at(-1).alt, 'shadow');
  await page.evaluate(() => {
    document.body.innerHTML = '';
    const long = document.createElement('img');
    long.loading = 'lazy';
    long.setAttribute('src', `http://127.0.0.1:1/${'a'.repeat(3000)}`);
    document.body.append(long);
    for (let i = 0; i < 100; i++) {
      const image = document.createElement('img');
      image.src = 'data:,x';
      image.alt = '🌍'.repeat(150);
      document.body.append(image);
    }
  });
  const limited = await call();
  assert.deepEqual(limited.images[0], { url: null, alt: '', inline: false, urlUnavailable: 'too_long' });
  assert.equal(limited.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(limited)) <= 60000);
  assert.ok(limited.images.length < 101);
});

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function agent(session, origin, name, input = {}, extra = {}) {
  const target = await session.command({ type: 'target', tabId: input.tabId });
  return session.command({ type: 'agent', name, input, target, allowedOrigins: [origin], label: 'regression-agent', ...extra });
}

test('agent keyboard release stays fenced while a modal waits for the human', async t => {
  const allowed = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Key fixture</title><input aria-label="Target"><script>window.events=[];document.querySelector('input').addEventListener('keydown',e=>{window.events.push(['down',e.key,e.ctrlKey]);if(e.key==='Enter')alert('Synthetic dialog')});document.querySelector('input').addEventListener('keyup',e=>window.events.push(['up',e.key,e.ctrlKey]));</script>`);
  });
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const snapshot = await agent(session, allowed.origin, 'browser_snapshot');
  const ref = snapshot.elements.find(row => row.name === 'Target').ref;
  await assert.rejects(agent(session, allowed.origin, 'browser_press', { ref, key: 'Control+Enter' }), /dialog.*release/i);
  const state = await session.command({ type: 'state' });
  assert.equal(state.keyboardRelease, 'pending');
  assert.equal(state.dialog.message, 'Synthetic dialog');
  await session.command({ type: 'control', owner: 'human', human: true });
  await assert.rejects(session.command({ type: 'text', text: 'must not be entered', human: true }), /keyboard|dialog/i);
  await session.command({ type: 'dialog', dialogId: state.dialog.id, accept: false, human: true });
  const page = session.browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.events.some(event => event[0] === 'up' && event[1] === 'Enter'));
  assert.deepEqual(await page.evaluate(() => window.events), [['down', 'Enter', true], ['up', 'Enter', true]]);
  assert.equal((await session.command({ type: 'state' })).keyboardRelease, null);
});

test('a dialog during focus cancels a key action before key-down', async t => {
  const allowed = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<input aria-label="Target" onfocus="alert('Synthetic focus dialog');window.focusReturned=true" onkeydown="window.downCount=(window.downCount||0)+1">`);
  });
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const snapshot = await agent(session, allowed.origin, 'browser_snapshot');
  const ref = snapshot.elements.find(row => row.name === 'Target').ref;
  await assert.rejects(agent(session, allowed.origin, 'browser_press', { ref, key: 'Enter' }), /dialog/i);
  const state = await session.command({ type: 'state' });
  assert.equal(state.keyboardRelease, null);
  await session.command({ type: 'control', owner: 'human', human: true });
  await session.command({ type: 'dialog', dialogId: state.dialog.id, accept: false, human: true });
  const page = session.browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => window.focusReturned === true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await page.evaluate(() => window.downCount || 0), 0);
});

test('an unconfirmed agent key release fences subsequent input but allows browser closure', async t => {
  const allowed = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<input aria-label="Target" onkeydown="alert('Synthetic dialog')">`);
  });
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const snapshot = await agent(session, allowed.origin, 'browser_snapshot');
  const ref = snapshot.elements.find(row => row.name === 'Target').ref;
  await assert.rejects(agent(session, allowed.origin, 'browser_press', { ref, key: 'Enter' }), /dialog.*release/i);
  const page = session.browser.contexts()[0].pages()[0];
  await page.close();
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = session.metadata();
    if (state.keyboardRelease === 'unconfirmed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(state.keyboardRelease, 'unconfirmed');
  await assert.rejects(session.command({ type: 'newTab', human: true }), /release.*unconfirmed/i);
  await session.close();
});

test('managed tab history reports real back and forward availability independently, including SPA entries', async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>History fixture</title><main>Synthetic navigation</main>'); });
  const session = await createBrowser(); t.after(() => session.close());
  const availability = state => state.tabs.map(({ id, url, canGoBack, canGoForward }) => ({ id, url, canGoBack, canGoForward }));
  const initial = await session.command({ type: 'state' }), first = initial.activeTabId;
  const row = (id, pathname, canGoBack, canGoForward) => ({ id, url: pathname === 'about:blank' ? pathname : allowed.origin + pathname, canGoBack, canGoForward });
  assert.deepEqual(availability(initial), [row(first, 'about:blank', false, false)]);
  assert.deepEqual(Object.keys(initial.tabs[0]).sort(), ['canGoBack', 'canGoForward', 'documentId', 'id', 'title', 'url']);
  assert.deepEqual(availability(await session.command({ type: 'frame' })), [row(first, 'about:blank', false, false)]);
  for (const pathname of ['/one', '/two', '/three']) {
    assert.deepEqual(availability(await session.command({ type: 'navigate', url: allowed.origin + pathname, human: true })), [row(first, pathname, true, false)]);
  }
  assert.deepEqual(availability(await session.command({ type: 'back', human: true })), [row(first, '/two', true, true)]);
  assert.deepEqual(availability(await session.command({ type: 'back', human: true })), [row(first, '/one', true, true)]);
  assert.deepEqual(availability(await session.command({ type: 'back', human: true })), [row(first, 'about:blank', false, true)]);
  assert.deepEqual(availability(await session.command({ type: 'forward', human: true })), [row(first, '/one', true, true)]);
  assert.deepEqual(availability(await session.command({ type: 'forward', human: true })), [row(first, '/two', true, true)]);
  assert.deepEqual(availability(await session.command({ type: 'reload', human: true })), [row(first, '/two', true, true)]);
  const context = session.browser.contexts()[0], page = context.pages()[0];
  const target = await session.command({ type: 'target' });
  await page.evaluate(() => { history.pushState({}, '', '/spa-one'); history.pushState({}, '', '/spa-two'); });
  assert.deepEqual(availability(await session.command({ type: 'state' })), [row(first, '/spa-two', true, false)]);
  assert.equal((await session.command({ type: 'target' })).documentId, target.documentId);
  assert.deepEqual(availability(await session.command({ type: 'back', human: true })), [row(first, '/spa-one', true, true)]);
  await page.evaluate(() => history.replaceState({}, '', '/spa-replaced'));
  assert.deepEqual(availability(await session.command({ type: 'state' })), [row(first, '/spa-replaced', true, true)]);
  assert.deepEqual(availability(await session.command({ type: 'forward', human: true })), [row(first, '/spa-two', true, false)]);
  await session.command({ type: 'back', human: true });
  assert.deepEqual(availability(await session.command({ type: 'navigate', url: allowed.origin + '/branch', human: true })), [row(first, '/branch', true, false)]);
  assert.deepEqual(availability(await session.command({ type: 'back', human: true })), [row(first, '/spa-replaced', true, true)]);
  const secondState = await session.command({ type: 'newTab', human: true }), second = secondState.activeTabId;
  assert.deepEqual(availability(secondState), [row(first, '/spa-replaced', true, true), row(second, 'about:blank', false, false)]);
  assert.deepEqual(availability(await session.command({ type: 'navigate', url: allowed.origin + '/independent', human: true })), [row(first, '/spa-replaced', true, true), row(second, '/independent', true, false)]);
  assert.deepEqual(availability(await session.command({ type: 'switchTab', id: first, human: true })), [row(first, '/spa-replaced', true, true), row(second, '/independent', true, false)]);
  const visible = await agent(session, allowed.origin, 'browser_tabs');
  assert.deepEqual(availability(visible), [row(first, '/spa-replaced', true, true), row(second, '/independent', true, false)]);
  assert.ok(!JSON.stringify(visible).includes('/branch') && !JSON.stringify(visible).includes('/three'), 'Tab metadata must not expose URLs from visited history.');
  const opened = page.waitForEvent('dialog');
  const evaluation = page.evaluate(() => alert('Synthetic history dialog'));
  await opened;
  const modal = await session.command({ type: 'frame' });
  assert.equal(modal.image, null);
  assert.equal(modal.dialog.message, 'Synthetic history dialog');
  assert.ok(modal.tabs.every(tab => typeof tab.canGoBack === 'boolean' && typeof tab.canGoForward === 'boolean'));
  await session.command({ type: 'dialog', dialogId: modal.dialog.id, accept: false, human: true });
  await evaluation;
  assert.deepEqual(availability(await session.command({ type: 'closeTab', id: second, human: true })), [row(first, '/spa-replaced', true, true)]);
});

test('managed history metadata failures, stalls and closing tabs preserve bounded state and frames', { timeout: 15000 }, async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>History fallback</title><main>Managed frame</main>'); });
  const session = await createBrowser(); t.after(() => session.close());
  const first = await session.command({ type: 'navigate', url: allowed.origin + '/foreground', human: true });
  const context = session.browser.contexts()[0], newCDPSession = context.newCDPSession.bind(context);
  let cdp;
  context.newCDPSession = async page => { cdp = await newCDPSession(page); return cdp; };
  t.after(() => { context.newCDPSession = newCDPSession; });
  const second = await session.command({ type: 'newTab', url: allowed.origin + '/background', human: true });
  await session.command({ type: 'navigate', url: allowed.origin + '/background-two', human: true });
  await session.command({ type: 'switchTab', id: first.activeTabId, human: true });
  const send = cdp.send.bind(cdp), pending = [];
  t.after(() => { cdp.send = send; for (const reject of pending) reject(new Error('Synthetic late history failure')); });
  const flags = state => state.tabs.map(({ id, canGoBack, canGoForward }) => ({ id, canGoBack, canGoForward }));
  const normal = [{ id: first.activeTabId, canGoBack: true, canGoForward: false }, { id: second.activeTabId, canGoBack: true, canGoForward: false }];
  assert.deepEqual(flags(await session.command({ type: 'state' })), normal);
  for (const mode of ['rejected', 'stalled']) {
    await t.test(mode, async () => {
      cdp.send = (method, params) => method !== 'Page.getNavigationHistory' ? send(method, params) : mode === 'rejected' ? Promise.reject(new Error('Synthetic unavailable history')) : new Promise((_, reject) => pending.push(reject));
      for (const type of ['state', 'frame']) {
        const start = Date.now(), state = await session.command({ type, human: true });
        assert.ok(Date.now() - start < 3000, 'History metadata must not hold a state/frame request indefinitely.');
        assert.equal(state.activeTabId, first.activeTabId);
        assert.deepEqual(flags(state), [normal[0], { ...normal[1], canGoBack: false }]);
        if (type === 'frame') assert.equal(Buffer.from(state.image, 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
      }
      cdp.send = send;
      for (const reject of pending.splice(0)) reject(new Error('Synthetic late history failure'));
      assert.deepEqual(flags(await session.command({ type: 'state' })), normal);
    });
  }
  const background = context.pages()[1];
  let closing;
  cdp.send = (method, params) => { if (method === 'Page.getNavigationHistory') closing = background.close(); return send(method, params); };
  const duringClose = await session.command({ type: 'state' });
  await closing;
  assert.equal(duringClose.activeTabId, first.activeTabId);
  assert.deepEqual(flags(await session.command({ type: 'frame' })), [normal[0]]);
});

test('agent policy guards popup first requests, redirects, WebSockets and workers with exact resource origins', async t => {
  const forbidden = [];
  const denied = await fixture(t, (req, res) => { forbidden.push(req.url); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('forbidden'); });
  denied.server.on('upgrade', (req, socket) => { forbidden.push(req.url); socket.destroy(); });
  const resources = [];
  const resource = await fixture(t, (req, res) => { resources.push(req.url); res.setHeader('Content-Type', 'application/javascript'); res.end('globalThis.resourceLoaded=true'); });
  const upgrades = [];
  const allowed = await fixture(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: denied.origin + '/redirect-hit' }); res.end(); return; }
    if (req.url === '/popup-first-script') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<script>new WebSocket('ws://127.0.0.1:${allowed.server.address().port}/popup-allowed-ws');new WebSocket(${JSON.stringify(denied.origin.replace('http:', 'ws:') + '/popup-forbidden-ws')});</script>`);
      return;
    }
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`fetch(${JSON.stringify(denied.origin + '/worker-fetch')}).catch(()=>{});new WebSocket(${JSON.stringify(denied.origin.replace('http:', 'ws:') + '/worker-ws')});new WebSocket('ws://127.0.0.1:${allowed.server.address().port}/worker-allowed-ws');`);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Network policy</title><button>Ready</button><script src="${resource.origin}/allowed-resource.js"></script>`);
  });
  allowed.server.on('upgrade', (req, socket) => { upgrades.push(req.url); socket.destroy(); });
  const session = await createBrowser(); t.after(() => session.close());
  const call = (name, input = {}) => agent(session, allowed.origin, name, input, { allowedOrigins: [allowed.origin, resource.origin] });
  await call('browser_navigate', { url: allowed.origin });
  await call('browser_evaluate', { script: `(()=>{
    fetch(${JSON.stringify(denied.origin + '/fetch')}).catch(()=>{});
    open(${JSON.stringify(denied.origin + '/popup')});
    open(${JSON.stringify(allowed.origin + '/redirect')});
    open(${JSON.stringify(allowed.origin + '/popup-first-script')});
    new WebSocket(${JSON.stringify(denied.origin.replace('http:', 'ws:') + '/ws')});
    new WebSocket(${JSON.stringify(allowed.origin.replace('http:', 'ws:') + '/allowed-ws')});
    try { new Worker('/worker.js'); } catch {}
    try { new SharedWorker('/worker.js'); } catch {}
    try { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`new WebSocket(${JSON.stringify(denied.origin.replace('http:', 'ws:') + '/blob-worker-ws')});`)}],{type:'text/javascript'}))); } catch {}
    return true;
  })()` });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(forbidden, []);
  assert.ok(resources.includes('/allowed-resource.js'));
  assert.deepEqual(upgrades.sort(), ['/allowed-ws', '/popup-allowed-ws', '/worker-allowed-ws', '/worker-allowed-ws']);
  const original = session.browser.contexts()[0].pages()[0];
  await original.evaluate(() => navigator.serviceWorker.register('/worker.js').catch(() => {}));
  assert.deepEqual(session.browser.contexts()[0].serviceWorkers(), []);
  const tabId = (await session.command({ type: 'state' })).tabs.find(tab => tab.url === allowed.origin + '/').id;
  await session.command({ type: 'switchTab', id: tabId, human: true });
  await session.command({ type: 'navigate', url: denied.origin + '/human', human: true });
  await original.evaluate(url => { open(url + '/human-popup'); new WebSocket(url.replace('http:', 'ws:') + '/human-ws'); }, denied.origin);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(forbidden.includes('/human-popup'));
  assert.ok(forbidden.includes('/human-ws'));
});

test('blank popups retain inherited agent scope after their approved opener closes', async t => {
  const hits = [];
  const denied = await fixture(t, (req, res) => { hits.push(req.url); res.setHeader('Access-Control-Allow-Origin', '*'); res.end('forbidden'); });
  denied.server.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Approved opener</title>'); });
  const session = await createBrowser(); t.after(() => session.close());
  await agent(session, allowed.origin, 'browser_navigate', { url: allowed.origin });
  const opener = await session.command({ type: 'target' });
  const popupOpened = session.browser.contexts()[0].waitForEvent('page');
  const worker = `new WebSocket(${JSON.stringify(denied.origin.replace('http:', 'ws:') + '/popup-worker-ws')});`;
  const script = `setTimeout(async()=>{new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));globalThis.fetchResult=await fetch(${JSON.stringify(denied.origin + '/popup-fetch')}).then(()=> 'allowed',()=> 'blocked');},400);`;
  await agent(session, allowed.origin, 'browser_evaluate', { script: `(()=>{const popup=open('about:blank');popup.document.write(${JSON.stringify('<script>' + script + '</script>')});popup.document.close();return true;})()` });
  const popup = await popupOpened;
  assert.equal(popup.url(), 'about:blank');
  await session.command({ type: 'agent', name: 'browser_close', input: {}, target: opener, allowedOrigins: [allowed.origin], label: 'regression-agent' });
  await popup.waitForFunction(() => globalThis.fetchResult !== undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual({ fetch: await popup.evaluate(() => fetchResult), hits }, { fetch: 'blocked', hits: [] });
  await session.command({ type: 'control', owner: 'human', human: true });
  assert.equal(await popup.evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), denied.origin + '/human-popup-fetch'), 'allowed');
});

test('TLS tunnels and native worker wss use exact https origins, and human control restores workers', async t => {
  const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgns4KtFKPhHTFL8le
alLgd8sm9nPzNA2v97cmz/WEpc2hRANCAAQWjmEIwzBF7Mw5QDo/nPV/qUaU74KG
zyjgAJGjUGQu9azgMCKuWA1+XWCW5Xw7+yj6pavFkcA2a6FGOVsst6+R
-----END PRIVATE KEY-----`;
  const cert = `-----BEGIN CERTIFICATE-----
MIIBFzCBvgIJAKOndUPGqAhhMAoGCCqGSM49BAMCMBQxEjAQBgNVBAMMCWxvY2Fs
aG9zdDAeFw0yNjEwMjUwOTA3MzNaFw0zNjEwMjIwOTA3MzNaMBQxEjAQBgNVBAMM
CWxvY2FsaG9zdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABBaOYQjDMEXszDlA
Oj+c9X+pRpTvgobPKOAAkaNQZC71rOAwIq5YDX5dYJblfDv7KPqlq8WRwDZroUY5
Wyy3r5EwCgYIKoZIzj0EAwIDSAAwRQIgCVLr6hyBmvEHEZsRcvICPpWZ7yRUPDSu
DpawfSRy3EgCIQCpTNyyAEv5fdQVODhhVWTgvx9IOFoDiW4O3m6HXuCB4g==
-----END CERTIFICATE-----`;
  const hits = [];
  const secure = https.createServer({ key, cert }, (req, res) => { hits.push(req.url); res.setHeader('Content-Type', 'text/html'); res.end('<title>Secure fixture</title><button>Ready</button>'); });
  secure.on('upgrade', (req, socket) => { hits.push(req.url); socket.destroy(); });
  secure.listen(0, '127.0.0.1'); await once(secure, 'listening');
  t.after(() => new Promise(resolve => { secure.closeAllConnections(); secure.close(resolve); }));
  const origin = `https://127.0.0.1:${secure.address().port}`, ws = origin.replace('https:', 'wss:');
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Plain fixture</title>'); });
  const session = await createBrowser(); t.after(() => session.close());
  const cdp = await session.browser.newBrowserCDPSession();
  await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
  await agent(session, origin, 'browser_navigate', { url: origin });
  await agent(session, origin, 'browser_evaluate', { script: `new WebSocket(${JSON.stringify(ws + '/allowed-wss')});new Worker(URL.createObjectURL(new Blob([${JSON.stringify(`new WebSocket(${JSON.stringify(ws + '/allowed-worker-wss')});`)}],{type:'text/javascript'})));true` });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(hits.includes('/allowed-wss')); assert.ok(hits.includes('/allowed-worker-wss'));
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const page = session.browser.contexts()[0].pages()[0];
  await page.evaluate(script => { globalThis.retainedWorker = new Worker(URL.createObjectURL(new Blob([script], { type: 'text/javascript' }))); }, `onmessage=e=>{new WebSocket(${JSON.stringify(ws)}+'/'+e.data+'-worker-wss');fetch(${JSON.stringify(origin)}+'/'+e.data+'-worker-fetch').catch(()=>{});};`);
  await agent(session, allowed.origin, 'browser_snapshot');
  await page.evaluate(() => retainedWorker.postMessage('forbidden'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!hits.includes('/forbidden-worker-wss')); assert.ok(!hits.includes('/forbidden-worker-fetch'));
  await session.command({ type: 'key', key: 'Escape', human: true });
  await page.evaluate(() => retainedWorker.postMessage('human'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(hits.includes('/human-worker-wss')); assert.ok(hits.includes('/human-worker-fetch'));
});

test('frame, resize, state and target reads cannot release an agent network policy', async t => {
  let hits = 0;
  const denied = await fixture(t, (_req, res) => { hits++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('forbidden'); });
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button>Ready</button>'); });
  const session = await createBrowser(); t.after(() => session.close());
  await agent(session, allowed.origin, 'browser_navigate', { url: allowed.origin });
  for (const command of [{ type: 'frame' }, { type: 'resize', width: 640, height: 480 }, { type: 'state' }, { type: 'target' }, { type: 'pointer', action: 'move', x: 20, y: 20 }]) {
    await session.command({ ...command, human: true });
    assert.equal(await session.browser.contexts()[0].pages()[0].evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), denied.origin), 'blocked');
  }
  assert.equal(hits, 0);
  await assert.rejects(session.command({ type: 'control', owner: 'human' }), /authorized human control/);
  assert.equal(hits, 0);
  const before = await session.command({ type: 'state' });
  const after = await session.command({ type: 'control', owner: 'human', human: true });
  assert.equal(after.activeTabId, before.activeTabId);
  assert.deepEqual(after.tabs, before.tabs);
  assert.equal(await session.browser.contexts()[0].pages()[0].evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), denied.origin), 'allowed');
  assert.equal(hits, 1);
});

test('humanReading inspects another tab without selecting it or installing policy', async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Human tab</title><button>Ready</button>'); });
  const resource = await fixture(t, (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.end('human resource'); });
  const session = await createBrowser(); t.after(() => session.close());
  const first = await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const second = await session.command({ type: 'newTab', url: allowed.origin + '/second', human: true });
  const tabId = first.activeTabId;
  await agent(session, allowed.origin, 'browser_snapshot', { tabId }, { humanReading: true });
  await agent(session, allowed.origin, 'browser_screenshot', { tabId }, { humanReading: true });
  assert.equal((await session.command({ type: 'state' })).activeTabId, second.activeTabId);
  assert.equal(await session.browser.contexts()[0].pages()[0].evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), resource.origin), 'allowed');
  await assert.rejects(agent(session, allowed.origin, 'browser_evaluate', { tabId, script: 'document.title="mutated"' }, { humanReading: true }), /read/i);
});

test('background screenshots recover boundedly without selecting tabs, changing policy or retrying stale targets', async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Background capture</title><main>Managed Chromium image</main>'); });
  const resource = await fixture(t, (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'text/html'); res.end('<title>Other origin</title>'); });
  const session = await createBrowser(); t.after(() => session.close());
  const first = await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const second = await session.command({ type: 'newTab', url: allowed.origin + '/foreground', human: true });
  const page = session.browser.contexts()[0].pages()[0], screenshot = page.screenshot.bind(page);
  t.after(() => { page.screenshot = screenshot; });
  const transient = () => new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
  for (const mode of ['recover', 'exhausted', 'same-origin navigation', 'forbidden-origin navigation']) {
    await t.test(mode, async () => {
      await page.goto(allowed.origin + '/reviewed', { waitUntil: 'domcontentloaded' });
      const target = await session.command({ type: 'target', tabId: first.activeTabId });
      let attempts = 0, signalFailure;
      const failed = new Promise(resolve => { signalFailure = resolve; });
      page.screenshot = async options => {
        attempts++;
        if (attempts === 1 || mode === 'exhausted') { signalFailure(); throw transient(); }
        return screenshot(options);
      };
      const capture = session.command({ type: 'agent', name: 'browser_screenshot', input: {}, target, allowedOrigins: [allowed.origin], label: 'background-review-agent', humanReading: true }).then(value => ({ value }), error => ({ error: error.message }));
      if (mode.endsWith('navigation')) {
        await failed;
        await page.goto(mode === 'same-origin navigation' ? allowed.origin + '/replacement' : resource.origin, { waitUntil: 'domcontentloaded' });
      }
      const result = await capture;
      if (mode === 'recover') {
        assert.equal(Buffer.from(result.value?.data || '', 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.ok(attempts >= 2 && attempts <= 3);
      } else if (mode === 'exhausted') {
        assert.match(result.error, /Unable to capture screenshot/);
        assert.equal(attempts, 3);
      } else {
        assert.match(result.error, /target document changed|outside the agent allowed origins/);
        assert.equal(attempts, 1);
      }
      assert.equal((await session.command({ type: 'state' })).activeTabId, second.activeTabId);
      assert.equal(await page.evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), resource.origin + '/human-resource'), 'allowed');
    });
  }
});

test('human JPEG frames recover known capture failures with bounded attempts and preserve viewport state and policy', async t => {
  let forbiddenHits = 0;
  const denied = await fixture(t, (_req, res) => { forbiddenHits++; res.setHeader('Access-Control-Allow-Origin', '*'); res.end('forbidden'); });
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Human viewport</title><main>Real JPEG capture</main>'); });
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const second = await session.command({ type: 'newTab', url: allowed.origin + '/active', human: true });
  await agent(session, allowed.origin, 'browser_snapshot', { tabId: second.activeTabId });
  const page = session.browser.contexts()[0].pages()[1], screenshot = page.screenshot.bind(page);
  t.after(() => { page.screenshot = screenshot; });
  const withoutTitles = state => ({ ...state, tabs: state.tabs.map(({ title, ...tab }) => tab) });
  for (const mode of ['recover', 'exhausted', 'other error']) {
    await t.test(mode, async () => {
      const before = await session.command({ type: 'state' });
      let attempts = 0;
      page.screenshot = async options => {
        attempts++;
        if (mode === 'other error') throw new Error('Synthetic screenshot permission error.');
        if (attempts === 1 || mode === 'exhausted') throw new Error('page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot');
        return screenshot(options);
      };
      const result = await session.command({ type: 'frame', human: true }).then(value => ({ value }), error => ({ error: error.message }));
      if (mode === 'recover') {
        assert.equal(Buffer.from(result.value?.image || '', 'base64').subarray(0, 3).toString('hex'), 'ffd8ff');
        const { image, ...frameState } = result.value;
        assert.deepEqual(withoutTitles(frameState), { ...withoutTitles(before), width: 1280, height: 800 });
        assert.ok(attempts >= 2 && attempts <= 3);
      } else {
        assert.match(result.error, mode === 'exhausted' ? /Unable to capture screenshot/ : /Synthetic screenshot permission error/);
        assert.equal(attempts, mode === 'exhausted' ? 3 : 1);
      }
      assert.deepEqual(withoutTitles(await session.command({ type: 'state' })), withoutTitles(before));
      assert.equal(await page.evaluate(url => fetch(url).then(() => 'allowed', () => 'blocked'), denied.origin), 'blocked');
      assert.equal(forbiddenHits, 0);
    });
  }
});

test('agent screenshots discard images when a delayed font capture crosses a reviewed document boundary', { timeout: 30000 }, async t => {
  let fontRequested, releaseFont;
  const allowed = await fixture(t, (req, res) => {
    if (req.url.startsWith('/slow.woff2')) {
      releaseFont = () => { res.writeHead(404); res.end(); };
      fontRequested();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url.startsWith('/replacement') ? '<title>Replacement document</title><main>Unreviewed replacement</main>' : '<title>Reviewed document</title><style>@font-face{font-family:delayed;src:url(/slow.woff2)}body{font-family:delayed}</style><main>Reviewed content</main>');
  });
  const denied = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Forbidden document</title><main>Outside the agent scope</main>'); });
  const session = await createBrowser(); t.after(() => session.close());
  const page = session.browser.contexts()[0].pages()[0];
  for (const [name, destination] of [['forbidden origin', denied.origin], ['same-origin replacement', allowed.origin + '/replacement']]) {
    await t.test(name, async () => {
      const font = new Promise(resolve => { fontRequested = resolve; });
      await session.command({ type: 'navigate', url: allowed.origin + '/reviewed', human: true });
      await font;
      assert.equal(await page.evaluate(() => document.fonts.status), 'loading');
      const target = await session.command({ type: 'target' });
      let settled = false;
      const captures = Array.from({ length: 4 }, () => session.command({ type: 'agent', name: 'browser_screenshot', input: {}, target, allowedOrigins: [allowed.origin], label: 'screenshot-review-agent', humanReading: true }).then(
        value => { settled = true; return { status: 'fulfilled', value }; },
        error => { settled = true; return { status: 'rejected', error: error.message }; },
      ));
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(settled, false, 'Screenshot must still be waiting for the delayed font before navigation.');
      await page.goto(destination, { waitUntil: 'domcontentloaded' });
      releaseFont();
      const results = await Promise.all(captures);
      assert.equal(page.url(), destination === denied.origin ? destination + '/' : destination);
      assert.notEqual((await session.command({ type: 'target' })).documentId, target.documentId);
      assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected', 'rejected'], 'An image from a replacement document must not leave the browser engine.');
      for (const result of results) assert.match(result.error, /target document changed|outside the agent allowed origins|Unable to capture screenshot/);
    });
  }
});

test('agent targets bind tab and main document, surviving same-document and child-frame navigation only', async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Target fixture</title><button>Ready</button><iframe src="about:blank"></iframe>'); });
  const session = await createBrowser(); t.after(() => session.close());
  await session.command({ type: 'navigate', url: allowed.origin, human: true });
  const target = await session.command({ type: 'target' });
  const call = (binding, input = {}) => session.command({ type: 'agent', name: 'browser_snapshot', input, target: binding, allowedOrigins: [allowed.origin], label: 'target-agent' });
  await assert.rejects(call(undefined), /target/i);
  await assert.rejects(call({ ...target, tabId: 'missing' }), /tab|target/i);
  await assert.rejects(call({ ...target, documentId: 'stale' }), /document|target/i);
  await assert.rejects(call(target, { tabId: 'different' }), /target|tab/i);
  const page = session.browser.contexts()[0].pages()[0];
  await page.evaluate(() => { history.pushState({}, '', '/same-document#hash'); document.querySelector('iframe').src = '/child'; });
  await page.frames()[1].waitForURL(allowed.origin + '/child');
  assert.equal((await session.command({ type: 'target' })).documentId, target.documentId);
  await call(target);
  await session.command({ type: 'reload', human: true });
  const reloaded = await session.command({ type: 'target' });
  assert.notEqual(reloaded.documentId, target.documentId);
  await assert.rejects(call(target), /document|target/i);
  await call(reloaded);
  const second = await session.command({ type: 'newTab', url: allowed.origin + '/second', human: true });
  assert.notEqual(second.activeTabId, reloaded.tabId);
  await session.command({ type: 'agent', name: 'browser_evaluate', input: { script: 'document.title="bound original tab"' }, target: reloaded, allowedOrigins: [allowed.origin], label: 'target-agent' });
  const after = await session.command({ type: 'state' });
  const titles = await Promise.all(session.browser.contexts()[0].pages().map(value => value.title()));
  assert.deepEqual({ tabs: after.tabs.map(tab => tab.id), titles }, { tabs: [reloaded.tabId, second.activeTabId], titles: ['bound original tab', 'Target fixture'] });
});

test('pending tab dialogs and successive alerts remain available until each is dismissed', { timeout: 20000 }, async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Dialog fixture</title><main>Dialog recovery</main>'); });
  for (const mode of ['two tabs', 'successive alerts']) {
    await t.test(mode, async st => {
      const session = await createBrowser(); st.after(() => session.close());
      await session.command({ type: 'navigate', url: allowed.origin, human: true });
      await session.command({ type: 'newTab', url: allowed.origin + '/second', human: true });
      const pages = session.browser.contexts()[0].pages();
      const firstDialog = pages[0].waitForEvent('dialog');
      const firstEvaluation = pages[0].evaluate(successive => { alert('first alert'); if (successive) alert('second alert'); return 'first evaluation resumed'; }, mode === 'successive alerts').catch(error => error.message);
      await firstDialog;
      const nextDialog = (mode === 'two tabs' ? pages[1] : pages[0]).waitForEvent('dialog');
      const evaluations = [firstEvaluation];
      if (mode === 'two tabs') {
        evaluations.push(pages[1].evaluate(() => { alert('second alert'); return 'second evaluation resumed'; }).catch(error => error.message));
        await nextDialog;
      }
      const reviewed = (await session.command({ type: 'state' })).dialog;
      assert.equal(typeof reviewed.id, 'string');
      const seen = [reviewed.message];
      const dismissal = await session.command({ type: 'dialog', dialogId: reviewed.id, accept: mode === 'successive alerts', human: true });
      if (mode === 'successive alerts') await nextDialog;
      const remaining = await session.command({ type: 'state' });
      assert.ok(remaining.dialog, 'Dismissing one alert must leave the next pending alert available.');
      assert.equal(dismissal.dialog?.id, remaining.dialog.id, 'A successful dismissal response must surface the next pending dialog.');
      assert.notEqual(remaining.dialog.id, reviewed.id);
      await assert.rejects(session.command({ type: 'dialog', dialogId: reviewed.id, accept: true, human: true }), /dialog changed/i);
      assert.deepEqual((await session.command({ type: 'state' })).dialog, remaining.dialog);
      seen.push(remaining.dialog.message);
      assert.deepEqual(seen.sort(), ['first alert', 'second alert']);
      const finished = await session.command({ type: 'dialog', dialogId: remaining.dialog.id, accept: false, human: true });
      assert.equal(finished.dialog, null);
      await assert.rejects(session.command({ type: 'dialog', dialogId: remaining.dialog.id, accept: true, human: true }), /dialog changed/i);
      assert.deepEqual(await Promise.all(evaluations), mode === 'two tabs' ? ['first evaluation resumed', 'second evaluation resumed'] : ['first evaluation resumed']);
      assert.equal((await session.command({ type: 'state' })).tabs.length, 2);
    });
  }
});

test('human key and pointer actions return usable prompt state and accept the exact dialog', async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Human prompt fixture</title><button style="position:absolute;left:10px;top:10px;width:240px;height:60px" onclick="document.title=prompt(\'Human prompt\',\'Synthetic default\')||\'Canceled\'">Prompt</button>'); });
  const session = await createBrowser(); t.after(() => session.close());
  for (const mode of ['key', 'pointer']) {
    await t.test(mode, async () => {
      await session.command({ type: 'navigate', url: allowed.origin, human: true });
      let opened;
      if (mode === 'key') {
        await session.command({ type: 'key', key: 'Tab', human: true });
        opened = await session.command({ type: 'key', key: 'Enter', human: true });
      } else {
        await session.command({ type: 'pointer', action: 'down', x: 40, y: 40, human: true });
        opened = await session.command({ type: 'pointer', action: 'up', x: 40, y: 40, human: true });
      }
      assert.equal(typeof opened.dialog.id, 'string');
      assert.deepEqual({ type: opened.dialog.type, message: opened.dialog.message, defaultValue: opened.dialog.defaultValue }, { type: 'prompt', message: 'Human prompt', defaultValue: 'Synthetic default' });
      const accepted = await session.command({ type: 'dialog', dialogId: opened.dialog.id, accept: true, text: 'Confirmed ' + mode, human: true });
      assert.equal(accepted.dialog, null);
      assert.equal(accepted.tabs.find(tab => tab.id === opened.activeTabId).title, 'Confirmed ' + mode);
      await assert.rejects(session.command({ type: 'dialog', dialogId: opened.dialog.id, accept: true, human: true }), /dialog changed/i);
    });
  }
});

test('RPC IDs survive modal evaluation, late completions, errors and the embedded main wrapper', { timeout: 20000 }, async t => {
  const allowed = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>RPC fixture</title><button onclick="alert(\'clicked\')">Modal</button>'); });
  const helper = fs.readFileSync(path.resolve(__dirname, '../rust/crates/api/src/workspace_browser.cjs'), 'utf8');
  const child = spawn(process.execPath, ['-e', `${helper}\nmain().catch(() => process.exit(1));\nmain().catch(() => process.exit(1));`], { env: { ...process.env, TERMINAL_V4_BROWSER_RUNTIME_DIR: path.resolve(__dirname, '../.runtime/browser') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const responses = [], waiting = new Map(), responseBytes = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => { const response = JSON.parse(line); responseBytes.set(response.id, Buffer.byteLength(line) + 1); responses.push(response); waiting.get(response.id)?.(response); });
  const response = id => responses.find(value => value.id === id) || new Promise(resolve => waiting.set(id, resolve));
  const send = (id, command) => { child.stdin.write(JSON.stringify({ id, command }) + '\n'); return response(id); };
  const ready = await response(0);
  assert.equal(ready.ok, true); assert.deepEqual(ready.state, ready.value);
  const navigated = await send(11, { type: 'navigate', url: allowed.origin, human: true });
  const row = navigated.state.tabs[0];
  assert.equal(typeof row.documentId, 'string');
  const command = script => ({ type: 'agent', name: 'browser_evaluate', input: { script }, target: { tabId: row.id, documentId: row.documentId }, allowedOrigins: [allowed.origin], label: 'wire-agent' });
  const modal = await send(12, command('alert("synthetic modal"); "late modal result"'));
  assert.equal(modal.ok, false); assert.match(modal.error, /dialog/i);
  const frame = await send(13, { type: 'frame', human: true });
  assert.equal(frame.value.dialog.message, 'synthetic modal');
  assert.equal(frame.value.image, null);
  assert.equal((await send(14, { type: 'dialog', accept: false, human: true })).ok, true);
  assert.equal((await send(15, { type: 'target' })).value.documentId, row.documentId);
  const error = await send(16, command('throw Error("synthetic error")'));
  assert.equal(error.id, 16); assert.equal(error.ok, false); assert.ok(error.state.tabs[0].documentId);
  const invalid = await send(1601, { type: 'unsupported' });
  assert.equal(invalid.id, 1601); assert.equal(invalid.ok, false);
  const oversized = await send(1602, { type: 'state', padding: 'x'.repeat(100001) });
  assert.equal(oversized.id, 1602); assert.equal(oversized.ok, false); assert.match(oversized.error, /too large/);
  const delayed = send(17, command('new Promise(resolve => setTimeout(() => resolve("late promise"), 5500))'));
  const delayedResult = await delayed;
  assert.equal(delayedResult.id, 17); assert.equal(delayedResult.ok, false); assert.match(delayedResult.error, /timed out|timeout/i);
  assert.equal((await send(18, { type: 'state' })).ok, true);
  assert.equal((await send(19, { type: 'resize', width: 1920, height: 1200 })).ok, true);
  const noise = await send(20, command(`(()=>{
    document.body.style.margin='0';const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;document.body.replaceChildren(canvas);
    const context=canvas.getContext('2d'),image=context.createImageData(canvas.width,canvas.height);let seed=123456789;
    for(let i=0;i<image.data.length;i+=4){for(let channel=0;channel<3;channel++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;image.data[i+channel]=seed&255;}image.data[i+3]=255;}
    context.putImageData(image,0,0);return {width:canvas.width,height:canvas.height};
  })()`));
  assert.deepEqual(noise.value, { width: 1920, height: 1200 });
  const largeCapture = await send(21, { type: 'agent', name: 'browser_screenshot', input: {}, target: { tabId: row.id, documentId: row.documentId }, allowedOrigins: [allowed.origin], label: 'wire-agent' });
  assert.equal(largeCapture.ok, false, 'A high-entropy PNG must fail within the worker wire budget.');
  assert.match(largeCapture.error, /image exceeds|capture exceeds|response exceeds/i);
  assert.ok(responseBytes.get(21) <= 8_000_000);
  const alive = await send(22, { type: 'state' });
  assert.equal(alive.ok, true); assert.equal(alive.value.tabs[0].documentId, row.documentId);
  assert.equal((await send(23, command('document.querySelector("canvas").remove();true'))).ok, true);
  const recoveredCapture = await send(24, { type: 'agent', name: 'browser_screenshot', input: {}, target: { tabId: row.id, documentId: row.documentId }, allowedOrigins: [allowed.origin], label: 'wire-agent' });
  assert.equal(recoveredCapture.ok, true); assert.equal(recoveredCapture.value.mimeType, 'image/png');
  assert.equal(Buffer.from(recoveredCapture.value.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await send(25, { type: 'navigate', url: allowed.origin, human: true })).ok, true);
  assert.equal((await send(26, { type: 'key', key: 'Tab', human: true })).ok, true);
  const humanDialog = await send(27, { type: 'key', key: 'Enter', human: true });
  assert.equal(humanDialog.ok, true); assert.equal(humanDialog.value.dialog.message, 'clicked');
  assert.equal((await send(28, { type: 'dialog', dialogId: humanDialog.value.dialog.id, accept: false, human: true })).ok, true);
  assert.equal((await send(29, { type: 'state' })).value.dialog, null);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(responses.map(value => value.id), [0, 11, 12, 13, 14, 15, 16, 1601, 1602, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
});
