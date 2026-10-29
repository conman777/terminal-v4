const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const {
  prepare,
  validateRuntime,
  runtimeTarget,
  verifyRuntime,
} = require('./prepare-browser-runtime.cjs');

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-browser-runtime-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const modules = path.join(repoRoot, 'backend/node_modules');
  for (const name of ['playwright', 'playwright-core']) {
    fs.mkdirSync(path.join(modules, name), { recursive: true });
    fs.writeFileSync(path.join(modules, name, 'package.json'), JSON.stringify({ name, version: '1.64.1' }));
    fs.writeFileSync(path.join(modules, name, 'index.js'), `exports.chromium = { executablePath: () => require('node:path').join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1248', 'fixture-browser') };`);
  }
  fs.writeFileSync(path.join(modules, 'playwright-core/browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1248', browserVersion: '156.0.8078.4' }] }));
  fs.writeFileSync(path.join(modules, 'playwright/cli.js'), '// fixture install entry');
  const cache = path.join(repoRoot, 'build-input-cache');
  fs.mkdirSync(path.join(cache, 'chromium-1248'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'chromium-1248/fixture-browser'), 'owned browser');
  fs.chmodSync(path.join(cache, 'chromium-1248/fixture-browser'), 0o755);
  const stageNode = async (root) => {
    const node = path.join(root, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.copyFileSync(process.execPath, node);
    return { path: path.relative(root, node).split(path.sep).join('/'), version: '22.23.1' };
  };
  return { repoRoot, cache, stageNode };
}

test('only supported native platform/architecture pairs can be provisioned', () => {
  assert.deepEqual(runtimeTarget('darwin', 'arm64'), { platform: 'darwin', arch: 'arm64', nodeArchive: 'node-v22.23.1-darwin-arm64.tar.gz' });
  assert.equal(runtimeTarget('win32', 'x64').nodeArchive, 'node-v22.23.1-win-x64.zip');
  assert.throws(() => runtimeTarget('win32', 'arm64'), /Unsupported/);
  assert.throws(() => runtimeTarget('linux', 'ia32'), /Unsupported/);
});

test('cross-target desktop builds fail before reusing or provisioning a host runtime', () => {
  const { spawnSync } = require('node:child_process');
  const foreign = process.platform === 'win32' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc';
  const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare-browser-runtime.cjs')], {
    env: { ...process.env, TAURI_ENV_TARGET_TRIPLE: foreign }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /native.*host|cross-compilation/i);
});

test('provisioning creates a relocatable independent copy and reuses a valid runtime', async (t) => {
  const f = fixture(t);
  const options = { repoRoot: f.repoRoot, cacheRoots: [f.cache], verify: false };
  const first = await prepare(options, { stageNode: f.stageNode });
  assert.equal(first.manifest.playwrightVersion, '1.64.1');
  assert.equal(first.manifest.chromiumRevision, '1248');
  assert.equal(first.manifest.platform, process.platform);
  assert.equal(first.manifest.arch, process.arch);
  assert.equal(path.isAbsolute(first.manifest.chromium), false);
  const moved = path.join(f.repoRoot, 'installed elsewhere/browser-runtime');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.cpSync(first.root, moved, { recursive: true });
  fs.rmSync(f.cache, { recursive: true });
  fs.rmSync(path.join(f.repoRoot, 'backend'), { recursive: true });
  const runtime = validateRuntime(moved);
  assert.equal(fs.readFileSync(runtime.chromium, 'utf8'), 'owned browser');
  assert.equal(execFileSync(runtime.node, ['--version'], { encoding: 'utf8', env: { PATH: '' } }).trim(), process.version);
  assert.equal((await prepare(options, { stageNode() { throw new Error('must reuse'); } })).root, first.root);
});

test('a missing exact cache revision installs through staged Node into the owned directory', async (t) => {
  const f = fixture(t);
  fs.renameSync(path.join(f.cache, 'chromium-1248'), path.join(f.cache, 'chromium-9999'));
  const installs = [];
  const result = await prepare({ repoRoot: f.repoRoot, cacheRoots: [f.cache], verify: false }, {
    stageNode: f.stageNode,
    run(file, args, options) {
      if (args[0].endsWith('cli.js')) {
        installs.push({ file, args, browserPath: options.env.PLAYWRIGHT_BROWSERS_PATH });
        const browser = path.join(options.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1248/fixture-browser');
        fs.mkdirSync(path.dirname(browser), { recursive: true });
        fs.writeFileSync(browser, 'downloaded compatible browser');
        fs.chmodSync(browser, 0o755);
        return '';
      }
      return execFileSync(file, args, options);
    },
  });
  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].args.slice(1), ['install', 'chromium', '--no-shell']);
  assert.ok(installs[0].file.startsWith(path.join(f.repoRoot, '.runtime')));
  assert.ok(installs[0].browserPath.startsWith(path.join(f.repoRoot, '.runtime')));
  assert.equal(fs.readFileSync(result.chromium, 'utf8'), 'downloaded compatible browser');
});

test('validation rejects wrong versions, platforms, missing files, traversal and external symlinks', async (t) => {
  const f = fixture(t);
  const result = await prepare({ repoRoot: f.repoRoot, cacheRoots: [f.cache], verify: false }, { stageNode: f.stageNode });
  const manifestPath = path.join(result.root, 'runtime.json');
  const original = JSON.parse(fs.readFileSync(manifestPath));
  for (const update of [{ platform: 'unsupported' }, { arch: 'unsupported' }, { playwrightVersion: '1.0.0' }, { chromiumRevision: '9999' }, { node: '../external-node' }, { chromium: path.resolve('/external-browser') }, { node: 'missing-node' }]) {
    fs.writeFileSync(manifestPath, JSON.stringify({ ...original, ...update }));
    assert.throws(() => validateRuntime(result.root));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(original));
  const corePackage = path.join(result.root, 'node_modules/playwright-core/package.json');
  fs.writeFileSync(corePackage, JSON.stringify({ version: '1.0.0' }));
  assert.throws(() => validateRuntime(result.root), /playwright-core/);
  fs.writeFileSync(corePackage, JSON.stringify({ version: '1.64.1' }));
  if (process.platform !== 'win32') {
    fs.rmSync(result.node);
    fs.symlinkSync(process.execPath, result.node);
    assert.throws(() => validateRuntime(result.root), /outside/);
  }
});

test('a failed install leaves the previous runtime intact and removes staging files', async (t) => {
  const f = fixture(t);
  const options = { repoRoot: f.repoRoot, cacheRoots: [f.cache], verify: false };
  const existing = await prepare(options, { stageNode: f.stageNode });
  fs.writeFileSync(path.join(existing.root, 'runtime.json'), '{}');
  await assert.rejects(prepare(options, { stageNode: async () => { throw new Error('download failed'); } }), /download failed/);
  assert.equal(fs.readFileSync(path.join(existing.root, 'runtime.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(path.dirname(existing.root)), ['browser']);
});

test('verification launches the explicit engine with no host discovery and exercises a page', (t) => {
  const f = fixture(t);
  const runtime = { root: f.repoRoot, node: process.execPath, chromium: path.join(f.repoRoot, 'engine') };
  let call;
  verifyRuntime(runtime, (file, args, options) => { call = { file, args, options }; return '{}'; });
  assert.equal(call.file, process.execPath);
  assert.equal(call.options.env.PATH, '');
  assert.equal(call.options.env.NODE_PATH, undefined);
  assert.equal(call.options.env.NODE_OPTIONS, undefined);
  assert.equal(call.options.env.PLAYWRIGHT_BROWSERS_PATH, path.join(f.repoRoot, 'browsers'));
  assert.doesNotThrow(() => new (require('node:vm').Script)(call.args[1]));
  assert.ok(call.args[1].includes('executablePath:'));
  assert.ok(call.args[1].includes('screenshot'));
  assert.ok(!call.args[1].includes("channel: 'chrome'"));
});

test('build and desktop hooks provision the runtime and bundles include it on every platform', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json')));
  assert.equal(pkg.scripts['browser:install'], 'node scripts/prepare-browser-runtime.cjs');
  assert.ok(pkg.scripts['app:build'].includes('browser:install'));
  assert.ok(pkg.scripts['desktop:install'].includes('browser:install'));
  assert.ok(pkg.scripts['desktop:predev'].includes('browser:install'));
  const configRoot = path.join(repoRoot, 'desktop/tauri/src-tauri');
  const base = JSON.parse(fs.readFileSync(path.join(configRoot, 'tauri.conf.json')));
  assert.equal(base.bundle.active, true);
  for (const command of [base.build.beforeBuildCommand, base.build.beforeDevCommand, base.build.beforeBundleCommand]) {
    assert.ok(command.includes('prepare-browser-runtime.cjs'));
  }
  assert.equal(base.bundle.resources['../../../.runtime/browser/'], 'browser-runtime/');
  const mac = JSON.parse(fs.readFileSync(path.join(configRoot, 'tauri.macos.conf.json')));
  assert.equal(mac.bundle.resources['../../../.runtime/browser/'], 'browser-runtime/');
  const windows = JSON.parse(fs.readFileSync(path.join(configRoot, 'tauri.windows.conf.json')));
  assert.equal(windows.bundle.resources['../../../rust/target/release/terminal-v4-api.exe'], 'terminal-v4-api.exe');
  assert.equal(windows.bundle.resources['../../../.runtime/browser/'], 'browser-runtime/');
  const linux = JSON.parse(fs.readFileSync(path.join(configRoot, 'tauri.linux.conf.json')));
  assert.equal(linux.bundle.resources['../../../rust/target/release/terminal-v4-api'], 'terminal-v4-api');
});
