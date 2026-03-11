const { execFileSync } = require('node:child_process');

const WINDOWS_DESKTOP_IMAGE = 'terminal_v4_desktop.exe';
const SHUTDOWN_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 250;

function isWindows() {
  return process.platform === 'win32';
}

function listTaskNames() {
  const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^"([^"]+)"/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

function hasDesktopProcess() {
  return listTaskNames().some((name) => name.toLowerCase() === WINDOWS_DESKTOP_IMAGE.toLowerCase());
}

function waitForShutdown() {
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (!hasDesktopProcess()) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${WINDOWS_DESKTOP_IMAGE} to exit.`);
}

function stopDesktopProcess() {
  if (!hasDesktopProcess()) {
    return false;
  }

  execFileSync('taskkill', ['/IM', WINDOWS_DESKTOP_IMAGE, '/T', '/F'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  waitForShutdown();
  return true;
}

function main() {
  if (!isWindows()) {
    return;
  }

  const stopped = stopDesktopProcess();
  if (stopped) {
    console.log(`Stopped stale ${WINDOWS_DESKTOP_IMAGE} before desktop startup.`);
  }
}

main();
