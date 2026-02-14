const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function loadBetterSqlite3() {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const probe = new BetterSqlite3(':memory:');
    probe.close();
    return null;
  } catch (error) {
    return error;
  }
}

function npmCommand() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      argsPrefix: [process.env.npm_execpath]
    };
  }

  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const nodeBinDir = path.dirname(process.execPath);
  const npmFromNodeDir = path.join(nodeBinDir, npmExecutable);

  if (fs.existsSync(npmFromNodeDir)) {
    return {
      command: npmFromNodeDir,
      argsPrefix: []
    };
  }

  return {
    command: npmExecutable,
    argsPrefix: []
  };
}

const initialError = loadBetterSqlite3();
if (!initialError) {
  process.exit(0);
}

const message = String(initialError?.message || '');
const isAbiMismatch = message.includes('NODE_MODULE_VERSION');
const isMissingBinding =
  message.includes('Could not locate the bindings file') ||
  message.includes('Cannot find module');

if (!isAbiMismatch && !isMissingBinding) {
  console.error('[setup] Failed to load better-sqlite3.');
  console.error(initialError);
  process.exit(1);
}

if (isMissingBinding) {
  console.warn('[setup] better-sqlite3 bindings are missing. Rebuilding native module...');
} else {
  console.warn('[setup] Detected better-sqlite3 binary mismatch. Rebuilding for current Node.js...');
}

const backendDir = path.resolve(__dirname, '..');
const npm = npmCommand();
const nodeBinDir = path.dirname(process.execPath);
const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
const currentPath = process.env[pathKey] || '';
const pathParts = currentPath
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);

if (!pathParts.includes(nodeBinDir)) {
  pathParts.unshift(nodeBinDir);
}

// Ensure npm can always spawn shell commands during rebuild.
for (const requiredPath of ['/bin', '/usr/bin']) {
  if (!pathParts.includes(requiredPath)) {
    pathParts.push(requiredPath);
  }
}

const normalizedPath = pathParts.join(path.delimiter);

const rebuild = spawnSync(npm.command, [...npm.argsPrefix, 'rebuild', 'better-sqlite3'], {
  cwd: backendDir,
  env: {
    ...process.env,
    [pathKey]: normalizedPath
  },
  stdio: 'inherit'
});

if (rebuild.status !== 0) {
  process.exit(rebuild.status || 1);
}

const retryError = loadBetterSqlite3();
if (retryError) {
  console.error('[setup] better-sqlite3 rebuild completed but module still failed to load.');
  console.error(retryError);
  process.exit(1);
}

console.log('[setup] better-sqlite3 is ready.');
