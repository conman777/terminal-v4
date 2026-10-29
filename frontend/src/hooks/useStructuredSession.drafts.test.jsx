import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'fixture-token', isAccessTokenExpired: () => false, refreshTokens: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
const mount = () => renderHook(() => useStructuredSession({ sessionId: 'ss-colliding-draft', runtime: 'v4', active: false }));
const receipt = requestId => ({ status: 'completed', requestId, turnId: 'fixture-turn', messageId: 'fixture-message', acceptedSeq: 1 });
describe('owned V4 durable uncertain send identity', () => {
  beforeEach(() => { setEnvironmentIdentity('synthetic-owner', 'https://home.example'); setActiveEnvironment(null); localStorage.clear(); apiFetch.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); setActiveEnvironment(null); setEnvironmentIdentity(null); localStorage.clear(); });
  function loseSends(bodies) {
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') { bodies.push(options.body); throw new TypeError('Synthetic lost connection'); }
      return { ok: false, status: 404 };
    });
  }
  it('retains the same UUID for an uncertain same-text retry after the real hook unmounts', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Keep exact request')).rejects.toThrow(); });
    first.unmount();
    const second = mount();
    await act(async () => { await expect(second.result.current.sendMessage('Keep exact request')).rejects.toThrow(); });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].requestId).toBe(bodies[0].requestId);
  });
  it('checks a persisted uncertain receipt on explicit retry without reposting an already accepted message', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Accepted before remount')).rejects.toThrow(); });
    first.unmount();
    apiFetch.mockClear();
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new Error('A durable receipt must be checked before another POST');
      return { ok: true, json: async () => receipt(bodies[0].requestId) };
    });
    const second = mount();
    expect(apiFetch).not.toHaveBeenCalled();
    await act(async () => { expect(await second.result.current.sendMessage('Accepted before remount')).toMatchObject({ accepted: true, requestId: bodies[0].requestId }); });
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('isolates colliding session IDs by owner and environment and restores the original identity on return', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Same text in different scopes')).rejects.toThrow(); }); first.unmount();
    setActiveEnvironment({ id: 'synthetic-host', capabilities: { agentExecute: true } });
    const remote = mount();
    await act(async () => { await expect(remote.result.current.sendMessage('Same text in different scopes')).rejects.toThrow(); }); remote.unmount();
    setActiveEnvironment(null); setEnvironmentIdentity('other-synthetic-owner', 'https://home.example');
    const other = mount();
    await act(async () => { await expect(other.result.current.sendMessage('Same text in different scopes')).rejects.toThrow(); }); other.unmount();
    setEnvironmentIdentity('synthetic-owner', 'https://home.example');
    const returned = mount();
    await act(async () => { await expect(returned.result.current.sendMessage('Same text in different scopes')).rejects.toThrow(); });
    expect(new Set(bodies.slice(0, 3).map(body => body.requestId)).size).toBe(3);
    expect(bodies[3].requestId).toBe(bodies[0].requestId);
  });
  it('shares a single-flight lease across mounted hooks and retains its UUID when the first view unmounts', async () => {
    let resolve;
    apiFetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = mount(), second = mount();
    let pending;
    act(() => { pending = first.result.current.sendMessage('One scoped attempt'); });
    const original = apiFetch.mock.calls[0][1].body.requestId;
    expect(second.result.current.isSending).toBe(true);
    await act(async () => { expect(await second.result.current.sendMessage('One scoped attempt')).toMatchObject({ accepted: false, pending: true }); });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    first.unmount();
    expect(second.result.current.isSending).toBe(false);
    apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? { ok: true, json: async () => receipt(options.body.requestId) } : { ok: false, status: 404 });
    await act(async () => { expect(await second.result.current.sendMessage('One scoped attempt')).toMatchObject({ accepted: true, requestId: original }); });
    await act(async () => { resolve({ ok: true, json: async () => receipt(original) }); expect(await pending).toMatchObject({ accepted: false, stale: true }); });
  });
  it('retains its persisted identity and does not POST if a manual receipt lookup is rejected', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Keep uncertain auth retry')).rejects.toThrow(); }); first.unmount();
    apiFetch.mockClear(); apiFetch.mockResolvedValue({ ok: false, status: 403 });
    const second = mount();
    await act(async () => { await expect(second.result.current.sendMessage('Keep uncertain auth retry')).rejects.toThrow(); });
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false); second.unmount();
    apiFetch.mockClear(); apiFetch.mockImplementation(async (_url, options) => options?.method === 'POST' ? { ok: true, json: async () => receipt(options.body.requestId) } : { ok: false, status: 404 });
    const third = mount();
    await act(async () => { expect(await third.result.current.sendMessage('Keep uncertain auth retry')).toMatchObject({ accepted: true, requestId: bodies[0].requestId }); });
  });
  it('ignores a receipt parsed after its view unmounts and keeps the persisted intent for the replacement view', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Late parsed receipt')).rejects.toThrow(); }); first.unmount();
    let resolveJson;
    apiFetch.mockImplementation(async () => ({ ok: true, json: () => new Promise(done => { resolveJson = done; }) }));
    const second = mount(); let pending;
    await act(async () => { pending = second.result.current.sendMessage('Late parsed receipt'); await Promise.resolve(); }); second.unmount();
    await act(async () => { resolveJson(receipt(bodies[0].requestId)); expect(await pending).toMatchObject({ accepted: false, stale: true }); });
  });
  it('checks the original receipt first when a temporary storage read failure recovers on manual retry', async () => {
    const bodies = []; loseSends(bodies);
    const first = mount();
    await act(async () => { await expect(first.result.current.sendMessage('Recover tracked receipt')).rejects.toThrow(); }); first.unmount();
    setEnvironmentIdentity('intermediate-owner', 'https://home.example');
    setEnvironmentIdentity('synthetic-owner', 'https://home.example');
    let unavailable = true;
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) { if (unavailable && key.includes('composerDraft:')) throw new Error('Synthetic temporary read failure'); return getItem.call(this, key); });
    const restored = mount();
    unavailable = false;
    apiFetch.mockClear();
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new Error('The recovered receipt must be checked first');
      return { ok: true, json: async () => receipt(bodies[0].requestId) };
    });
    await act(async () => { expect(await restored.result.current.sendMessage('Recover tracked receipt')).toMatchObject({ accepted: true, requestId: bodies[0].requestId }); });
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
  it('does not send an untracked UUID if its durable intent cannot be saved', async () => {
    const session = mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Synthetic storage full', 'QuotaExceededError'); });
    apiFetch.mockImplementation(async (_url, options) => ({ ok: true, json: async () => receipt(options.body.requestId) }));
    await act(async () => { await expect(session.result.current.sendMessage('Keep a tracked draft')).rejects.toThrow(/save|storage|persist/i); });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
