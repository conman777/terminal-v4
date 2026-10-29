import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ boot: vi.fn() }));
vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: runtime.boot } }));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function processFixture() {
  const exit = deferred();
  const cancel = vi.fn();
  const output = new ReadableStream({ cancel });
  return { exit, cancel, process: { exit: exit.promise, kill: vi.fn(), output } };
}
let wc, listeners, api;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crossOriginIsolated', true);
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/156' });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  listeners = new Set();
  wc = { teardown: vi.fn(), spawn: vi.fn(), mount: vi.fn(), fs: { readdir: vi.fn().mockResolvedValue([]), rm: vi.fn() }, on: vi.fn((_event, listener) => { listeners.add(listener); return () => listeners.delete(listener); }) };
  runtime.boot.mockReset().mockResolvedValue(wc);
  api = await import('./webcontainer');
  await api.getWebContainer();
});
afterEach(() => vi.useRealTimers());
const ready = () => { for (const listener of [...listeners]) listener(5173, 'http://fixture.local'); };

describe('mountFiles', () => {
  it('converts JSON binary arrays to Uint8Array throughout the exported tree', async () => {
    await api.mountFiles({ public: { directory: { 'image.png': { file: { contents: [0, 255, 128] } } } }, 'logo.svg': { file: { contents: '<svg/>' } } });
    expect(wc.mount).toHaveBeenCalledWith({ public: { directory: { 'image.png': { file: { contents: new Uint8Array([0, 255, 128]) } } } }, 'logo.svg': { file: { contents: '<svg/>' } } });
  });
  it('replaces old root files before mounting a new project', async () => {
    wc.fs.readdir.mockResolvedValue(['old.js', 'node_modules']);
    await api.mountFiles({ 'new.js': 'new' }, { replace: true });
    expect(wc.fs.readdir).toHaveBeenCalledWith('.');
    expect(wc.fs.rm.mock.calls).toEqual([['old.js', { recursive: true, force: true }], ['node_modules', { recursive: true, force: true }]]);
  });
});

describe('startDevServer', () => {
  it.each([0, 7])('rejects exit %s before ready and removes the listener', async code => {
    vi.useFakeTimers();
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const start = api.startDevServer('npm', ['run', 'dev'], vi.fn());
    const outcome = start.then(() => 'unexpected ready', error => error.message);
    await flush(); fixture.exit.resolve(code); await flush();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await Promise.race([outcome, Promise.resolve('still pending')])).toMatch(new RegExp(`exited.*${code}`));
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await flush(); expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });
  it('times out, kills the process and detaches output and ready listeners', async () => {
    vi.useFakeTimers();
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const outcome = api.startDevServer('npm', ['run', 'dev'], vi.fn()).catch(error => error.message);
    await flush(); await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatch(/timed out/);
    expect([fixture.process.kill.mock.calls.length, listeners.size, fixture.cancel.mock.calls.length]).toEqual([1, 0, 1]);
  });
  it('returns normal readiness, then abort kills only its own server and pipe', async () => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const controller = new AbortController();
    const start = api.startDevServer('npm', ['run', 'dev'], vi.fn(), { signal: controller.signal });
    await flush(); ready();
    expect(await start).toEqual({ url: 'http://fixture.local', port: 5173, process: fixture.process });
    expect(listeners.size).toBe(0);
    controller.abort(); await flush();
    expect([fixture.process.kill.mock.calls.length, fixture.cancel.mock.calls.length]).toEqual([1, 1]);
  });
  it.each([0, 7])('reports exit %s after readiness through the owned process observer', async code => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const onExit = vi.fn();
    const start = api.startDevServer('npm', ['run', 'dev'], vi.fn(), { onExit });
    await flush(); ready(); await start;
    expect(onExit).not.toHaveBeenCalled();
    fixture.exit.resolve(code); await flush();
    expect(onExit.mock.calls.map(([error]) => error.message)).toEqual([`Dev server exited with code ${code} after server-ready`]);
    expect([listeners.size, fixture.cancel.mock.calls.length]).toEqual([0, 1]);
  });
  it('suppresses post-ready exit notification when its session was canceled', async () => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const controller = new AbortController(), onExit = vi.fn();
    const start = api.startDevServer('npm', [], vi.fn(), { signal: controller.signal, onExit });
    await flush(); ready(); await start;
    controller.abort(); fixture.exit.resolve(143); await flush();
    expect([onExit.mock.calls.length, fixture.process.kill.mock.calls.length]).toEqual([0, 1]);
  });
  it('reports a rejected exit observation after readiness', async () => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const onExit = vi.fn(), failure = new Error('Server exit observation failed');
    const start = api.startDevServer('npm', [], vi.fn(), { onExit });
    await flush(); ready(); await start;
    fixture.exit.reject(failure); await flush();
    expect(onExit).toHaveBeenCalledExactlyOnceWith(failure);
  });
  it('cancels while spawn is pending and kills its late process', async () => {
    const spawn = deferred(); const fixture = processFixture(); wc.spawn.mockReturnValue(spawn.promise);
    const controller = new AbortController();
    const outcome = api.startDevServer('npm', [], vi.fn(), { signal: controller.signal }).catch(error => error.name);
    await flush(); controller.abort(); await flush();
    expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('AbortError');
    spawn.resolve(fixture.process); await flush();
    expect(fixture.process.kill).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
  it('captures readiness emitted before the spawn promise returns', async () => {
    const fixture = processFixture();
    wc.spawn.mockImplementation(async () => { ready(); return fixture.process; });
    const start = api.startDevServer('npm', [], vi.fn());
    await flush();
    expect(await Promise.race([start, Promise.resolve('still pending')])).toEqual({ url: 'http://fixture.local', port: 5173, process: fixture.process });
  });
  it('settles timeout during pending spawn and kills the late process', async () => {
    vi.useFakeTimers();
    const spawn = deferred(); const fixture = processFixture(); wc.spawn.mockReturnValue(spawn.promise);
    const outcome = api.startDevServer('npm', [], vi.fn()).catch(error => error.message);
    await flush(); await vi.advanceTimersByTimeAsync(60_001);
    expect(await outcome).toMatch(/timed out/);
    expect(listeners.size).toBe(0);
    spawn.resolve(fixture.process); await flush();
    expect(fixture.process.kill).toHaveBeenCalledTimes(1);
  });
  it('removes the ready subscription when spawn rejects', async () => {
    wc.spawn.mockRejectedValue(new Error('cannot spawn'));
    await expect(api.startDevServer('npm', [], vi.fn())).rejects.toThrow('cannot spawn');
    expect(listeners.size).toBe(0);
  });

  it('does not release ownership when process termination cannot be confirmed', async () => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const start = api.startDevServer('npm', [], vi.fn()).catch(error => error.message);
    await flush(); fixture.exit.reject(new Error('lost exit confirmation')); await flush();
    expect(await start).toBe('lost exit confirmation');
    await expect(api.startDevServer('npm', ['run', 'next'])).rejects.toThrow(/termination could not be confirmed/);
    expect([wc.spawn.mock.calls.length, listeners.size]).toEqual([1, 0]);
  });

});

describe('installDependencies', () => {
  it('aborts an install and detaches its output pipe', async () => {
    const fixture = processFixture(); wc.spawn.mockResolvedValue(fixture.process);
    const controller = new AbortController();
    const outcome = api.installDependencies(vi.fn(), { signal: controller.signal }).catch(error => error.name);
    await flush(); controller.abort(); await flush();
    expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('AbortError');
    expect([fixture.process.kill.mock.calls.length, fixture.cancel.mock.calls.length]).toEqual([1, 1]);
  });
  it('waits for a canceled raw install spawn and its termination before a replacement server subscribes', async () => {
    const spawn = deferred(); const old = processFixture(); const next = processFixture();
    wc.spawn.mockReturnValueOnce(spawn.promise).mockResolvedValueOnce(next.process);
    const controller = new AbortController();
    const install = api.installDependencies(vi.fn(), { signal: controller.signal }).catch(error => error.name);
    await flush(); controller.abort(); await flush();
    expect(await install).toBe('AbortError');
    const replacementController = new AbortController();
    let result = 'pending';
    const replacement = api.startDevServer('npm', ['run', 'next'], vi.fn(), { signal: replacementController.signal }).then(value => { result = value.url; }, error => { result = error.name; });
    await flush();
    expect([wc.spawn.mock.calls.length, listeners.size]).toEqual([1, 0]);
    spawn.resolve(old.process); await flush();
    expect(old.process.kill).toHaveBeenCalledTimes(1);
    ready(); await flush();
    expect([wc.spawn.mock.calls.length, listeners.size, result]).toEqual([1, 0, 'pending']);
    old.exit.resolve(143); await flush();
    expect(wc.spawn).toHaveBeenCalledTimes(2);
    ready(); await replacement;
    expect(result).toBe('http://fixture.local');
    replacementController.abort(); next.exit.resolve(143);
  });
  it('fails a blocked drain within a bounded wait and permits retry only after the old process exits', async () => {
    vi.useFakeTimers();
    const spawn = deferred(); const old = processFixture(); const next = processFixture();
    wc.spawn.mockReturnValueOnce(spawn.promise).mockResolvedValueOnce(next.process);
    const controller = new AbortController();
    const first = api.startDevServer('npm', ['run', 'old'], vi.fn(), { signal: controller.signal }).catch(error => error.name);
    await flush(); controller.abort(); await first;
    const blocked = api.startDevServer('npm', ['run', 'next'], vi.fn()).catch(error => error.message);
    await flush(); await vi.advanceTimersByTimeAsync(10_001);
    expect(await Promise.race([blocked, Promise.resolve('still pending')])).toMatch(/previous.*process.*stopping.*retry/i);
    expect([wc.spawn.mock.calls.length, listeners.size]).toEqual([1, 0]);
    const blockedAgain = api.startDevServer('npm', ['run', 'next'], vi.fn()).catch(error => error.message);
    await flush(); await vi.advanceTimersByTimeAsync(10_001);
    expect(await blockedAgain).toMatch(/previous.*process.*stopping.*retry/i);
    spawn.resolve(old.process); await flush();
    expect(old.process.kill).toHaveBeenCalledTimes(1);
    old.exit.resolve(143); await flush();
    const retryController = new AbortController();
    const retry = api.startDevServer('npm', ['run', 'next'], vi.fn(), { signal: retryController.signal });
    await flush(); ready();
    expect((await retry).process).toBe(next.process);
    retryController.abort(); next.exit.resolve(143);
    await flush(); expect(vi.getTimerCount()).toBe(0);
  });

});


describe('isolated document runtime ownership', () => {
  it('boots only with matching require-corp policy', () => {
    expect(runtime.boot).toHaveBeenCalledWith({ coep: 'require-corp' });
  });
  it('rejects a nonisolated document honestly without bypassing the SAB requirement', () => {
    vi.stubGlobal('crossOriginIsolated', false);
    expect(api.isWebContainerSupported()).toEqual({ supported: false, reason: expect.stringMatching(/isolat|header/i) });
  });
  it('tears down a boot that resolves after explicit document disposal', async () => {
    await api.disposeWebContainer();
    const boot = deferred(); runtime.boot.mockReturnValueOnce(boot.promise);
    const pending = api.getWebContainer().catch(error => error.name);
    await flush(); const disposal = api.disposeWebContainer();
    boot.resolve(wc); await disposal; await flush();
    expect([await pending, wc.teardown.mock.calls.length, api.getStatus().booted]).toEqual(['AbortError', 2, false]);
  });
});
