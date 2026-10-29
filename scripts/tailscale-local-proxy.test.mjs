import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createGateway } from './tailscale-local-proxy.mjs';

const allowedLogin = 'synthetic-owner';
const externalHost = 'synthetic-device.synthetic-tail.ts.net';
const externalOrigin = `https://${externalHost}`;
const headers = { Host: externalHost, 'Tailscale-User-Login': allowedLogin, Origin: externalOrigin };

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  let gateway;
  t.after(async () => {
    if (gateway) await new Promise(resolve => gateway.close(resolve));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  gateway = await createGateway({ allowedLogin, externalHost, upstreamPort, port: 0, ...options });
  return { upstream, gateway, upstreamPort, port: gateway.address().port };
}

function request(port, { method = 'GET', requestHeaders = headers, path = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, method, headers: requestHeaders }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function websocket(port, requestHeaders, payload = Buffer.from([0, 1, 128, 255]), opcode = 0x82) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket fixture timeout')); }, 3000);
    socket.on('error', reject);
    socket.on('connect', () => {
      const maskingKey = Buffer.from([2, 4, 6, 8]);
      const frame = Buffer.concat([Buffer.from([opcode, 0x80 | payload.length]), maskingKey, Buffer.from(payload.map((byte, index) => byte ^ maskingKey[index % 4]))]);
      socket.write(Buffer.concat([Buffer.from(`GET /socket?business=kept HTTP/1.1\r\n${Object.entries({ ...requestHeaders, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' }).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`), frame]));
    });
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      const status = Number(received.subarray(0, end).toString().split(' ')[1]);
      const body = received.subarray(end + 4);
      if (status === 101 && body.length < payload.length + 2) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, body });
    });
    socket.once('close', () => clearTimeout(timer));
  });
}

test('only binds IPv4 loopback and forwards an authorized streamed request with fixed trusted headers', async t => {
  let observed;
  const { port, gateway, upstreamPort } = await fixture(t, (incoming, response) => {
    observed = { url: incoming.url, headers: incoming.headers };
    incoming.pipe(response);
  });
  assert.equal(gateway.address().address, '127.0.0.1');
  const result = await request(port, { method: 'POST', path: '/api/auth/local-testing?business=kept', requestHeaders: { ...headers, 'Content-Type': 'application/json', Cookie: 'app=cookie', Authorization: 'Bearer synthetic-app-token', Forwarded: 'for=attacker', 'X-Forwarded-For': 'attacker', 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'http', 'X-Real-IP': 'attacker', 'X-Original-URL': '/admin', 'Tailscale-User-Name': 'private display name', Connection: 'keep-alive, x-smuggled', 'X-Smuggled': 'no' }, body: '{"username":"synthetic"}' });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"username":"synthetic"}');
  assert.equal(observed.url, '/api/auth/local-testing?business=kept');
  assert.equal(observed.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(observed.headers.origin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(observed.headers['x-forwarded-host'], externalHost);
  assert.equal(observed.headers['x-forwarded-proto'], 'https');
  assert.equal(observed.headers.authorization, 'Bearer synthetic-app-token');
  assert.equal(observed.headers.cookie, 'app=cookie');
  for (const name of ['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-original-url', 'tailscale-user-login', 'tailscale-user-name', 'x-smuggled']) assert.equal(observed.headers[name], undefined, name);
});

test('HTTP Tailscale controller origin is reconstructed after validation and absent/opaque origins never inherit client forwarding', async t => {
  const externalOrigin = `http://${externalHost}:8080`;
  const { port } = await fixture(t, (incoming, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(incoming.headers));
  }, { externalOrigin });
  const requestHeaders = {
    Host: `${externalHost}:8080`, Origin: externalOrigin, 'Tailscale-User-Login': allowedLogin,
    'X-Terminal-Preview-Controller-Origin': 'https://attacker.synthetic.invalid',
    Connection: 'x-terminal-preview-controller-origin',
    Authorization: 'Bearer synthetic-owner',
  };
  const result = await request(port, { method: 'POST', path: '/api/preview/resource-auth', requestHeaders });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body)['x-terminal-preview-controller-origin'], externalOrigin);
  const absent = { ...requestHeaders }; delete absent.Origin;
  const topLevel = await request(port, { requestHeaders: absent });
  assert.equal(topLevel.status, 200);
  assert.equal(JSON.parse(topLevel.body)['x-terminal-preview-controller-origin'], undefined);
  const resource = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"token_kind":"preview-resource"}').toString('base64url')}.synthetic-signature`;
  const opaque = await request(port, { path: `/preview/4173/main.js?previewToken=${resource}`, requestHeaders: { ...requestHeaders, Origin: 'null' } });
  assert.equal(opaque.status, 200);
  const observed = JSON.parse(opaque.body);
  assert.equal(observed['x-terminal-preview-controller-origin'], undefined);
  assert.equal(observed.authorization, undefined);
  assert.equal((await request(port, { method: 'POST', requestHeaders: { ...requestHeaders, Origin: 'null' } })).status, 403);
  assert.equal((await request(port, { method: 'POST', requestHeaders: { ...requestHeaders, Origin: 'http://attacker.synthetic.invalid:8080' } })).status, 403);
});

test('rejects missing/wrong identity, wrong host/origin, duplicate identity and unsafe missing origin before forwarding', async t => {
  let hits = 0;
  const { port } = await fixture(t, (_incoming, response) => { hits += 1; response.end('unexpected'); });
  for (const requestHeaders of [
    { ...headers, 'Tailscale-User-Login': '' }, { ...headers, 'Tailscale-User-Login': 'other-owner' },
    { ...headers, 'Tailscale-User-Login': [allowedLogin, allowedLogin] },
    { ...headers, Host: 'attacker.test' }, { ...headers, Origin: 'http://' + externalHost },
    { ...headers, Origin: externalOrigin + '.attacker.test' }, { ...headers, Origin: 'null' },
    { ...headers, 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await request(port, { requestHeaders })).status, 403);
  const noIdentity = { ...headers }; delete noIdentity['Tailscale-User-Login'];
  assert.equal((await request(port, { requestHeaders: noIdentity })).status, 403);
  const noOrigin = { ...headers }; delete noOrigin.Origin;
  assert.equal((await request(port, { method: 'POST', requestHeaders: noOrigin })).status, 403);
  assert.equal(hits, 0);
});

test('permits identity-authenticated top-level navigation without Origin and streams before completion', async t => {
  let release;
  const { port } = await fixture(t, (_incoming, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write('data: first\n\n');
    release = () => response.end('data: last\n\n');
  });
  const noOrigin = { ...headers }; delete noOrigin.Origin;
  await new Promise((resolve, reject) => {
    const outgoing = http.get({ hostname: '127.0.0.1', port, headers: noOrigin }, response => {
      assert.equal(response.headers['content-type'], 'text/event-stream');
      let body = '';
      response.on('data', chunk => { body += chunk; if (body === 'data: first\n\n') release(); });
      response.on('end', () => { assert.equal(body, 'data: first\n\ndata: last\n\n'); resolve(); });
    });
    outgoing.on('error', reject);
  });
});

test('proxies actual binary WebSocket frames including initial upgrade head and rejects unauthorized upgrades', async t => {
  let upgrades = 0;
  let observed;
  const { port, upstream, upstreamPort } = await fixture(t, (_incoming, response) => { response.end(); });
  upstream.on('upgrade', (incoming, socket, head) => {
    upgrades += 1;
    observed = incoming.headers;
    const accept = createHash('sha1').update(incoming.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const echo = data => {
      const size = data[1] & 0x7f;
      const mask = data.subarray(2, 6);
      const payload = Buffer.from(data.subarray(6, 6 + size).map((byte, index) => byte ^ mask[index % 4]));
      socket.write(Buffer.concat([Buffer.from([data[0], payload.length]), payload]));
    };
    if (head.length) echo(head);
    socket.on('data', echo);
  });
  const payload = Buffer.from([0, 1, 128, 255]);
  const result = await websocket(port, headers, payload);
  assert.equal(result.status, 101);
  assert.deepEqual(result.body, Buffer.concat([Buffer.from([0x82, payload.length]), payload]));
  assert.equal(observed.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(observed.origin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(observed['tailscale-user-login'], undefined);
  const noOrigin = { ...headers }; delete noOrigin.Origin;
  for (const requestHeaders of [noOrigin, { ...headers, Origin: 'https://attacker.test' }, { ...headers, 'Tailscale-User-Login': 'other' }]) assert.equal((await websocket(port, requestHeaders)).status, 403);
  const text = Buffer.from('synthetic terminal text');
  const textResult = await websocket(port, headers, text, 0x81);
  assert.deepEqual(textResult.body, Buffer.concat([Buffer.from([0x81, text.length]), text]));
  assert.equal(upgrades, 2);
});

test('upstream failures return a bounded generic error without configuration or identity disclosure', async t => {
  const temporary = net.createServer(); temporary.listen(0, '127.0.0.1'); await once(temporary, 'listening');
  const upstreamPort = temporary.address().port; await new Promise(resolve => temporary.close(resolve));
  const gateway = await createGateway({ allowedLogin, externalHost, upstreamPort, port: 0 });
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const result = await request(gateway.address().port);
  assert.equal(result.status, 502);
  assert.equal(result.body, 'Upstream unavailable\n');
  assert.equal((await websocket(gateway.address().port, headers)).status, 502);
});

test('invalid configuration fails closed before listening', async () => {
  for (const options of [{ allowedLogin: '', externalHost }, { allowedLogin, externalHost: 'attacker.test' }, { allowedLogin, externalHost: 'https://' + externalHost }, { allowedLogin, externalHost, upstreamPort: 0 }, { allowedLogin, externalHost, port: 65536 }]) await assert.rejects(createGateway(options));
});


test('private HTTP Serve fallback binds the exact same-device port8080 authority and origin', async t => {
  const fallback = `http://${externalHost}:8080`;
  let observed;
  const { port } = await fixture(t, (incoming, response) => { observed = incoming.headers; response.end('private fallback'); }, { externalOrigin: fallback });
  const requestHeaders = { ...headers, Host: `${externalHost}:8080`, Origin: fallback };
  assert.equal((await request(port, { method: 'POST', requestHeaders })).body, 'private fallback');
  assert.equal(observed['x-forwarded-host'], `${externalHost}:8080`);
  assert.equal(observed['x-forwarded-proto'], 'http');
  assert.equal((await request(port)).status, 403);
  assert.equal((await request(port, { requestHeaders: { ...requestHeaders, Origin: `http://${externalHost}:8081` } })).status, 403);
  await assert.rejects(createGateway({ allowedLogin, externalHost, externalOrigin: `http://${externalHost}:8081`, port: 0 }));
});


test('opaque resource reads forward only scoped-ticket carrier and strip all broad credentials', async t => {
  const resource = `e30.${Buffer.from(JSON.stringify({ token_kind: 'preview-resource' })).toString('base64url')}.synthetic`;
  let observed;
  const { port } = await fixture(t, (incoming, response) => { observed = { headers: incoming.headers, url: incoming.url }; response.end('opaque asset'); });
  const requestHeaders = { ...headers, Origin: 'null', 'Sec-Fetch-Site': 'cross-site', Authorization: 'Bearer broad', Cookie: 'terminal_preview_token=broad' };
  for (const path of ['/preview/4173/module.js', '/api/preview?path=%2Fsynthetic', '/api/proxy-external?url=https%3A%2F%2Fexample.test', '/api/environments/11111111-1111-4111-8111-111111111111/proxy/preview/4173/module.js']) {
    const query = path.includes('?') ? '&' : '?';
    assert.equal((await request(port, { path: `${path}${query}previewToken=${resource}&token=eyJhbGci.aGVsbG8.signature&business=kept`, requestHeaders })).body, 'opaque asset');
    assert.equal(observed.headers.authorization, undefined);
    assert.equal(observed.headers.cookie, undefined);
    assert.equal(new URL(observed.url, 'http://fixture.test').searchParams.has('token'), false);
    assert.equal(new URL(observed.url, 'http://fixture.test').searchParams.get('business'), 'kept');
  }
  for (const path of ['/api/settings', '/api/terminal', '/preview/0/asset', '/preview/65536/asset', '/api/preview/4173/storage']) assert.equal((await request(port, { path: `${path}?previewToken=${resource}`, requestHeaders })).status, 403);
  assert.equal((await request(port, { path: '/preview/4173/module.js', requestHeaders })).status, 403);
  assert.equal((await request(port, { path: `/preview/4173/module.js?previewToken=${resource}`, requestHeaders, method: 'POST' })).status, 403);
  assert.equal((await request(port, { path: '/preview/4173/module.js?previewToken=not-resource-jwt', requestHeaders })).status, 403);
});
