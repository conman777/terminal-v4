/**
 * WebContainer Utility Module
 *
 * Provides lifecycle management for WebContainers - a browser-based Node.js runtime.
 * WebContainers run dev servers directly in the browser via WebAssembly,
 * eliminating URL rewriting issues and providing reliable HMR.
 */

// Singleton instance - WebContainer only allows one instance per page
let webContainerInstance = null;
let bootPromise = null;
let runtimeGeneration = 0;
let activePreview = null;
let previewQueue = Promise.resolve();
const pendingProcesses = new Set();
const PROCESS_DRAIN_TIMEOUT = 10000;

async function waitForProcessDrain(signal) {
  signal?.throwIfAborted();
  if (pendingProcesses.size === 0) return;
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Previous WebContainer process is still stopping. Retry after it exits or use proxy preview.')), PROCESS_DRAIN_TIMEOUT);
  });
  try {
    while (pendingProcesses.size > 0) {
      const drained = Promise.all([...pendingProcesses]).catch(() => {
        throw new Error('Previous WebContainer process termination could not be confirmed. Reload or use proxy preview.');
      });
      await waitWithSignal(Promise.race([drained, deadline]), signal);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createPreviewSession() {
  activePreview?.dispose();
  const controller = new AbortController();
  const session = {
    signal: controller.signal,
    dispose() {
      controller.abort();
      if (activePreview === session) activePreview = null;
    },
    run(initialize) {
      const pending = previewQueue.then(async () => {
        controller.signal.throwIfAborted();
        await waitForProcessDrain(controller.signal);
        controller.signal.throwIfAborted();
        return initialize(controller.signal);
      });
      previewQueue = pending.catch(() => {});
      return pending;
    }
  };
  activePreview = session;
  return session;
}

function waitWithSignal(promise, signal, onLateValue) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) onLateValue?.(value);
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function spawnOwnedProcess(wc, cmd, args, onOutput, signal, assertCurrent) {
  signal?.throwIfAborted();
  assertCurrent?.();
  const spawn = wc.spawn(cmd, args);
  // Cancellation settles the caller, but this barrier owns the raw spawn through exit.
  const drained = Promise.resolve(spawn).then(process => process.exit, () => {});
  pendingProcesses.add(drained);
  drained.then(() => pendingProcesses.delete(drained), () => {});
  const process = await waitWithSignal(spawn, signal, process => process.kill());
  try { assertCurrent?.(); } catch (error) { process.kill(); throw error; }
  const pipeController = new AbortController();
  let stopped = false;
  const detach = () => {
    signal?.removeEventListener('abort', stop);
    pipeController.abort();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    detach();
    process.kill();
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  else if (onOutput) {
    process.output.pipeTo(new WritableStream({ write: onOutput }), { signal: pipeController.signal }).catch(() => {});
  }
  process.exit.then(detach, detach);
  return { process, stop };
}

/** Check runtime requirements in the isolated top-level runner document. */
export function isWebContainerSupported() {
  if (!globalThis.isSecureContext) return { supported: false, reason: 'WebContainer requires HTTPS or localhost.' };
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return { supported: false, reason: 'This window is not isolated. Open /webcontainer with COOP same-origin and COEP require-corp response headers.' };
  const userAgent = navigator.userAgent;
  if (!/Chrome|Chromium|Edg/.test(userAgent) || /Firefox/.test(userAgent)) return { supported: false, reason: 'WebContainer requires Chrome or Edge.' };
  if (typeof WebAssembly === 'undefined' || !('serviceWorker' in navigator)) return { supported: false, reason: 'WebAssembly and Service Workers are required.' };
  return { supported: true, reason: null };
}

/**
 * Boot or get the singleton WebContainer instance
 * @returns {Promise<WebContainer>}
 */
export async function getWebContainer() {
  // Return existing instance if already booted
  if (webContainerInstance) {
    return webContainerInstance;
  }

  // If boot is in progress, wait for it
  if (bootPromise) {
    return bootPromise;
  }

  const support = isWebContainerSupported();
  if (!support.supported) throw new Error(support.reason);
  const generation = runtimeGeneration;
  const pending = import('@webcontainer/api').then(({ WebContainer }) => WebContainer.boot({ coep: 'require-corp' })).then(async instance => {
    if (generation !== runtimeGeneration) {
      await instance.teardown();
      throw new DOMException('WebContainer document was disposed during boot', 'AbortError');
    }
    webContainerInstance = instance;
    return instance;
  }).catch(err => {
    if (bootPromise === pending) bootPromise = null;
    throw err;
  });
  bootPromise = pending;

  return bootPromise;
}

/**
 * Dispose of the WebContainer instance
 * Note: This should rarely be used - WebContainers persist for page lifetime
 */
export async function disposeWebContainer() {
  activePreview?.dispose();
  runtimeGeneration += 1;
  const pending = bootPromise;
  const instance = webContainerInstance;
  if (instance) {
    await instance.teardown();
    if (webContainerInstance === instance) webContainerInstance = null;
  } else if (pending) {
    await pending.catch(() => {});
  }
  if (bootPromise === pending) bootPromise = null;
  pendingProcesses.clear();
}

/**
 * Convert a flat file object to WebContainer mount format
 * @param {Object} files - Object with paths as keys and content as values
 *   e.g., { 'src/index.js': 'content...', 'package.json': '{}' }
 * @returns {Object} WebContainer file tree format
 */
export function filesToMountTree(files) {
  const tree = {};

  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split('/').filter(p => p);
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        current[part] = {
          file: {
            contents: content
          }
        };
      } else {
        if (!current[part]) {
          current[part] = { directory: {} };
        }
        current = current[part].directory;
      }
    }
  }

  return tree;
}

function normalizeMountTree(tree) {
  return Object.fromEntries(Object.entries(tree).map(([name, node]) => {
    if (node.directory) return [name, { directory: normalizeMountTree(node.directory) }];
    const contents = node.file.contents;
    return [name, { file: { ...node.file, contents: Array.isArray(contents) ? new Uint8Array(contents) : contents } }];
  }));
}

/**
 * Mount files, restoring binary transport values and optionally replacing the project.
 */
export async function mountFiles(files, { signal, replace = false, assertCurrent } = {}) {
  assertCurrent?.();
  const wc = await waitWithSignal(getWebContainer(), signal);
  signal?.throwIfAborted();
  assertCurrent?.();
  const isTreeFormat = Object.values(files).some(
    v => v && typeof v === 'object' && ('file' in v || 'directory' in v)
  );
  const tree = normalizeMountTree(isTreeFormat ? files : filesToMountTree(files));
  if (replace) {
    assertCurrent?.();
    for (const name of await wc.fs.readdir('.')) {
      signal?.throwIfAborted();
      assertCurrent?.();
      await wc.fs.rm(name, { recursive: true, force: true });
      assertCurrent?.();
    }
  }
  signal?.throwIfAborted();
  assertCurrent?.();
  await wc.mount(tree);
  signal?.throwIfAborted();
  assertCurrent?.();
}

/**
 * Write a single file to the WebContainer
 * @param {string} path - File path (e.g., 'src/App.jsx')
 * @param {string} contents - File contents
 * @returns {Promise<void>}
 */
export async function writeFile(path, contents) {
  const wc = await getWebContainer();
  await wc.fs.writeFile(path, contents);
}

/**
 * Read a file from the WebContainer
 * @param {string} path - File path
 * @returns {Promise<string>}
 */
export async function readFile(path) {
  const wc = await getWebContainer();
  return await wc.fs.readFile(path, 'utf-8');
}

/**
 * Run npm install in the WebContainer
 * @param {Function} onOutput - Callback for process output (optional)
 * @returns {Promise<number>} Exit code (0 = success)
 */
export async function installDependencies(onOutput, { signal, assertCurrent } = {}) {
  assertCurrent?.();
  await waitForProcessDrain(signal);
  assertCurrent?.();
  const wc = await waitWithSignal(getWebContainer(), signal);
  assertCurrent?.();
  const owned = await spawnOwnedProcess(wc, 'npm', ['install'], onOutput, signal, assertCurrent);
  assertCurrent?.();
  const exit = await waitWithSignal(owned.process.exit, signal);
  assertCurrent?.();
  return exit;
}

/**
 * Start a dev server and retain process ownership through readiness or cancellation.
 */
export async function startDevServer(cmd, args, onOutput, { signal, timeoutMs = 60000, assertCurrent, onExit } = {}) {
  assertCurrent?.();
  await waitForProcessDrain(signal);
  assertCurrent?.();
  const wc = await waitWithSignal(getWebContainer(), signal);
  signal?.throwIfAborted();
  assertCurrent?.();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let owned;
    let ready;
    let settled = false;
    const unsubscribe = wc.on('server-ready', (port, url) => {
      ready = { port, url };
      if (owned) succeed();
    });
    const clearStartup = () => {
      clearTimeout(timeout);
      unsubscribe();
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      clearStartup();
      signal?.removeEventListener('abort', abort);
      controller.abort();
      reject(error);
    };
    const abort = () => {
      if (!settled) fail(signal.reason || new DOMException('Cancelled', 'AbortError'));
      else {
        signal?.removeEventListener('abort', abort);
        controller.abort();
      }
    };
    const succeed = () => {
      if (settled) return;
      try { assertCurrent?.(); } catch (error) { fail(error); return; }
      settled = true;
      clearStartup();
      resolve({ ...ready, process: owned.process });
    };
    const timeout = setTimeout(() => fail(new Error(`Dev server start timed out after ${timeoutMs / 1000} seconds`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    spawnOwnedProcess(wc, cmd, args, onOutput, controller.signal, assertCurrent).then(value => {
      owned = value;
      const exited = error => {
        signal?.removeEventListener('abort', abort);
        if (!settled) fail(error);
        else if (!controller.signal.aborted) {
          controller.abort();
          onExit?.(error);
        }
      };
      owned.process.exit.then(code => {
        exited(new Error(`Dev server exited with code ${code} ${settled ? 'after' : 'before'} server-ready`));
      }, exited);
      if (ready) succeed();
    }, fail);
  });
}

/**
 * Run a command in the WebContainer
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {Function} onOutput - Callback for process output (optional)
 * @returns {Promise<number>} Exit code
 */
export async function runCommand(cmd, args, onOutput) {
  const wc = await getWebContainer();

  const process = await wc.spawn(cmd, args);

  if (onOutput) {
    process.output.pipeTo(new WritableStream({
      write(data) {
        onOutput(data);
      }
    }));
  }

  return await process.exit;
}

/**
 * Get the current WebContainer instance status
 * @returns {{booted: boolean, supported: Object}}
 */
export function getStatus() {
  return {
    booted: webContainerInstance !== null,
    supported: isWebContainerSupported()
  };
}
