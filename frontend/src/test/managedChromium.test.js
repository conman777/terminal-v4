import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedChromiumPath, managedRuntimeRoot } from './managedChromium';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function runtimeWith(manifest) {
  const root = await mkdtemp(join(tmpdir(), 'v4-managed-chromium-'));
  roots.push(root);
  if (manifest) await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest));
  return root;
}

describe('managedRuntimeRoot', () => {
  it('defaults to the checkout runtime next to the frontend', () => {
    expect(managedRuntimeRoot({}, '/work/terminal-v4/frontend')).toBe(resolve('/work/terminal-v4/.runtime/browser'));
  });
  it('honours the same override the workspace browser engine honours', () => {
    expect(managedRuntimeRoot({ TERMINAL_V4_BROWSER_RUNTIME_DIR: '/scratch/runtime' }, '/work/terminal-v4/frontend')).toBe(resolve('/scratch/runtime'));
  });
});

describe('managedChromiumPath', () => {
  it('resolves the executable named by runtime.json inside the runtime root', async () => {
    const root = await runtimeWith({ chromium: 'browsers/chromium-1/chrome' });
    await expect(managedChromiumPath({ TERMINAL_V4_BROWSER_RUNTIME_DIR: root }, '/unused')).resolves.toBe(join(root, 'browsers/chromium-1/chrome'));
  });
  it('explains how to provision the runtime when runtime.json is missing', async () => {
    const root = await runtimeWith();
    const failure = await managedChromiumPath({ TERMINAL_V4_BROWSER_RUNTIME_DIR: root }, '/unused').catch(error => error);
    expect(failure.message).toBe(`Managed Chromium runtime not found at ${root}. Run "npm run browser:install" from the repository root, or set TERMINAL_V4_BROWSER_RUNTIME_DIR to a provisioned runtime.`);
  });
  it('rejects a manifest whose executable escapes the runtime root', async () => {
    const root = await runtimeWith({ chromium: '../outside/chrome' });
    await expect(managedChromiumPath({ TERMINAL_V4_BROWSER_RUNTIME_DIR: root }, '/unused')).rejects.toThrow('outside the runtime root');
  });
  it('is usable when the directory exists but is empty of a manifest subfolder', async () => {
    const root = await runtimeWith();
    await mkdir(join(root, 'browsers'));
    await expect(managedChromiumPath({ TERMINAL_V4_BROWSER_RUNTIME_DIR: root }, '/unused')).rejects.toThrow('Managed Chromium runtime not found');
  });
});
