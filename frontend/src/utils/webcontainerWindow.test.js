import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginAuthChange, setTokens, setUser } from './auth';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { claimWebContainerLaunch, createWebContainerLaunch, getWebContainerLaunchSupport, isTrustedWebContainerUrl, isWebContainerLaunchCurrent, isWebContainerRoute, readWebContainerExport, validateWebContainerFiles } from './webcontainerWindow';

beforeEach(() => {
  localStorage.clear(); setActiveEnvironment(null);
  setTokens('synthetic-access', 'synthetic-refresh'); setUser({ id: 'synthetic-owner' });
  setEnvironmentIdentity('synthetic-owner');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_key, _options, run) => run()) } });
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/156' });
});
const project = { projectPath: '/synthetic/project', startCommand: 'npm run dev' };

describe('isolated runner launch', () => {
  it('dispatches only the exact trusted entry paths', () => {
    expect(['/webcontainer', '/webcontainer/', '/', '/webcontainer/x', '/WEBContainer', '/webcontainer.js'].map(isWebContainerRoute)).toEqual([true, true, false, false, false, false]);
  });
  it('allows launching from a nonisolated parent and serializes no tokens or source into metadata or URL', async () => {
    vi.stubGlobal('crossOriginIsolated', false);
    expect(getWebContainerLaunchSupport(project).supported).toBe(true);
    const launch = createWebContainerLaunch(project);
    expect(launch.href).toMatch(/^\/webcontainer#[a-f0-9]{32}$/);
    const stored = localStorage.getItem('terminal_webcontainer_launches_v1');
    expect(stored).not.toMatch(/synthetic-access|synthetic-refresh|contents|source/);
    const record = await claimWebContainerLaunch(launch.id);
    expect({ projectPath: record.projectPath, startCommand: record.startCommand, current: isWebContainerLaunchCurrent(record) }).toEqual({ ...project, current: true });
    await expect(claimWebContainerLaunch(launch.id)).rejects.toThrow(/consumed|missing/);
    expect(navigator.locks.request).toHaveBeenCalledWith('terminal-webcontainer-launches', { mode: 'exclusive' }, expect.any(Function));
  });
  it('claims once across concurrent windows using an exclusive lock', async () => {
    let queue = Promise.resolve();
    navigator.locks.request.mockImplementation((_key, _opts, run) => { const result = queue.then(run); queue = result.catch(() => {}); return result; });
    const launch = createWebContainerLaunch(project);
    const results = await Promise.allSettled([claimWebContainerLaunch(launch.id), claimWebContainerLaunch(launch.id)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  });
  it('rejects expired metadata, unsafe paths, remote selections and missing lock support', async () => {
    const launch = createWebContainerLaunch(project);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
    await expect(claimWebContainerLaunch(launch.id)).rejects.toThrow(/expired|missing/); now.mockRestore();
    expect(() => createWebContainerLaunch({ ...project, projectPath: 'https://example.invalid/private' })).toThrow(/project/);
    setActiveEnvironment({ id: 'synthetic-remote' });
    expect(() => createWebContainerLaunch(project)).toThrow(/paired/i);
    setActiveEnvironment(null);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(claimWebContainerLaunch(launch.id)).rejects.toThrow(/lock/i);
  });
  it('checks stored auth/session/home/environment directly before notifications arrive', async () => {
    const record = await claimWebContainerLaunch(createWebContainerLaunch(project).id);
    localStorage.setItem('terminal_access_token', 'rotated-access');
    expect(isWebContainerLaunchCurrent(record)).toBe(true);
    beginAuthChange(); expect(isWebContainerLaunchCurrent(record)).toBe(false);
    const next = await claimWebContainerLaunch(createWebContainerLaunch(project).id);
    localStorage.setItem(`identity:${encodeURIComponent(window.location.origin)}:synthetic-owner:selectedEnvironment`, 'paired');
    expect(isWebContainerLaunchCurrent(next)).toBe(false);
  });
  it('bounds retained launch records and removes expired metadata', async () => {
    for (let i = 0; i < 8; i++) await createWebContainerLaunch(project).ready;
    await expect(createWebContainerLaunch(project).ready).rejects.toThrow(/many|limit/i);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
    await createWebContainerLaunch(project).ready;
    expect(Object.keys(JSON.parse(localStorage.getItem('terminal_webcontainer_launches_v1')))).toHaveLength(1);
    now.mockRestore();
  });
});

describe('untrusted project boundary', () => {
  it('accepts only a distinct HTTPS WebContainer project origin', () => {
    expect(['https://fixture.local-corp.webcontainer-api.io', 'https://local-corp.webcontainer-api.io', 'https://fixture.local-corp.webcontainer-api.io.evil.invalid', window.location.origin, 'javascript:alert(1)', 'data:text/html,source', 'http://fixture.local-corp.webcontainer-api.io', 'https://user:secret@fixture.local-corp.webcontainer-api.io'].map(isTrustedWebContainerUrl)).toEqual([true, false, false, false, false, false, false, false]);
  });
  it('validates binary trees and rejects traversal, invalid byte data and oversize entries', () => {
    const tree = { 'package.json': { file: { contents: '{}' } }, public: { directory: { 'asset.png': { file: { contents: [0, 127, 128, 255] } } } } };
    expect(validateWebContainerFiles(tree)).toBe(tree);
    for (const bad of [JSON.parse('{"__proto__":{"file":{"contents":"x"}}}'), { '../bad': { file: { contents: 'x' } } }, { img: { file: { contents: [256] } } }, { huge: { file: { contents: 'x'.repeat(1024 * 1024 + 1) } } }]) {
      expect(() => validateWebContainerFiles(bad)).toThrow();
    }
  });
});

describe('launch storage interleaving', () => {
  it('does not revive a consumed A when creating B interleaves with its claim', async () => {
    const first = createWebContainerLaunch(project); await first.ready;
    let held = false; const queue = [];
    navigator.locks.request.mockImplementation((_key, _opts, callback) => new Promise((resolve, reject) => {
      const run = () => { held = true; try { resolve(callback()); } catch (error) { reject(error); } finally { held = false; queue.shift()?.(); } };
      if (held) queue.push(run); else run();
    }));
    const original = Storage.prototype.getItem;
    let claim; let intercept = true;
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
      const snapshot = original.call(this, key);
      if (key === 'terminal_webcontainer_launches_v1' && intercept) {
        intercept = false;
        claim = claimWebContainerLaunch(first.id);
      }
      return snapshot;
    });
    try {
      const second = createWebContainerLaunch(project); await second.ready; await claim;
      await expect(claimWebContainerLaunch(first.id)).rejects.toThrow(/consumed|missing/);
      expect((await claimWebContainerLaunch(second.id)).projectPath).toBe(project.projectPath);
    } finally { read.mockRestore(); }
  });
});


describe('bounded decoded export response', () => {
  it('counts decoded stream bytes before JSON.parse and cancels an over-budget body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); controller.enqueue(new Uint8Array(9)); }, cancel });
    const headers = new Headers();
    // This body is deliberately invalid JSON: an export-budget error proves parsing did not run first.
    const failure = await readWebContainerExport({ body, headers }, { maxBytes: 16 }).catch(error => error);
    expect(failure.message).toMatch(/export.*limit|budget/i);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects a declared over-budget body before reading it', async () => {
    const getReader = vi.fn();
    await expect(readWebContainerExport({ body: { getReader }, headers: new Headers({ 'Content-Length': '100' }) }, { maxBytes: 16 })).rejects.toThrow(/export.*limit|budget/i);
    expect(getReader).not.toHaveBeenCalled();
  });
  it('preserves binary JSON arrays through a bounded UTF8 stream', async () => {
    const exported = { files: { 'package.json': { file: { contents: '{}' } }, image: { file: { contents: [0, 127, 128, 255] } } } };
    const checks = vi.fn();
    const response = new Response(JSON.stringify(exported));
    expect(await readWebContainerExport(response, { assertCurrent: checks })).toEqual(exported);
    expect(checks.mock.calls.length).toBeGreaterThan(2);
  });
});
