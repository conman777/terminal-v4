import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { frontendAssets, manifestHash, verifyDeployment } from './verify-deployment.mjs';

const run = (args) => promisify(execFile)(process.execPath, [script, ...args], { encoding: 'utf8' }).then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code, stdout: e.stdout, stderr: e.stderr }));
const script = fileURLToPath(new URL('./verify-deployment.mjs', import.meta.url));
const INDEX = '<script type="module" src="/assets/index-AAA.js"></script><link rel="stylesheet" href="/assets/index-BBB.css">';
const JS = 'console.log("app")';
const CSS = 'body{}';

function serve({ index = INDEX, info, health = true, assets = { 'assets/index-AAA.js': JS, 'assets/index-BBB.css': CSS } }) {
  const server = http.createServer((request, response) => {
    const url = request.url.split('?')[0];
    if (url === '/api/health' && health) return response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    if (url === '/api/build-info' && info) return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(info));
    const asset = assets[url.slice(1)];
    if (asset !== undefined) return response.writeHead(200, { 'content-type': 'text/javascript' }).end(asset);
    if (url === '/' || !url.startsWith('/api/') && !url.startsWith('/assets/')) return response.writeHead(200, { 'content-type': 'text/html' }).end(index);
    response.writeHead(404, { 'content-type': 'text/html' }).end(index);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const goodInfo = (overrides = {}) => {
  const assets = frontendAssets(INDEX);
  return { commit: 'abc123def456', dirty: false, frontend: { available: true, assets, manifestHash: manifestHash(assets) }, ...overrides };
};

async function withServer(options, run) {
  const { server, url } = await serve(options);
  try { return await run(url); } finally { server.close(); }
}

async function makeDist(index = INDEX) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verify-dist-'));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), index);
  await writeFile(path.join(dir, 'assets/index-AAA.js'), JS);
  await writeFile(path.join(dir, 'assets/index-BBB.css'), CSS);
  return dir;
}

test('frontendAssets returns sorted unique asset paths', () => {
  assert.deepEqual(frontendAssets(`${INDEX}<script src="/assets/index-AAA.js?x=1"></script>`), ['assets/index-AAA.js', 'assets/index-BBB.css']);
});

test('passes when commit, manifest, root and local dist all match', async () => {
  const dist = await makeDist();
  await withServer({ info: goodInfo() }, async (url) => {
    const result = await verifyDeployment({ baseUrl: url, expectCommit: 'abc123', distDir: dist });
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
  });
});

test('generic health and root 200 without build-info is not proof', async () => {
  await withServer({ info: null }, async (url) => {
    const result = await verifyDeployment({ baseUrl: url });
    assert.equal(result.ok, false);
    assert.match(result.failures[0], /build-info returned 404/);
  });
});

test('fails on commit mismatch, unknown commit and dirty build', async () => {
  await withServer({ info: goodInfo({ commit: 'zzz999' }) }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url, expectCommit: 'abc123' })).failures.join('\n'), /commit mismatch/);
  });
  await withServer({ info: goodInfo({ commit: 'unknown' }) }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url })).failures.join('\n'), /commit identity/);
  });
  await withServer({ info: goodInfo({ dirty: true }) }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url })).failures.join('\n'), /dirty/);
    assert.equal((await verifyDeployment({ baseUrl: url, allowDirty: true })).ok, true);
  });
});

test('fails when served index.html differs from build-info manifest', async () => {
  const stale = INDEX.replace('AAA', 'OLD');
  await withServer({ index: stale, info: goodInfo(), assets: { 'assets/index-OLD.js': JS, 'assets/index-BBB.css': CSS } }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url })).failures.join('\n'), /do not match build-info manifest/);
  });
});

test('fails when local dist assets or bytes differ from the served ones', async () => {
  const otherDist = await makeDist(INDEX.replace('AAA', 'NEW'));
  await withServer({ info: goodInfo() }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url, distDir: otherDist })).failures.join('\n'), /local dist assets/);
  });
  const dist = await makeDist();
  await withServer({ info: goodInfo(), assets: { 'assets/index-AAA.js': 'tampered', 'assets/index-BBB.css': CSS } }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url, distDir: dist })).failures.join('\n'), /bytes differ/);
  });
});

test('fails when a referenced asset falls back to HTML', async () => {
  await withServer({ info: goodInfo(), assets: { 'assets/index-BBB.css': CSS } }, async (url) => {
    assert.match((await verifyDeployment({ baseUrl: url })).failures.join('\n'), /asset is not really served/);
  });
});

test('cli exits non-zero with the reason and zero on success', async () => {
  const dist = await makeDist();
  await withServer({ info: goodInfo() }, async (url) => {
    const ok = await run(['--url', url, '--expect-commit', 'abc123', '--dist', dist]);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = await run(['--url', url, '--expect-commit', 'ffffff']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /FAIL: commit mismatch/);
  });
});
