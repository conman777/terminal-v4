const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PLAYWRIGHT_VERSION = '1.64.1';
const NODE_VERSION = '22.23.1';
const SCHEMA_VERSION = 1;

function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].includes(`${platform}-${arch}`)) {
    throw new Error(`Unsupported browser runtime target: ${platform}-${arch}. Build on a supported native host; cross-compilation is not supported.`);
  }
  const nodePlatform = platform === 'win32' ? 'win' : platform;
  return { platform, arch, nodeArchive: `node-v${NODE_VERSION}-${nodePlatform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}` };
}

function assertNativeBuild() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const suffix = process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-(msvc|gnu)' : 'unknown-linux-gnu';
  const native = new RegExp(`^${arch}-${suffix}$`);
  for (const target of [process.env.TAURI_ENV_TARGET_TRIPLE, process.env.CARGO_BUILD_TARGET].filter(Boolean)) {
    if (!native.test(target)) throw new Error(`Browser runtime must be built on a matching native host; cross-compilation to ${target} is unsupported.`);
  }
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ownedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error(`Invalid runtime relative path: ${relative}`);
  }
  const file = path.join(root, relative);
  const actual = fs.realpathSync(file);
  const within = path.relative(fs.realpathSync(root), actual);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error(`Runtime file points outside its root: ${relative}`);
  }
  if (!fs.statSync(actual).isFile()) throw new Error(`Runtime file missing: ${relative}`);
  return file;
}

function validateRuntime(root) {
  root = fs.realpathSync(root);
  const manifest = json(path.join(root, 'runtime.json'));
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.nodeVersion !== NODE_VERSION || manifest.playwrightVersion !== PLAYWRIGHT_VERSION) {
    throw new Error(`Incompatible browser runtime manifest at ${root}`);
  }
  const node = ownedFile(root, manifest.node);
  const chromium = ownedFile(root, manifest.chromium);
  for (const name of ['playwright', 'playwright-core']) {
    const pkg = json(ownedFile(root, `node_modules/${name}/package.json`));
    if (pkg.version !== PLAYWRIGHT_VERSION) throw new Error(`Expected ${name}@${PLAYWRIGHT_VERSION}`);
    ownedFile(root, `node_modules/${name}/index.js`);
  }
  const descriptor = json(ownedFile(root, 'node_modules/playwright-core/browsers.json')).browsers.find((browser) => browser.name === 'chromium');
  if (!descriptor || manifest.chromiumRevision !== descriptor.revision || manifest.chromiumVersion !== descriptor.browserVersion || !manifest.chromium.startsWith(`browsers/chromium-${descriptor.revision}/`)) {
    throw new Error('Chromium revision does not match the pinned Playwright package');
  }
  fs.accessSync(node, fs.constants.X_OK);
  fs.accessSync(chromium, fs.constants.X_OK);
  return { root, node, chromium, manifest };
}

function isolatedEnv(root) {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'browsers'), PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|PLAYWRIGHT_NODE_BIN|PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD|PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH|PLAYWRIGHT_MCP_EXECUTABLE_PATH|PWTEST_.*|__PW_.*)$/i.test(key)) delete env[key];
  }
  return env;
}

function verifyRuntime(runtime, run = execFileSync) {
  const pageUrl = 'data:text/html,' + encodeURIComponent(`<title>Terminal runtime</title><input aria-label="Value"><button onclick="document.title=document.querySelector('input').value">Apply</button>`);
  const script = `
    const assert = require('node:assert/strict');
    const { chromium } = require(${JSON.stringify(path.join(runtime.root, 'node_modules/playwright'))});
    (async () => {
      const browser = await chromium.launch({ executablePath: ${JSON.stringify(runtime.chromium)}, headless: true });
      try {
        ${runtime.manifest ? `assert.equal(browser.version(), ${JSON.stringify(runtime.manifest.chromiumVersion)});` : ''}
        const page = await browser.newPage();
        await page.goto(${JSON.stringify(pageUrl)});
        await page.getByRole('textbox', { name: 'Value' }).fill('owned Chromium');
        await page.getByRole('button', { name: 'Apply' }).click();
        assert.equal(await page.title(), 'owned Chromium');
        const screenshot = await page.screenshot();
        assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        console.log(JSON.stringify({ node: process.version, chromium: browser.version(), screenshotBytes: screenshot.length }));
      } finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-browser-smoke-'));
  try {
    return run(runtime.node, ['-e', script], {
      cwd: runtime.root,
      env: { ...isolatedEnv(runtime.root), PATH: '', HOME: home, USERPROFILE: home, XDG_CACHE_HOME: home },
      encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (destination) fs.writeFileSync(destination, data);
  return data;
}

async function stageOfficialNode(root) {
  const target = runtimeTarget();
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const work = path.join(root, 'node-download');
  fs.mkdirSync(work);
  const archive = path.join(work, target.nodeArchive);
  console.log(`[browser-runtime] Downloading official Node ${NODE_VERSION} (${target.platform}-${target.arch})`);
  const checksums = (await download(`${base}/SHASUMS256.txt`)).toString();
  const expected = checksums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find(([, name]) => name === target.nodeArchive)?.[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error(`Missing official checksum for ${target.nodeArchive}`);
  const data = await download(`${base}/${target.nodeArchive}`, archive);
  if (crypto.createHash('sha256').update(data).digest('hex') !== expected) throw new Error('Official Node archive checksum mismatch');
  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(work)}`], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' });
  }
  const extracted = path.join(work, target.nodeArchive.replace(/\.(zip|tar\.gz)$/, ''));
  const relative = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(extracted, process.platform === 'win32' ? 'node.exe' : 'bin/node'), destination);
  fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(root, 'node/LICENSE'));
  fs.chmodSync(destination, 0o755);
  const version = execFileSync(destination, ['--version'], { encoding: 'utf8', env: isolatedEnv(root) }).trim();
  if (version !== `v${NODE_VERSION}`) throw new Error(`Unexpected staged Node version: ${version}`);
  fs.rmSync(work, { recursive: true });
  return { path: relative, version: NODE_VERSION };
}

function stagePackages(repoRoot, root, run) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'terminal-v4-browser-runtime', private: true, version: '1.0.0', dependencies: { playwright: PLAYWRIGHT_VERSION, 'playwright-core': PLAYWRIGHT_VERSION } }, null, 2));
  const sources = ['', 'backend', 'frontend'].map((prefix) => path.join(repoRoot, prefix, 'node_modules'));
  const source = sources.find((modules) => ['playwright', 'playwright-core'].every((name) => {
    try { return json(path.join(modules, name, 'package.json')).version === PLAYWRIGHT_VERSION; } catch { return false; }
  }));
  if (source) {
    for (const name of ['playwright', 'playwright-core']) {
      fs.cpSync(fs.realpathSync(path.join(source, name)), path.join(root, 'node_modules', name), { recursive: true, verbatimSymlinks: true });
    }
  } else {
    const npmCli = process.env.npm_execpath;
    const args = ['install', '--prefix', root, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];
    if (npmCli) run(process.execPath, [npmCli, ...args], { stdio: 'inherit', env: { ...isolatedEnv(root), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
    else if (process.platform !== 'win32') run('npm', args, { stdio: 'inherit', env: { ...isolatedEnv(root), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
    else throw new Error('Run `npm run browser:install` to install pinned Playwright packages on Windows.');
  }
}

function managedCacheRoots(repoRoot) {
  const roots = [];
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') roots.push(path.resolve(override));
  const home = os.homedir();
  roots.push(process.platform === 'darwin' ? path.join(home, 'Library/Caches/ms-playwright') : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'ms-playwright') : path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright'));
  for (const prefix of ['', 'backend', 'frontend']) roots.push(path.join(repoRoot, prefix, 'node_modules/playwright-core/.local-browsers'));
  return roots;
}

function assertSelfContained(root, directory = root) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const relative = path.relative(root, fs.realpathSync(file));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Runtime symlink points outside its root: ${file}`);
    } else if (entry.isDirectory()) assertSelfContained(root, file);
  }
}

async function prepare({ repoRoot = path.resolve(__dirname, '..'), cacheRoots = managedCacheRoots(repoRoot), verify = true } = {}, { stageNode = stageOfficialNode, run = execFileSync } = {}) {
  runtimeTarget();
  assertNativeBuild();
  const root = path.join(repoRoot, '.runtime/browser');
  try {
    const runtime = validateRuntime(root);
    assertSelfContained(runtime.root);
    console.log(`[browser-runtime] Ready: ${runtime.root}`);
    return runtime;
  } catch { /* A missing or obsolete generated runtime is rebuilt atomically. */ }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const lock = path.join(repoRoot, '.runtime/browser-prepare.lock');
  try { fs.mkdirSync(lock); } catch { throw new Error(`Browser runtime preparation already active, or stale lock at ${lock}. Retry after the other build exits; remove the lock only if no preparation is running.`); }
  const stage = fs.mkdtempSync(path.join(repoRoot, '.runtime/browser-stage-'));
  const backup = `${stage}-previous`;
  try {
    const node = await stageNode(stage);
    stagePackages(repoRoot, stage, run);
    const descriptor = json(path.join(stage, 'node_modules/playwright-core/browsers.json')).browsers.find((browser) => browser.name === 'chromium');
    if (!descriptor || !/^\d+$/.test(descriptor.revision)) throw new Error('Pinned Playwright Chromium descriptor is missing');
    const browserRoot = path.join(stage, 'browsers');
    const executable = run(path.join(stage, node.path), ['-e', `console.log(require(${JSON.stringify(path.join(stage, 'node_modules/playwright'))}).chromium.executablePath())`], { encoding: 'utf8', env: isolatedEnv(stage) }).trim();
    const relative = path.relative(browserRoot, executable);
    if (relative.split(path.sep)[0] !== `chromium-${descriptor.revision}`) throw new Error(`Unexpected Chromium path from pinned Playwright: ${executable}`);
    const cache = cacheRoots.find((candidate) => fs.existsSync(path.join(candidate, relative)));
    if (cache) {
      console.log(`[browser-runtime] Copying build input: ${path.join(cache, `chromium-${descriptor.revision}`)}`);
      fs.mkdirSync(browserRoot);
      fs.cpSync(path.join(cache, `chromium-${descriptor.revision}`), path.join(browserRoot, `chromium-${descriptor.revision}`), { recursive: true, verbatimSymlinks: true });
    } else {
      run(path.join(stage, node.path), [path.join(stage, 'node_modules/playwright/cli.js'), 'install', 'chromium', '--no-shell'], { stdio: 'inherit', env: isolatedEnv(stage) });
    }
    const manifest = { schemaVersion: SCHEMA_VERSION, platform: process.platform, arch: process.arch, nodeVersion: node.version, playwrightVersion: PLAYWRIGHT_VERSION, chromiumRevision: descriptor.revision, chromiumVersion: descriptor.browserVersion, node: node.path, chromium: path.relative(stage, executable).split(path.sep).join('/') };
    fs.writeFileSync(path.join(stage, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const stagedRuntime = validateRuntime(stage);
    assertSelfContained(stage);
    if (verify) console.log(`[browser-runtime] Smoke: ${verifyRuntime(stagedRuntime, run)}`);
    if (fs.existsSync(root)) fs.renameSync(root, backup);
    try { fs.renameSync(stage, root); } catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, root); throw error; }
    fs.rmSync(backup, { recursive: true, force: true });
    return validateRuntime(root);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

module.exports = { prepare, validateRuntime, runtimeTarget, verifyRuntime };

if (require.main === module) {
  (async () => {
    const runtime = await prepare();
    if (process.argv.includes('--verify')) console.log(`[browser-runtime] Smoke: ${verifyRuntime(runtime)}`);
    console.log(`[browser-runtime] Node: ${runtime.node}\n[browser-runtime] Chromium: ${runtime.chromium}`);
  })().catch((error) => { console.error(`[browser-runtime] ${error.stack || error}`); process.exitCode = 1; });
}
