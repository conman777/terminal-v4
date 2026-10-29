import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ boot: vi.fn() }));
vi.mock('@webcontainer/api', () => ({ WebContainer: { boot: runtime.boot } }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../utils/api';
import { disposeWebContainer } from '../utils/webcontainer';
import { WebContainerPreview } from './WebContainerPreview';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
function processFixture() {
  const exit = deferred(); const cancel = vi.fn();
  return { exit, cancel, process: { kill: vi.fn(() => exit.resolve(143)), exit: exit.promise, output: new ReadableStream({ cancel }) } };
}
let wc, listeners, processes;
const filesA = { 'package.json': '{}', 'a.js': 'project a' };
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crossOriginIsolated', true);
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/130' });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  listeners = new Set(); processes = [];
  wc = { teardown: vi.fn(), mount: vi.fn(), fs: { readdir: vi.fn().mockResolvedValue([]), rm: vi.fn() }, on: vi.fn((_event, fn) => { listeners.add(fn); return () => listeners.delete(fn); }), spawn: vi.fn(async (_cmd, args) => {
    const fixture = processFixture(); processes.push(fixture);
    if (args[0] === 'install') fixture.exit.resolve(0);
    return fixture.process;
  }) };
  runtime.boot.mockReset().mockResolvedValue(wc);
  apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ files: filesA }) });
});
afterEach(async () => { cleanup(); await flush(); await disposeWebContainer(); });
const ready = async (suffix = '') => act(async () => { for (const fn of [...listeners]) fn(5173, `https://fixture${suffix}.local-corp.webcontainer-api.io`); });

describe('WebContainerPreview initialization ownership', () => {
  it('reloads projectPath and startCommand on the retained component and stops the old process', async () => {
    const onServerReady = vi.fn();
    const view = render(<WebContainerPreview projectPath="/synthetic/a" onServerReady={onServerReady} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2)); await ready();
    view.rerender(<WebContainerPreview projectPath="/synthetic/b" startCommand="npm run serve" onServerReady={onServerReady} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4)); await ready('b');
    expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/webcontainer/files?path=%2Fsynthetic%2Fa', '/api/webcontainer/files?path=%2Fsynthetic%2Fb']);
    expect(wc.spawn.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([['npm', ['install']], ['npm', ['run', 'dev']], ['npm', ['install']], ['npm', ['run', 'serve']]]);
    expect(processes[1].process.kill).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('WebContainer Preview').getAttribute('src')).toBe('https://fixtureb.local-corp.webcontainer-api.io');
  });
  it('remounts changed projectFiles but callback identity changes do not restart', async () => {
    const view = render(<WebContainerPreview projectFiles={filesA} onServerReady={() => {}} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2)); await ready();
    view.rerender(<WebContainerPreview projectFiles={filesA} onServerReady={() => {}} />); await flush();
    expect(wc.spawn).toHaveBeenCalledTimes(2);
    const filesB = { 'package.json': '{}', 'b.js': 'project b' };
    view.rerender(<WebContainerPreview projectFiles={filesB} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4)); await ready('b');
    expect(wc.mount.mock.calls[1][0]).toEqual({ 'package.json': { file: { contents: '{}' } }, 'b.js': { file: { contents: 'project b' } } });
  });
  it('does no project work when boot resolves after unmount', async () => {
    const boot = deferred(); runtime.boot.mockReturnValue(boot.promise);
    const view = render(<WebContainerPreview projectFiles={filesA} />);
    await flush(); view.unmount(); boot.resolve(wc); await flush();
    expect([wc.mount.mock.calls.length, wc.spawn.mock.calls.length]).toEqual([0, 0]);
  });
  it('kills pending installation on unmount and never starts a server', async () => {
    const install = processFixture(); wc.spawn.mockResolvedValue(install.process);
    const view = render(<WebContainerPreview projectFiles={filesA} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(1)); view.unmount(); await flush();
    install.exit.resolve(0); await flush();
    expect([install.process.kill.mock.calls.length, install.cancel.mock.calls.length, wc.spawn.mock.calls.length]).toEqual([1, 1, 1]);
  });
  it('kills pending server startup on unmount and suppresses late callbacks', async () => {
    const onServerReady = vi.fn(); const onError = vi.fn();
    const view = render(<WebContainerPreview projectFiles={filesA} onServerReady={onServerReady} onError={onError} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2)); view.unmount(); await flush(); await ready();
    expect([processes[1].process.kill.mock.calls.length, listeners.size, onServerReady.mock.calls.length, onError.mock.calls.length]).toEqual([1, 0, 0, 0]);
  });
  it('a superseded preview cleanup cannot kill the newer singleton owner', async () => {
    const firstReady = vi.fn(); const secondReady = vi.fn();
    const first = render(<WebContainerPreview projectFiles={filesA} onServerReady={firstReady} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
    const second = render(<WebContainerPreview projectFiles={{ 'package.json': '{}' }} onServerReady={secondReady} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4));
    first.unmount(); await ready('new');
    expect([processes[1].process.kill.mock.calls.length, processes[3].process.kill.mock.calls.length, firstReady.mock.calls.length, secondReady.mock.calls.length]).toEqual([1, 0, 0, 1]);
    second.unmount(); await flush(); expect(processes[3].process.kill).toHaveBeenCalledTimes(1);
    expect(runtime.boot).toHaveBeenCalledTimes(1);
  });
  it('serializes a pending old mount before mounting the replacement project', async () => {
    const mount = deferred(); wc.mount.mockReturnValueOnce(mount.promise);
    const view = render(<WebContainerPreview projectFiles={filesA} />);
    await waitFor(() => expect(wc.mount).toHaveBeenCalledTimes(1));
    view.rerender(<WebContainerPreview projectFiles={{ 'package.json': '{}', 'b.js': 'b' }} />);
    await flush(); expect(wc.mount).toHaveBeenCalledTimes(1);
    mount.resolve();
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
    expect(wc.mount).toHaveBeenCalledTimes(2);
    await ready('b');
    expect(screen.getByTitle('WebContainer Preview').getAttribute('src')).toBe('https://fixtureb.local-corp.webcontainer-api.io');
  });
  it('aborts the old file fetch and ignores its late result when the path changes', async () => {
    const fetch = deferred(); apiFetch.mockReturnValueOnce(fetch.promise);
    const view = render(<WebContainerPreview projectPath="/synthetic/a" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const signal = apiFetch.mock.calls[0][1].signal;
    view.rerender(<WebContainerPreview projectPath="/synthetic/b" />);
    expect(signal.aborted).toBe(true);
    fetch.resolve({ ok: true, json: async () => ({ files: { 'stale.js': 'old' } }) });
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
    expect(wc.mount).toHaveBeenCalledTimes(1);
    expect(wc.mount.mock.calls[0][0]['stale.js']).toBeUndefined();
  });
  it('reports successful early exit as an error and retries without reloading the page', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<WebContainerPreview projectFiles={filesA} />);
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
      await act(async () => processes[1].exit.resolve(0));
      expect(await screen.findByText('Dev server exited with code 0 before server-ready', { selector: 'p' })).toBeInTheDocument();
      fireEvent.click(screen.getByText('Retry'));
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4)); await ready();
      expect(screen.getByTitle('WebContainer Preview')).toBeInTheDocument();
      expect(runtime.boot).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); }
  });

  it.each([0, 7])('clears a ready iframe after unexpected exit %s and retries with a new server', async code => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}), onError = vi.fn();
    try {
      render(<WebContainerPreview projectFiles={filesA} onError={onError} />);
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2)); await ready();
      expect(screen.getByTitle('WebContainer Preview')).toBeInTheDocument();
      await act(async () => processes[1].exit.resolve(code));
      expect(screen.queryByTitle('WebContainer Preview')).not.toBeInTheDocument();
      expect(screen.getByText(`Dev server exited with code ${code} after server-ready`, { selector: 'p' })).toBeInTheDocument();
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: `Dev server exited with code ${code} after server-ready` }), 'dev server');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4)); await ready('retry');
      expect(screen.getByTitle('WebContainer Preview')).toHaveAttribute('src', 'https://fixtureretry.local-corp.webcontainer-api.io');
    } finally { error.mockRestore(); }
  });
  it.each(['replacement', 'unmount', 'owner change'])('ignores a ready server exit after %s', async action => {
    let current = true;
    const onError = vi.fn();
    const view = render(<WebContainerPreview projectFiles={filesA} onError={onError} isScopeCurrent={() => current} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2)); await ready();
    const previous = processes[1]; previous.process.kill.mockImplementation(() => {});
    if (action === 'replacement') view.rerender(<WebContainerPreview projectFiles={{ 'package.json': '{}', 'new.js': 'new' }} onError={onError} />);
    else if (action === 'unmount') view.unmount();
    else current = false;
    await act(async () => previous.exit.resolve(7));
    expect(onError).not.toHaveBeenCalled();
    if (action === 'replacement') {
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4)); await ready('replacement');
      expect(screen.getByTitle('WebContainer Preview')).toHaveAttribute('src', 'https://fixturereplacement.local-corp.webcontainer-api.io');
      expect(processes[3].process.kill).not.toHaveBeenCalled();
    }
  });

  it('drains canceled raw spawn and confirmed termination before replacement can consume global readiness', async () => {
    const spawn = deferred(); const ownSpawn = deferred();
    const old = processFixture(); const current = processFixture();
    old.process.kill.mockImplementation(() => {});
    const installA = processFixture(); const installB = processFixture();
    installA.exit.resolve(0); installB.exit.resolve(0);
    wc.spawn.mockResolvedValueOnce(installA.process).mockReturnValueOnce(spawn.promise)
      .mockResolvedValueOnce(installB.process).mockReturnValueOnce(ownSpawn.promise);
    const oldReady = vi.fn(); const currentReady = vi.fn();
    const view = render(<WebContainerPreview projectPath="/synthetic/a" onServerReady={oldReady} />);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
    view.rerender(<WebContainerPreview projectPath="/synthetic/b" onServerReady={currentReady} />);
    await flush();
    expect([wc.spawn.mock.calls.length, listeners.size]).toEqual([2, 0]);
    await ready('old-before-handle');
    spawn.resolve(old.process); await flush();
    expect(old.process.kill).toHaveBeenCalledTimes(1);
    await ready('old-after-kill');
    expect({ spawns: wc.spawn.mock.calls.length, listeners: listeners.size, ready: currentReady.mock.calls, iframe: screen.queryByTitle('WebContainer Preview') }).toEqual({ spawns: 2, listeners: 0, ready: [], iframe: null });
    old.exit.resolve(143);
    await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(4));
    await ready('own-before-handle'); ownSpawn.resolve(current.process); await flush();
    expect({ oldReady: oldReady.mock.calls, currentReady: currentReady.mock.calls, iframe: screen.getByTitle('WebContainer Preview').getAttribute('src') }).toEqual({ oldReady: [], currentReady: [['https://fixtureown-before-handle.local-corp.webcontainer-api.io', 5173]], iframe: 'https://fixtureown-before-handle.local-corp.webcontainer-api.io' });
    view.unmount(); current.exit.resolve(143);
  });

  it('shows a bounded cleanup error and retries after a canceled spawn is confirmed stopped', async () => {
    const spawn = deferred(); const old = processFixture();
    old.process.kill.mockImplementation(() => {});
    const install = processFixture(); install.exit.resolve(0);
    wc.spawn.mockResolvedValueOnce(install.process).mockReturnValueOnce(spawn.promise);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const view = render(<WebContainerPreview projectPath="/synthetic/a" />);
      await waitFor(() => expect(wc.spawn).toHaveBeenCalledTimes(2));
      vi.useFakeTimers();
      view.rerender(<WebContainerPreview projectPath="/synthetic/b" />);
      await flush();
      await act(async () => vi.advanceTimersByTimeAsync(10_001));
      expect(screen.getByRole('heading', { name: 'WebContainer Error' })).toBeInTheDocument();
      expect(screen.getByText(/Previous WebContainer process is still stopping/, { selector: 'p' })).toBeInTheDocument();
      expect(wc.spawn).toHaveBeenCalledTimes(2);
      spawn.resolve(old.process); await flush();
      expect(old.process.kill).toHaveBeenCalledTimes(1);
      old.exit.resolve(143); await flush();
      fireEvent.click(screen.getByText('Retry')); await flush();
      expect(wc.spawn).toHaveBeenCalledTimes(4);
      await ready('after-retry');
      expect(screen.getByTitle('WebContainer Preview').getAttribute('src')).toBe('https://fixtureafter-retry.local-corp.webcontainer-api.io');
    } finally { vi.useRealTimers(); error.mockRestore(); }
  });

  it('checks the stored owner directly after boot before mounting, even without a notification', async () => {
    const boot = deferred(); runtime.boot.mockReturnValueOnce(boot.promise);
    let current = true;
    const view = render(<WebContainerPreview projectFiles={filesA} isScopeCurrent={() => current} />);
    await flush(); current = false; boot.resolve(wc); await flush();
    expect([wc.mount.mock.calls.length, wc.spawn.mock.calls.length]).toEqual([0, 0]);
    view.unmount();
  });

});
