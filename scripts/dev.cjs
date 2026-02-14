const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

function getNpmInvocation() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      baseArgs: [process.env.npm_execpath]
    };
  }

  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const nodeBinDir = path.dirname(process.execPath);
  const npmFromNodeDir = path.join(nodeBinDir, npmExecutable);
  if (fs.existsSync(npmFromNodeDir)) {
    return {
      command: npmFromNodeDir,
      baseArgs: []
    };
  }

  return {
    command: npmExecutable,
    baseArgs: []
  };
}

function tryReservePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.once('listening', () => resolve(server));
    server.listen({
      host: '0.0.0.0',
      port,
      exclusive: true
    });
  });
}

async function findAndReservePort(startPort, maxAttempts = 100) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    const reservation = await tryReservePort(candidate);
    if (reservation) {
      return {
        port: candidate,
        reservation
      };
    }
  }
  throw new Error(`Could not reserve a free port near ${startPort}`);
}

function releaseReservation(reservation) {
  return new Promise((resolve) => {
    try {
      reservation.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function spawnChild(label, cwd, args, env) {
  const npm = getNpmInvocation();
  const safeEnv = withNodeOnPath(env);
  const child = spawn(npm.command, [...npm.baseArgs, ...args], {
    cwd,
    env: safeEnv,
    stdio: 'inherit'
  });

  child.on('error', (error) => {
    console.error(`[dev] ${label} failed to start:`, error);
  });

  return child;
}

function withNodeOnPath(env) {
  const nodeBinDir = path.dirname(process.execPath);
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = env[pathKey] || process.env[pathKey] || '';
  const normalizedPath = currentPath.includes(nodeBinDir)
    ? currentPath
    : `${nodeBinDir}${path.delimiter}${currentPath}`;
  return {
    ...env,
    [pathKey]: normalizedPath
  };
}

function spawnNodeScript(label, cwd, scriptPath, scriptArgs, env) {
  const fullPath = path.join(cwd, scriptPath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }

  const child = spawn(process.execPath, [fullPath, ...scriptArgs], {
    cwd,
    env: withNodeOnPath(env),
    stdio: 'inherit'
  });

  child.on('error', (error) => {
    console.error(`[dev] ${label} failed to start:`, error);
  });

  return child;
}

async function main() {
  const backendReservation = await findAndReservePort(4020);
  const frontendReservation = await findAndReservePort(5173);
  const backendPort = backendReservation.port;
  const frontendPort = frontendReservation.port;
  const apiTarget = `http://localhost:${backendPort}`;

  console.log(`[dev] Backend port: ${backendPort}`);
  console.log(`[dev] Frontend port: ${frontendPort}`);
  console.log(`[dev] Frontend API target: ${apiTarget}`);

  const backendEnv = {
    ...process.env,
    PORT: String(backendPort)
  };
  const frontendEnv = {
    ...process.env,
    VITE_DEV_API_TARGET: apiTarget
  };

  const ensureNative = spawn(process.execPath, [path.join(BACKEND_DIR, 'scripts', 'ensure-native.cjs')], {
    cwd: BACKEND_DIR,
    env: withNodeOnPath(backendEnv),
    stdio: 'inherit'
  });
  const ensureNativeExitCode = await new Promise((resolve) => {
    ensureNative.on('exit', (code) => resolve(code ?? 1));
    ensureNative.on('error', () => resolve(1));
  });
  if (ensureNativeExitCode !== 0) {
    throw new Error('Failed to prepare backend native modules');
  }

  await releaseReservation(backendReservation.reservation);

  const backend =
    spawnNodeScript('backend', BACKEND_DIR, path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), ['watch', 'src/index.ts'], backendEnv) ||
    spawnChild('backend', BACKEND_DIR, ['run', 'dev'], backendEnv);

  await releaseReservation(frontendReservation.reservation);

  const frontend =
    spawnNodeScript('frontend', FRONTEND_DIR, path.join('node_modules', 'vite', 'bin', 'vite.js'), ['--host', '0.0.0.0', '--port', String(frontendPort), '--strictPort'], frontendEnv) ||
    spawnChild('frontend', FRONTEND_DIR, ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(frontendPort), '--strictPort'], frontendEnv);

  let shuttingDown = false;
  const children = [backend, frontend];

  const shutdown = (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dev] Shutting down (${signal})...`);
    for (const child of children) {
      if (child && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Best-effort shutdown.
        }
      }
    }
    setTimeout(() => process.exit(exitCode), 250);
  };

  backend.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] Backend exited with code ${code ?? 1}.`);
      shutdown('backend-exit', code ?? 1);
    }
  });

  frontend.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] Frontend exited with code ${code ?? 1}.`);
      shutdown('frontend-exit', code ?? 1);
    }
  });

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
}

main().catch((error) => {
  console.error('[dev] Failed to launch dev environment.');
  console.error(error);
  process.exit(1);
});
