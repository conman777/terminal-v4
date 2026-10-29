import { readFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep } from 'node:path';

export function managedRuntimeRoot(env = process.env, cwd = process.cwd()) {
  return env.TERMINAL_V4_BROWSER_RUNTIME_DIR ? resolve(env.TERMINAL_V4_BROWSER_RUNTIME_DIR) : resolve(cwd, '../.runtime/browser');
}

export async function managedChromiumPath(env = process.env, cwd = process.cwd()) {
  const root = managedRuntimeRoot(env, cwd);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(root, 'runtime.json'), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Managed Chromium runtime not found at ${root}. Run "npm run browser:install" from the repository root, or set TERMINAL_V4_BROWSER_RUNTIME_DIR to a provisioned runtime.`);
    throw error;
  }
  const executable = resolve(root, manifest.chromium);
  const within = relative(root, executable);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Managed Chromium executable points outside the runtime root.');
  return executable;
}

export async function launchManagedChromium(playwright, options = {}) {
  return playwright.chromium.launch({ executablePath: await managedChromiumPath(), headless: true, ...options });
}
