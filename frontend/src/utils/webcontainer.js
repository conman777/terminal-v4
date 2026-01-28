/**
 * WebContainer Utility Module
 *
 * Provides lifecycle management for WebContainers - a browser-based Node.js runtime.
 * WebContainers run dev servers directly in the browser via WebAssembly,
 * eliminating URL rewriting issues and providing reliable HMR.
 */

import { WebContainer } from '@webcontainer/api';

// Singleton instance - WebContainer only allows one instance per page
let webContainerInstance = null;
let bootPromise = null;

/**
 * Check if WebContainers are supported in the current browser
 * WebContainers with coep: 'none' only work in Chromium browsers
 * due to reliance on Chrome's Origin Trial for SharedArrayBuffer
 */
export function isWebContainerSupported() {
  // WebContainers with coep: 'none' only works in Chromium browsers
  // due to reliance on Origin Trial for SharedArrayBuffer
  const userAgent = navigator.userAgent;
  const isChromium = /Chrome|Chromium|Edg/.test(userAgent) &&
                     !/Firefox/.test(userAgent) &&
                     // Safari includes "Safari" but not "Chrome", while Chrome includes both
                     !(/Safari/.test(userAgent) && !/Chrome/.test(userAgent));

  if (!isChromium) {
    return { supported: false, reason: 'WebContainers require a Chromium-based browser (Chrome, Edge). Use proxy preview in other browsers.' };
  }

  // Check for SharedArrayBuffer support
  if (typeof SharedArrayBuffer === 'undefined') {
    return { supported: false, reason: 'SharedArrayBuffer not available in this browser.' };
  }

  // Check for basic required APIs
  if (typeof WebAssembly === 'undefined') {
    return { supported: false, reason: 'WebAssembly not supported in this browser.' };
  }

  // Check for service worker support (used by WebContainers)
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'Service Workers not supported in this browser.' };
  }

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

  // Start booting with coep: 'none' to avoid requiring COEP headers
  // This relies on Chrome's Origin Trial for SharedArrayBuffer
  bootPromise = WebContainer.boot({ coep: 'none' }).then(instance => {
    webContainerInstance = instance;
    return instance;
  }).catch(err => {
    bootPromise = null;
    throw err;
  });

  return bootPromise;
}

/**
 * Dispose of the WebContainer instance
 * Note: This should rarely be used - WebContainers persist for page lifetime
 */
export async function disposeWebContainer() {
  if (webContainerInstance) {
    await webContainerInstance.teardown();
    webContainerInstance = null;
    bootPromise = null;
  }
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

/**
 * Mount a file tree to the WebContainer
 * @param {Object} files - Either flat file object or WebContainer tree format
 * @returns {Promise<void>}
 */
export async function mountFiles(files) {
  const wc = await getWebContainer();

  // Check if already in tree format or flat format
  const isTreeFormat = Object.values(files).some(
    v => v && typeof v === 'object' && ('file' in v || 'directory' in v)
  );

  const tree = isTreeFormat ? files : filesToMountTree(files);
  await wc.mount(tree);
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
export async function installDependencies(onOutput) {
  const wc = await getWebContainer();

  const installProcess = await wc.spawn('npm', ['install']);

  if (onOutput) {
    installProcess.output.pipeTo(new WritableStream({
      write(data) {
        onOutput(data);
      }
    }));
  }

  const exitCode = await installProcess.exit;
  return exitCode;
}

/**
 * Start a dev server in the WebContainer
 * @param {string} cmd - Command to run (e.g., 'npm')
 * @param {string[]} args - Command arguments (e.g., ['run', 'dev'])
 * @param {Function} onOutput - Callback for process output (optional)
 * @returns {Promise<{url: string, port: number, process: object}>}
 */
export async function startDevServer(cmd, args, onOutput) {
  const wc = await getWebContainer();

  const serverProcess = await wc.spawn(cmd, args);

  if (onOutput) {
    serverProcess.output.pipeTo(new WritableStream({
      write(data) {
        onOutput(data);
      }
    }));
  }

  // Wait for the server to be ready
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Dev server start timed out after 60 seconds'));
    }, 60000);

    wc.on('server-ready', (port, url) => {
      clearTimeout(timeout);
      resolve({ url, port, process: serverProcess });
    });

    // Also handle process exit
    serverProcess.exit.then(code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
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
