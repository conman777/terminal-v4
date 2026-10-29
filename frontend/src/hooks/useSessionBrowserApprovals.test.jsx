import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionBrowserApprovals } from './useSessionBrowserApprovals';
import { setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';

const ports = vi.hoisted(() => ({ apiFetch: vi.fn(), home: 'https://home.test/' }));
vi.mock('../utils/api', () => ({ apiFetch: ports.apiFetch }));
vi.mock('../utils/apiBase', () => ({ resolveHomeApiUrl: path => ports.home + path.replace(/^\//, '') }));
const SID = 'native-session';
const row = (changes = {}) => ({ id: 'broker-request', label: `codex:${SID}:nonce`, name: 'browser_tabs', arguments: {}, target: { url: 'https://fixture.test/page' }, ...changes });
const initial = { sessionId: SID, enabled: true, canDecide: true };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const posts = () => ports.apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const poll = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(900); }); };
const mount = (options = initial) => renderHook(props => useSessionBrowserApprovals(props), { initialProps: options });
let requests, handlePost, handleGet;

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); ports.home = 'https://home.test/';
  setUser({ id: 'account-a' }); setEnvironmentIdentity('account-a', ports.home); setActiveEnvironment(null);
  requests = [row()];
  handlePost = async () => response(null, 204);
  handleGet = async () => response({ requests });
  ports.apiFetch.mockReset();
  ports.apiFetch.mockImplementation((url, options = {}) => options.method === 'POST' ? handlePost(url, options) : handleGet(url, options));
});
afterEach(() => { vi.useRealTimers(); setEnvironmentIdentity(null); setActiveEnvironment(null); localStorage.clear(); });

describe('useSessionBrowserApprovals session and authority', () => {
  it('polls the home broker every 900ms and exposes only exact colon-delimited sessions and known providers', async () => {
    requests = [row(), row({ id: 'claude-request', label: `claude:${SID}:other-nonce` }),
      ...[`codex:${SID}-other:nonce`, `codex:prefix-${SID}:nonce`, `unknown:${SID}:nonce`, `codex:other:nonce`, `codex:${SID}:`, `codex:${SID}:nonce:extra`, `codex:${SID}`].map((label, index) => row({ id: `foreign-${index}`, label }))];
    const hook = mount(); await flush();
    expect(hook.result.current.requests).toEqual(requests.slice(0, 2));
    expect(ports.apiFetch.mock.calls[0]).toEqual(['/api/workspace-browser/approvals', expect.objectContaining({ home: true, cache: 'no-store', signal: expect.any(AbortSignal) })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(899); });
    expect(ports.apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(ports.apiFetch).toHaveBeenCalledTimes(2); expect(posts()).toEqual([]);
  });

  it.each([{ ...initial, enabled: false }, { ...initial, sessionId: null }, { sessionId: SID }])('does not read or decide without explicit enablement and a session: %j', async options => {
    const hook = mount(options); await flush();
    await act(async () => { await hook.result.current.decide(row().id, true); });
    expect(hook.result.current.requests).toEqual([]); expect(ports.apiFetch).not.toHaveBeenCalled();
  });

  it('keeps read-only requests visible but blocks decisions unless canDecide is explicitly true', async () => {
    const hook = mount({ sessionId: SID, enabled: true }); await flush();
    expect(hook.result.current.requests).toEqual([row()]);
    await act(async () => { await hook.result.current.decide(row().id, true); });
    expect(posts()).toEqual([]);
    hook.rerender({ ...initial, canDecide: false });
    expect(hook.result.current.requests).toEqual([row()]);
  });

  it.each([true, false])('posts only the exact pending ID and boolean decision %s, and does not parse a 204', async approved => {
    const json = vi.fn(() => { throw new Error('No content'); });
    handlePost = async () => ({ ok: true, status: 204, json });
    requests = [row({ id: 'exact/id' }), row({ id: 'other-id' })];
    const hook = mount(); await flush();
    await act(async () => { await hook.result.current.decide('missing-id', approved); await hook.result.current.decide('exact/id', 'true'); });
    expect(posts()).toEqual([]);
    await act(async () => { await hook.result.current.decide('exact/id', approved); });
    expect(posts()).toEqual([['/api/workspace-browser/approvals/exact%2Fid', expect.objectContaining({ home: true, method: 'POST', body: { approved }, signal: expect.any(AbortSignal) })]]);
    expect(json).not.toHaveBeenCalled(); expect(hook.result.current.requests).toEqual([requests[1]]);
    await poll(); expect(hook.result.current.requests).toEqual([requests[1]]);
  });

  it('single-flights synchronous decisions for different rows without approving anything on mount', async () => {
    const held = pending(); handlePost = () => held.promise;
    requests = [row(), row({ id: 'parallel-request' })];
    const hook = mount(); await flush(); expect(posts()).toEqual([]);
    let job;
    act(() => { job = hook.result.current.decide(row().id, true); void hook.result.current.decide('parallel-request', false); });
    expect(hook.result.current.isDeciding).toBe(true); expect(posts()).toHaveLength(1);
    await act(async () => { held.resolve(response(null, 204)); await job; });
    expect(hook.result.current.isDeciding).toBe(false); expect(hook.result.current.requests).toEqual([requests[1]]);
  });

  it('keeps a failed exact decision visible and retryable with its error', async () => {
    handlePost = async () => response({ error: 'Exact request was not accepted' }, 409);
    const hook = mount(); await flush();
    await act(async () => { await hook.result.current.decide(row().id, false); });
    expect(hook.result.current.error).toBe('Exact request was not accepted');
    expect(hook.result.current.requests).toEqual([row()]); expect(hook.result.current.isDeciding).toBe(false);
    await poll(); expect(hook.result.current.error).toBe('Exact request was not accepted');
    handlePost = async () => response(null, 204);
    await act(async () => { await hook.result.current.decide(row().id, false); });
    expect(hook.result.current.error).toBe(''); expect(hook.result.current.requests).toEqual([]);
    expect(posts().map(([, options]) => options.body)).toEqual([{ approved: false }, { approved: false }]);
  });

  it.each(['session', 'disabled', 'account', 'home', 'data-home'])('immediately clears cached rows and rejects old callbacks/replies after %s changes', async change => {
    const held = pending(); const hook = mount(); await flush();
    const oldDecide = hook.result.current.decide;
    handleGet = () => held.promise;
    await poll();
    const nextRead = pending(); handleGet = () => nextRead.promise;
    if (change === 'account') act(() => setUser({ id: 'account-b' }));
    else if (change === 'home') { ports.home = 'https://other-home.test/'; hook.rerender({ ...initial }); }
    else if (change === 'data-home') act(() => setEnvironmentIdentity('account-a', 'https://other-data-home.test/'));
    else hook.rerender({ ...initial, ...(change === 'session' ? { sessionId: 'next-session' } : { enabled: false }) });
    expect(hook.result.current.requests).toEqual([]); expect(hook.result.current.error).toBe('');
    await act(async () => { await oldDecide(row().id, true); held.resolve(response({ requests: [row()] })); });
    expect(posts()).toEqual([]); expect(hook.result.current.requests).toEqual([]);
  });

  it.each(['session', 'account', 'home', 'data-home', 'disabled', 'permission', 'unmount'])('aborts and fences a late POST failure after %s changes', async change => {
    const held = pending(); handlePost = () => held.promise;
    const hook = mount(); await flush(); let job;
    act(() => { job = hook.result.current.decide(row().id, true); });
    const postSignal = posts()[0][1].signal;
    if (change === 'account') act(() => setUser({ id: 'account-b' }));
    else if (change === 'home') { ports.home = 'https://other-home.test/'; hook.rerender({ ...initial }); }
    else if (change === 'data-home') act(() => setEnvironmentIdentity('account-a', 'https://other-data-home.test/'));
    else if (change === 'unmount') hook.unmount();
    else hook.rerender({ ...initial, ...(change === 'session' ? { sessionId: 'next-session' } : change === 'disabled' ? { enabled: false } : { canDecide: false }) });
    expect(postSignal.aborted).toBe(true);
    await act(async () => { held.resolve(response({ error: 'Late old failure' }, 409)); await job; });
    if (change !== 'unmount') { expect(hook.result.current.error).toBe(''); expect(hook.result.current.isDeciding).toBe(false); }
  });

  it.each([204, 409])('does not settle a replacement request from a late response with HTTP%s', async status => {
    const held = pending(); handlePost = () => held.promise;
    const hook = mount(); await flush(); let job;
    act(() => { job = hook.result.current.decide(row().id, true); });
    requests = [row({ id: 'next-request', arguments: { tabId: 'new-target' } })];
    await poll();
    expect(hook.result.current.requests).toEqual(requests); expect(hook.result.current.isDeciding).toBe(false);
    await act(async () => { held.resolve(response({ error: 'Old action failure' }, status)); await job; });
    expect(hook.result.current.requests).toEqual(requests); expect(hook.result.current.error).toBe('');
  });

  it('does not let a changed request with a reused ID inherit an older decision', async () => {
    const held = pending(); handlePost = () => held.promise;
    const hook = mount(); await flush(); let job;
    act(() => { job = hook.result.current.decide(row().id, true); });
    requests = [row({ arguments: { tabId: 'changed-target' }, label: `codex:${SID}:new-nonce` })];
    await poll();
    await act(async () => { held.resolve(response(null, 204)); await job; });
    expect(hook.result.current.requests).toEqual(requests); expect(hook.result.current.error).toBe('');
  });

  it('rejects a stale callback when the same ID now describes a different action', async () => {
    const hook = mount(); await flush(); const oldDecide = hook.result.current.decide;
    requests = [row({ arguments: { tabId: 'replacement-target' } })]; await poll();
    await act(async () => { await oldDecide(row().id, true); });
    expect(posts()).toEqual([]);
    await act(async () => { await hook.result.current.decide(row().id, false); });
    expect(posts().map(([, options]) => options.body)).toEqual([{ approved: false }]);
  });

  it('clears an earlier error when the same ID now describes a different pending action', async () => {
    handlePost = async () => response({ error: 'Earlier action failed' }, 409);
    const hook = mount(); await flush();
    await act(async () => { await hook.result.current.decide(row().id, true); });
    expect(hook.result.current.error).toBe('Earlier action failed');
    requests = [row({ arguments: { tabId: 'replacement-target' } })]; await poll();
    expect(hook.result.current.requests).toEqual(requests); expect(hook.result.current.error).toBe('');
  });

  it('does not let an old completion clear the next request decision in flight', async () => {
    const old = pending(), next = pending(); handlePost = () => old.promise;
    const hook = mount(); await flush(); let firstJob, nextJob;
    act(() => { firstJob = hook.result.current.decide(row().id, true); });
    requests = [row({ id: 'next-request' })]; await poll(); handlePost = () => next.promise;
    act(() => { nextJob = hook.result.current.decide('next-request', false); });
    await act(async () => { old.resolve(response(null, 204)); await firstJob; });
    expect(hook.result.current.isDeciding).toBe(true); expect(hook.result.current.requests).toEqual(requests);
    await act(async () => { next.resolve(response(null, 204)); await nextJob; });
    expect(hook.result.current.isDeciding).toBe(false); expect(hook.result.current.requests).toEqual([]);
  });

  it('stops polling and aborts the pending read on unmount', async () => {
    const held = pending(); handleGet = () => held.promise;
    const hook = mount(); const readSignal = ports.apiFetch.mock.calls[0][1].signal;
    hook.unmount(); expect(readSignal.aborted).toBe(true);
    await act(async () => { held.resolve(response({ requests: [row()] })); await vi.advanceTimersByTimeAsync(2700); });
    expect(ports.apiFetch).toHaveBeenCalledTimes(1); expect(posts()).toEqual([]);
  });
});
