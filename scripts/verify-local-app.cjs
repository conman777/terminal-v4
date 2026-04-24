#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const CHECK_TIMEOUT_MS = 5000;

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout || result.stderr || ''}`.trim().split('\n')[0] || 'not found'
  };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function report(label, ok, detail) {
  const marker = ok ? 'PASS' : 'FAIL';
  console.log(`${marker} ${label}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  const node = commandExists('node');
  const npm = commandExists('npm');
  const cargo = commandExists('cargo');

  report('Node.js available', node.ok, node.output);
  report('npm available', npm.ok, npm.output);
  report('Rust cargo available', cargo.ok, cargo.output);

  const api = await fetchText('http://127.0.0.1:3020/api/health');
  const apiOk = api.ok && api.text.includes('"ok"');
  report('Rust API health on 3020', apiOk, api.text.slice(0, 120));

  const backendUi = await fetchText('http://127.0.0.1:3020/');
  const backendUiOk = backendUi.ok && backendUi.text.includes('<div id="root"');
  report(
    'Production UI served by Rust API on 3020',
    backendUiOk,
    backendUi.ok ? `HTTP ${backendUi.status}` : backendUi.text
  );

  const viteRoot = await fetchText('http://127.0.0.1:5173/');
  if (viteRoot.ok) {
    const viteMain = await fetchText('http://127.0.0.1:5173/src/main.jsx');
    report(
      'Vite dev UI on 5173',
      viteMain.ok && viteMain.text.includes('createRoot'),
      viteMain.ok ? `HTTP ${viteMain.status}` : viteMain.text
    );
  } else {
    report('Vite dev UI on 5173', false, 'not running; use npm run frontend:dev when needed');
  }

  if (!node.ok || !npm.ok || !cargo.ok || !apiOk || !backendUiOk) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
