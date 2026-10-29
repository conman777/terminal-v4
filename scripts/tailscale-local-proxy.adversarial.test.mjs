import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createGateway } from './tailscale-local-proxy.mjs';

const allowedLogin = 'Synthetic-Owner';
const externalHost = 'independent.synthetic-tail.ts.net';
const externalOrigin = `https://${externalHost}`;
const validHeaders = [
  ['Host', externalHost],
  ['Tailscale-User-Login', allowedLogin],
  ['Origin', externalOrigin],
];

async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let gateway;
  t.after(async () => {
    if (gateway) await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });
  gateway = await createGateway({ allowedLogin, externalHost, upstreamPort: upstream.address().port, port: 0 });
  return { port: gateway.address().port, upstreamPort: upstream.address().port, gateway };
}

function rawRequest(port, headers = validHeaders, { method = 'GET', target = '/', upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Independent gateway request timed out'));
    }, 2000);
    let response = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${method} ${target} HTTP/1.1\r\n${[
      ...headers,
      ...(upgrade ? [['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Key', 'dGhlIHNhbXBsZSBub25jZQ=='], ['Sec-WebSocket-Version', '13']] : [['Connection', 'close']]),
    ].map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ status: Number(response.split(' ')[1]), raw: response });
    });
  });
}

test('raw mixed-case duplicate trust headers fail closed for HTTP and WebSocket before upstream contact', async t => {
  let hits = 0;
  const { port } = await fixture(t, (_request, response) => { hits += 1; response.end(); });
  for (const duplicate of [['hOsT', externalHost], ['oRiGiN', externalOrigin], ['tAiLsCaLe-UsEr-LoGiN', allowedLogin]]) {
    for (const upgrade of [false, true]) {
      const response = await rawRequest(port, [...validHeaders, duplicate], { upgrade });
      assert.equal(response.status, 403, `${duplicate[0]} duplicate / upgrade=${upgrade}`);
    }
  }
  assert.equal(hits, 0);
});

test('identity and authority matching reject prefixes, case changes, list values and misleading origin syntax', async t => {
  let hits = 0;
  const { port } = await fixture(t, (_request, response) => { hits += 1; response.end(); });
  const replacements = [
    ['Tailscale-User-Login', allowedLogin.toLowerCase()],
    ['Tailscale-User-Login', `${allowedLogin},Other`],
    ['Tailscale-User-Login', `${allowedLogin}.attacker`],
    ['Tailscale-User-Login', `Other${allowedLogin}`],
    ['Host', `${externalHost}.attacker.test`],
    ['Host', `${externalHost}:444`],
    ['Origin', `https://${externalHost}@attacker.test`],
    ['Origin', `https://${externalHost}/`],
    ['Origin', `${externalOrigin}, https://attacker.test`],
    ['Origin', `${externalOrigin}:444`],
  ];
  for (const [name, value] of replacements) {
    const headers = validHeaders.map(([key, current]) => [key, key === name ? value : current]);
    for (const upgrade of [false, true]) assert.equal((await rawRequest(port, headers, { upgrade })).status, 403, `${name}=${value} / upgrade=${upgrade}`);
  }
  assert.equal(hits, 0);
});

test('client Connection nominations cannot remove fixed trusted forwarding headers or leak private response hops', async t => {
  let observed;
  const { port, upstreamPort } = await fixture(t, (request, response) => {
    observed = request.headers;
    response.writeHead(200, {
      Connection: 'x-private-hop, keep-alive',
      'X-Private-Hop': 'hidden',
      'Keep-Alive': 'timeout=999',
      'Set-Cookie': ['one=1; HttpOnly', 'two=2; Secure'],
      'X-App-Header': 'preserved',
    });
    response.end('trusted');
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1', port,
      headers: {
        Host: externalHost, Origin: externalOrigin, 'Tailscale-User-Login': allowedLogin,
        Connection: 'host, origin, x-forwarded-host, x-forwarded-proto, x-forwarded-port, x-custom-hop, tailscale-user-login, forwarded',
        'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Port': '666',
        'X-Forwarded-Prefix': '/admin', 'X-Custom-Hop': 'hidden', Forwarded: 'host=attacker.test',
        'Tailscale-User-Profile-Pic': 'https://private.invalid/profile',
      },
    }, incoming => {
      incoming.resume();
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers }));
    });
    request.on('error', reject);
  });
  assert.equal(response.status, 200);
  assert.equal(observed.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(observed.origin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(observed['x-forwarded-host'], externalHost);
  assert.equal(observed['x-forwarded-proto'], 'https');
  for (const name of ['x-forwarded-port', 'x-forwarded-prefix', 'forwarded', 'tailscale-user-login', 'tailscale-user-profile-pic', 'x-custom-hop']) assert.equal(observed[name], undefined, name);
  assert.equal(response.headers['x-private-hop'], undefined);
  assert.notEqual(response.headers['keep-alive'], 'timeout=999');
  assert.deepEqual(response.headers['set-cookie'], ['one=1; HttpOnly', 'two=2; Secure']);
  assert.equal(response.headers['x-app-header'], 'preserved');
});

test('absolute-form request targets cannot redirect the gateway to a second loopback service', async t => {
  let tripwireHits = 0;
  const tripwire = http.createServer((_request, response) => { tripwireHits += 1; response.end('incorrect target'); });
  tripwire.listen(0, '127.0.0.1');
  await once(tripwire, 'listening');
  t.after(() => new Promise(resolve => tripwire.close(resolve)));
  const { port } = await fixture(t, (_request, response) => response.end('fixed upstream'));
  const response = await rawRequest(port, validHeaders, { target: `http://127.0.0.1:${tripwire.address().port}/admin` });
  assert.ok([200, 400, 403].includes(response.status), response.raw);
  assert.equal(tripwireHits, 0);
  assert.equal(response.raw.includes('incorrect target'), false);
});

test('explicit private HTTP origin preserves the configured authority and does not accept HTTPS or an omitted port', async t => {
  const upstream = http.createServer((request, response) => response.end(JSON.stringify(request.headers)));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const configuredOrigin = `http://${externalHost}:8080`;
  const gateway = await createGateway({ allowedLogin, externalHost, externalOrigin: configuredOrigin, upstreamPort: upstream.address().port, port: 0 });
  t.after(async () => {
    await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });
  const valid = [['Host', `${externalHost}:8080`], ['Tailscale-User-Login', allowedLogin], ['Origin', configuredOrigin]];
  const response = await rawRequest(gateway.address().port, valid);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.raw.split('\r\n\r\n')[1]);
  assert.equal(body['x-forwarded-host'], `${externalHost}:8080`);
  assert.equal(body['x-forwarded-proto'], 'http');
  assert.equal(body.host, `127.0.0.1:${upstream.address().port}`);
  for (const altered of [
    valid.map(([key, value]) => [key, key === 'Host' ? externalHost : value]),
    valid.map(([key, value]) => [key, key === 'Origin' ? externalOrigin : value]),
  ]) assert.equal((await rawRequest(gateway.address().port, altered)).status, 403);
});

test('opaque preview reads carry only the scoped credential and reject broader routes, methods and credential kinds', async t => {
  const jwtShape = tokenKind => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ token_kind: tokenKind })).toString('base64url')}.synthetic-signature`;
  const resource = jwtShape('preview-resource');
  const account = jwtShape('access');
  const environment = '00000000-0000-4000-8000-000000000123';
  const observed = [];
  const { port } = await fixture(t, (request, response) => {
    observed.push({ method: request.method, url: request.url, headers: request.headers });
    response.end('resource fixture');
  });
  const opaqueHeaders = validHeaders.map(([key, value]) => [key, key === 'Origin' ? 'null' : value]);
  opaqueHeaders.push(['Sec-Fetch-Site', 'cross-site'], ['Authorization', `Bearer ${account}`], ['Cookie', `terminal_preview_token=${account}; other=private`]);
  const targets = [
    '/preview/4173/main.js', '/api/preview?path=%2Fsynthetic&file=main.js', '/api/proxy-external?url=https%3A%2F%2Fsynthetic.invalid%2Fmain.js',
    `/api/environments/${environment}/proxy/preview/4173/main.js`,
    `/api/environments/${environment}/proxy/api/preview?path=%2Fsynthetic&file=main.js`,
    `/api/environments/${environment}/proxy/api/proxy-external?url=https%3A%2F%2Fsynthetic.invalid%2Fmain.js`,
  ];
  for (const target of targets) {
    const query = new URLSearchParams({ previewToken: resource, token: account });
    query.append('token', 'tv4pair.synthetic-delegated');
    query.append('token', 'opaque-business-value');
    const response = await rawRequest(port, opaqueHeaders, { target: `${target}${target.includes('?') ? '&' : '?'}${query}` });
    assert.equal(response.status, 200, target);
    const latest = observed.at(-1);
    assert.equal(latest.headers.authorization, undefined);
    assert.equal(latest.headers.cookie, undefined);
    const upstream = new URL(latest.url, 'http://synthetic.invalid');
    assert.equal(upstream.searchParams.get('previewToken'), resource);
    assert.deepEqual(upstream.searchParams.getAll('token'), ['opaque-business-value']);
  }
  assert.equal((await rawRequest(port, opaqueHeaders, { method: 'HEAD', target: `/preview/4173/main.js?previewToken=${resource}` })).status, 200);
  const acceptedHits = observed.length;
  const negatives = [
    '/api/state', '/api/preview/resource-auth', '/api/preview-extra', '/preview/0/main.js', '/preview/65536/main.js',
    `/api/environments/${environment}/proxy/api/state`, '/api/environments/not-a-uuid/proxy/preview/4173/main.js',
    '/\\%', '/\\[',
  ];
  for (const target of negatives) assert.equal((await rawRequest(port, opaqueHeaders, { target: `${target}?previewToken=${resource}` })).status, 403, target);
  for (const target of ['/preview/4173/main.js', '/preview/4173/main.js?previewToken=', `/preview/4173/main.js?previewToken=${account}`, `/preview/4173/main.js?previewToken=${resource}&previewToken=${resource}`]) {
    assert.equal((await rawRequest(port, opaqueHeaders, { target })).status, 403, target);
  }
  for (const method of ['POST', 'DELETE']) assert.equal((await rawRequest(port, opaqueHeaders, { method, target: `/preview/4173/main.js?previewToken=${resource}` })).status, 403);
  assert.equal((await rawRequest(port, opaqueHeaders, { upgrade: true, target: `/preview/4173/main.js?previewToken=${resource}` })).status, 403);
  const foreign = opaqueHeaders.map(([key, value]) => [key, key === 'Tailscale-User-Login' ? 'Another-Owner' : value]);
  assert.equal((await rawRequest(port, foreign, { target: `/preview/4173/main.js?previewToken=${resource}` })).status, 403);
  assert.equal(observed.length, acceptedHits);
});
