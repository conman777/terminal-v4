import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiGet } from './api';
import { readStrictResponseMetadata, validateStrictResponse } from './strictAuthenticatedFetch';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserAuthAuthority } from './standaloneIndexedDbAuthAuthority';
import { createBrowserAuthLifecycle } from './browserAuthLifecycle';
import { setActiveEnvironment } from './remoteEnvironments';

const pair = { owner: 'account-a', home: 'http://localhost:3000/', session: 'session-a', accessToken: 'strict-token', refreshToken: 'refresh-token' };
const snapshot = overrides => ({ status: 'active', incarnation: 'browser-session-a', revision: 'one', refreshReserved: false, user: { id: 'account-a' }, pair, ...overrides });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('terminal_access_token', 'legacy-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});
afterEach(() => { setActiveEnvironment(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('strict authority API requests', () => {
  it('uses the current authority token and never forwards the lifecycle to fetch', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    await apiFetch('/api/test', { authLifecycle });
    const [url, options] = fetch.mock.calls[0];
    expect([url, options.headers.get('Authorization'), options.authLifecycle]).toEqual(['/api/test', 'Bearer strict-token', undefined]);
  });

  it('replaces a caller-supplied authorization header regardless of casing', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    await apiFetch('/api/test', { headers: new Headers({ authorization: 'Bearer foreign', 'x-fixture': 'safe' }), authLifecycle });
    const headers = fetch.mock.calls[0][1].headers;
    expect([headers.get('authorization'), headers.get('x-fixture')]).toEqual(['Bearer strict-token', 'safe']);
  });

  it.each([{ status: 'unavailable' }, snapshot({ refreshReserved: true }), snapshot({ user: { id: 'account-b' } })])('refuses dispatch with an unavailable or inconsistent session', async value => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(value), refresh: vi.fn() };
    await expect(apiFetch('/api/test', { authLifecycle })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('never falls back to legacy credentials when strict authority is missing', async authLifecycle => {
    await expect(apiFetch('/api/test', { authLifecycle })).rejects.toThrow('Authentication is unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not replay an authenticated write after a 401', async () => {
    fetch.mockResolvedValue(new Response(null, { status: 401 }));
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    expect((await readStrictResponseMetadata(await apiFetch('/api/test', { method: 'POST', body: { draft: 'keep' }, authLifecycle }))).status).toBe(401);
    expect([fetch.mock.calls.length, authLifecycle.refresh.mock.calls.length]).toEqual([1, 0]);
  });

  it('refreshes a read only when the same login remains current', async () => {
    const rotated = snapshot({ revision: 'two', pair: { ...pair, accessToken: 'rotated-token' } });
    const authLifecycle = { read: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot()).mockResolvedValue(rotated), refresh: vi.fn().mockResolvedValue({ status: 'active' }) };
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await readStrictResponseMetadata(await apiFetch('/api/test', { authLifecycle }))).status).toBe(204);
    expect(fetch.mock.calls.map(([, options]) => options.headers.get('Authorization'))).toEqual(['Bearer strict-token', 'Bearer rotated-token']);
    expect(authLifecycle.refresh).toHaveBeenCalledWith({ incarnation: 'browser-session-a', owner: 'account-a', session: 'session-a', home: pair.home }, { signal: expect.any(AbortSignal) });
  });

  it('does not retry a read when the originating login cannot be refreshed', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn().mockResolvedValue({ status: 'conflict' }) };
    fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(apiFetch('/api/test', { authLifecycle })).rejects.toThrow('refresh could not be confirmed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(authLifecycle.refresh).toHaveBeenCalledWith({ incarnation: 'browser-session-a', owner: 'account-a', session: 'session-a', home: pair.home }, { signal: expect.any(AbortSignal) });
  });

  it('marks a write as unconfirmed if the login changes after dispatch', async () => {
    const changed = snapshot({ incarnation: 'browser-session-b', user: { id: 'account-b' }, pair: { ...pair, owner: 'account-b', session: 'session-b' } });
    const authLifecycle = { read: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(changed), refresh: vi.fn() };
    const error = await apiFetch('/api/test', { method: 'POST', body: { draft: 'keep' }, authLifecycle }).catch(value => value);
    expect([error.message, error.outcomeUncertain, fetch.mock.calls.length]).toEqual(['Authentication changed; request outcome may be unconfirmed', true, 1]);
  });

  it('marks a lost write response as unconfirmed without retrying it', async () => {
    fetch.mockRejectedValue(new TypeError('network unavailable'));
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    const error = await apiFetch('/api/test', { method: 'POST', body: { draft: 'keep' }, authLifecycle }).catch(value => value);
    expect([error.outcomeUncertain, fetch.mock.calls.length, authLifecycle.refresh.mock.calls.length]).toEqual([true, 1, 0]);
  });

  it('does not return a home-environment write result after switching environments', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    let release, started;
    const seen = new Promise(resolve => { started = resolve; });
    fetch.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = apiFetch('/api/test', { method: 'POST', body: { draft: 'keep' }, authLifecycle }).catch(error => error);
    await seen;
    setActiveEnvironment({ id: 'remote' });
    release(new Response(null, { status: 204 }));
    const error = await pending;
    expect([error.outcomeUncertain, fetch.mock.calls.length]).toEqual([true, 1]);
  });

  it('refuses credentials bound to another home server', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot({ pair: { ...pair, home: 'https://other.example/' } })), refresh: vi.fn() };
    await expect(apiFetch('/api/test', { authLifecycle })).rejects.toThrow('Authentication is unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not return an old account response after another login wins', async () => {
    const changed = snapshot({ incarnation: 'browser-session-b', user: { id: 'account-b' }, pair: { ...pair, owner: 'account-b', session: 'session-b' } });
    const authLifecycle = { read: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(changed), refresh: vi.fn() };
    await expect(apiFetch('/api/test', { authLifecycle })).rejects.toThrow('Authentication changed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not return decoded data if a different login wins while the body is read', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    let release, started;
    const seen = new Promise(resolve => { started = resolve; });
    fetch.mockResolvedValue({ ok: true, status: 200, json: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const pending = apiGet('/api/test', { authLifecycle }).catch(error => error);
    await seen;
    authLifecycle.read.mockResolvedValue(snapshot({ incarnation: 'browser-session-b', user: { id: 'account-b' }, pair: { ...pair, owner: 'account-b', session: 'session-b' } }));
    release({ private: 'old-account-data' });
    expect((await pending).message).toBe('Authentication changed');
  });

  it('protects direct response decoding when a different login wins during body consumption', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    let release, started;
    const seen = new Promise(resolve => { started = resolve; });
    fetch.mockResolvedValue({ ok: true, status: 200, json: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const response = await apiFetch('/api/test', { authLifecycle });
    const pending = response.json().catch(error => error);
    await seen;
    authLifecycle.read.mockResolvedValue(snapshot({ incarnation: 'browser-session-b', user: { id: 'account-b' }, pair: { ...pair, owner: 'account-b', session: 'session-b' } }));
    release({ private: 'old-account-data' });
    expect((await pending).message).toBe('Authentication changed');
  });

  it('keeps clones scope-checked and does not expose an unguarded response stream', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    fetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const response = await apiFetch('/api/test', { authLifecycle });
    const clone = response.clone();
    await validateStrictResponse(clone, { required: true });
    expect(() => response.body).toThrow('Streaming requires session-aware handling');
    expect(await clone.json()).toEqual({ ok: true });
    await expect(validateStrictResponse(new Response(), { required: true })).rejects.toThrow('Strict response scope is unavailable');
  });

  it('does not expose private response metadata after another login wins', async () => {
    const authLifecycle = { read: vi.fn().mockResolvedValue(snapshot()), refresh: vi.fn() };
    fetch.mockResolvedValue(new Response(null, { status: 200, headers: { 'X-Private-Value': 'account-a' } }));
    const response = await apiFetch('/api/test', { authLifecycle });
    expect(() => response.headers).toThrow('Response metadata requires session-aware handling');
    expect(() => response.status).toThrow('Response metadata requires session-aware handling');
    expect((await readStrictResponseMetadata(response)).headers.get('X-Private-Value')).toBe('account-a');
    authLifecycle.read.mockResolvedValue(snapshot({ incarnation: 'browser-session-b', user: { id: 'account-b' }, pair: { ...pair, owner: 'account-b', session: 'session-b' } }));
    await expect(readStrictResponseMetadata(response)).rejects.toThrow('Authentication changed');
  });

  it('holds a write response when another tab logs out during the request', async () => {
    const indexedDB = new IDBFactory();
    const authority = () => createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: async ({ receipt }) => receipt === 'confirmed' });
    const first = authority(), second = authority();
    expect((await first.provision()).status).toBe('provisioned');
    const transport = { login: vi.fn(async () => ({ kind: 'issued', user: { id: pair.owner, username: 'synthetic-user' }, session: pair.session, accessToken: pair.accessToken, refreshToken: pair.refreshToken, logoutCapability: 'a'.repeat(64) })), logout: vi.fn(async () => 'confirmed') };
    const a = createBrowserAuthLifecycle({ authority: first, transport });
    const b = createBrowserAuthLifecycle({ authority: second, transport });
    expect((await a.login(pair.home, {})).status).toBe('active');
    let release, started;
    const seen = new Promise(resolve => { started = resolve; });
    fetch.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = apiFetch('/api/test', { method: 'POST', body: { draft: 'keep' }, authLifecycle: a }).catch(error => error);
    await seen;
    expect((await b.logout()).status).toBe('tombstone');
    release(new Response(null, { status: 204 }));
    const error = await pending;
    expect([error.outcomeUncertain, fetch.mock.calls.length, (await a.read()).status]).toEqual([true, 1, 'tombstone']);
  });
});
