import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

const frontend = fileURLToPath(new URL('.', import.meta.url));
const project = fileURLToPath(new URL('..', import.meta.url));

test('Vite forwards API and preview requests to a configured local HTTP runtime', async () => {
  const upstream = createHttpServer((request, response) => {
    if (request.url === '/api/auth/local-testing' && request.headers.origin !== `http://${request.headers.host}`) {
      response.writeHead(403);
      response.end('Local testing requires this app\'s local origin');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, runtime: 'synthetic-http' }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const previousTarget = process.env.TERMINAL_V4_API_PROXY_TARGET;
  process.env.TERMINAL_V4_API_PROXY_TARGET = `http://127.0.0.1:${upstream.address().port}`;
  let vite;
  try {
    vite = await createServer({
      root: frontend, configFile: new URL('vite.config.js', import.meta.url).pathname,
      logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    for (const path of ['/api/health', '/preview/5173/app?query=retained']) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, `${path} must reach the HTTP runtime`);
      assert.deepEqual(await response.json(), { path, runtime: 'synthetic-http' });
    }
    const localLogin = await fetch(origin + '/api/auth/local-testing', {
      method: 'POST', headers: { Origin: origin }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(localLogin.status, 200, 'the local browser Host and Origin must stay consistent through the proxy');
    const foreignLogin = await fetch(origin + '/api/auth/local-testing', {
      method: 'POST', headers: { Origin: 'http://untrusted.invalid' }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(foreignLogin.status, 403, 'the proxy must preserve rejection of a foreign origin');
  } finally {
    if (previousTarget === undefined) delete process.env.TERMINAL_V4_API_PROXY_TARGET;
    else process.env.TERMINAL_V4_API_PROXY_TARGET = previousTarget;
    await vite?.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  }
});

test('the root E2E command selects the frontend browser suite without executing tests', () => {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', 'test:e2e', '--', '--list'], {
    cwd: project, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  });
  assert.equal(result.status, 0, (result.stderr || result.stdout || String(result.error)).slice(-3000));
  assert.match(result.stdout, /local-testing\.spec\.ts/);
  assert.match(result.stdout, /codex-local\.spec\.ts/);
  assert.doesNotMatch(result.stdout, /src\/.*\.test\./);
});
