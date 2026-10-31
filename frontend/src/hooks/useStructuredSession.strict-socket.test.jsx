import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({ getAccessToken: vi.fn(() => 'legacy-token'), isAccessTokenExpired: vi.fn(() => false), refreshTokens: vi.fn() }));
vi.mock('../utils/windowActivity', () => ({ isWindowActive: () => true, subscribeWindowActivity: () => () => {} }));
import { getAccessToken } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { useStructuredSession } from './useStructuredSession';
class Socket {
  static instances = [];
  constructor(url) { this.url = url; this.closed = false; Socket.instances.push(this); }
  close() { this.closed = true; this.onclose?.({ code: 1000 }); }
  open() { this.onopen?.(); }
  emit(seq, content) { this.onmessage?.({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq, type: 'user_message_accepted', messageId: `m${seq}`, content } }) }); }
}
const active = (overrides = {}) => ({ status: 'active', incarnation: 'inc-a', user: { id: 'owner-a' }, pair: { owner: 'owner-a', session: 'login-a', home: new URL('/', window.location.origin).href, accessToken: 'strict-token' }, ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const original = globalThis.WebSocket;
const session = lifecycle => useStructuredSession({ sessionId: 'ss-fixture', runtime: 'v4', authLifecycle: lifecycle, strictReady: true });
describe('strict structured socket scope', () => {
  beforeEach(() => { setActiveEnvironment(null); Socket.instances = []; globalThis.WebSocket = Socket; getAccessToken.mockClear(); });
  afterEach(() => { setActiveEnvironment(null); globalThis.WebSocket = original; });
  it('retires a retained legacy send callback as soon as strict mode is selected', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const { result, rerender } = renderHook(({ strict }) => useStructuredSession({
      sessionId: 'ss-fixture', runtime: 'claude', active: false,
      ...(strict ? { authLifecycle: undefined, strictReady: false } : {}),
    }), { initialProps: { strict: false } });
    const { sendMessage: oldSend, interrupt: oldInterrupt, approve: oldApprove } = result.current;
    rerender({ strict: true });
    await act(async () => {
      expect(await oldSend('old account message')).toEqual({ accepted: false });
      expect(await oldInterrupt()).toEqual({ accepted: false });
      expect(await oldApprove(true)).toEqual({ accepted: false });
    });
    rerender({ strict: false });
    await act(async () => { expect(await oldSend('stale after return')).toEqual({ accepted: false }); });
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('uses only the injected authority and rejects an unavailable authority', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const hook = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    expect(Socket.instances[0].url).toContain('token=strict-token');
    expect(getAccessToken).not.toHaveBeenCalled();
    hook.unmount(); Socket.instances = [];
    renderHook(() => session(undefined));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Socket.instances).toHaveLength(0);
    expect(getAccessToken).not.toHaveBeenCalled();
  });
  it('does not connect when the login changes during readiness', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValueOnce(active()).mockReturnValueOnce(wait.promise) };
    renderHook(() => session(lifecycle));
    await waitFor(() => expect(lifecycle.read).toHaveBeenCalledTimes(2));
    await act(async () => { wait.resolve(active({ incarnation: 'inc-b' })); await wait.promise; });
    expect(Socket.instances).toHaveLength(0);
  });
  it('closes and ignores a delayed event after logout or replacement login', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => { socket.open(); });
    lifecycle.read.mockReturnValueOnce(wait.promise);
    act(() => socket.emit(1, 'private old answer'));
    await act(async () => { wait.resolve({ status: 'tombstone' }); await wait.promise; });
    await waitFor(() => expect(socket.closed).toBe(true));
    expect(result.current.messages).toEqual([]);
  });
  it('serializes asynchronous event authorization and keeps event order', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    lifecycle.read.mockReturnValueOnce(wait.promise);
    act(() => { socket.emit(1, 'first'); socket.emit(2, 'second'); });
    expect(result.current.messages).toEqual([]);
    await act(async () => { wait.resolve(active()); await wait.promise; });
    await waitFor(() => expect(result.current.messages.map(m => m.content)).toEqual(['first', 'second']));
  });
  it('closes rather than buffering an unbounded backlog', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    lifecycle.read.mockReturnValueOnce(wait.promise);
    act(() => { for (let i = 1; i <= 150; i++) socket.emit(i, 'pending'); });
    expect(socket.closed).toBe(true);
    await act(async () => { wait.resolve(active()); await wait.promise; });
    expect(result.current.messages).toEqual([]);
  });
  it('does not connect when strict readiness is false', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    renderHook(() => useStructuredSession({ sessionId: 'ss-fixture', runtime: 'v4', authLifecycle: lifecycle, strictReady: false }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([Socket.instances.length, lifecycle.read.mock.calls.length, getAccessToken.mock.calls.length]).toEqual([0, 0, 0]);
  });
  it('refuses a replacement login even when the user explicitly reconnects', async () => {
    let snapshot = active();
    const lifecycle = { read: vi.fn(async () => snapshot) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    snapshot = active({ incarnation: 'inc-b' });
    await act(async () => { socket.emit(1, 'stale'); });
    await waitFor(() => expect(socket.closed).toBe(true));
    await act(async () => { result.current.reconnect(); });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(Socket.instances).toHaveLength(1);
  });
  it('drops pending events when the environment changes during authorization', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    lifecycle.read.mockReturnValueOnce(wait.promise);
    act(() => socket.emit(1, 'old environment'));
    act(() => setActiveEnvironment({ id: 'remote-device' }));
    await act(async () => { wait.resolve(active()); await wait.promise; });
    expect(socket.closed).toBe(true);
    expect(result.current.messages).toEqual([]);
  });
  it('revalidates a delayed socket open before announcing online', async () => {
    const wait = deferred();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    lifecycle.read.mockReturnValueOnce(wait.promise);
    act(() => socket.open());
    expect(result.current.connectionState).not.toBe('online');
    await act(async () => { wait.resolve(active({ incarnation: 'inc-b' })); await wait.promise; });
    await waitFor(() => expect(socket.closed).toBe(true));
    expect(result.current.connectionState).toBe('unavailable');
  });
  it('does not recover oversized history through a legacy authenticated request', async () => {
    apiFetch.mockClear();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0];
    await act(async () => socket.open());
    act(() => socket.onclose({ code: 1009 }));
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('holds all action and image recovery paths without a legacy request', async () => {
    apiFetch.mockClear();
    const lifecycle = { read: vi.fn().mockResolvedValue(active()) };
    const { result } = renderHook(() => session(lifecycle));
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    await act(async () => {
      await expect(result.current.sendMessage('preserve draft')).rejects.toThrow(/unavailable/i);
      await expect(result.current.checkPendingMessage()).rejects.toThrow(/unavailable/i);
      await expect(result.current.retryPendingMessage()).rejects.toThrow(/unavailable/i);
      expect(await result.current.interrupt()).toEqual({ accepted: false });
      expect(await result.current.approve(true)).toEqual({ accepted: false });
      expect(await result.current.reviewApproval()).toEqual({ accepted: false });
    });
    expect(result.current.actionError).toMatch(/draft were kept/i);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
