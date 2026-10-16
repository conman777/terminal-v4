import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const windowActivityState = {
  active: true,
  listeners: new Set(),
};

vi.mock('../utils/api', () => ({
  apiFetch: vi.fn()
}));

vi.mock('../utils/auth', () => ({
  getAccessToken: vi.fn(() => 'test-token'),
  isAccessTokenExpired: vi.fn(() => false),
  refreshTokens: vi.fn()
}));

vi.mock('../utils/windowActivity', () => ({
  isWindowActive: vi.fn(() => windowActivityState.active),
  subscribeWindowActivity: vi.fn((listener) => {
    windowActivityState.listeners.add(listener);
    return () => windowActivityState.listeners.delete(listener);
  })
}));

import { apiFetch } from '../utils/api';
import { getAccessToken, isAccessTokenExpired, refreshTokens } from '../utils/auth';
import { useStructuredSession } from './useStructuredSession';

class MockWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function setWindowActive(active) {
  windowActivityState.active = active;
  for (const listener of windowActivityState.listeners) {
    listener(active);
  }
}

describe('useStructuredSession websocket lifecycle', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    setActiveEnvironment(null);
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    windowActivityState.active = true;
    windowActivityState.listeners = new Set();
    apiFetch.mockReset();
    getAccessToken.mockReset();
    getAccessToken.mockReturnValue('test-token');
    isAccessTokenExpired.mockReset();
    isAccessTokenExpired.mockReturnValue(false);
    refreshTokens.mockReset();
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    setActiveEnvironment(null);
    globalThis.WebSocket = originalWebSocket;
  });

  it('does not reconnect after cleanup closes the socket', async () => {
    const { unmount } = renderHook(() =>
      useStructuredSession({ sessionId: 'ss-cleanup', active: true })
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    unmount();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('refreshes an expired access token before opening the websocket', async () => {
    getAccessToken.mockReturnValue('expired-token');
    isAccessTokenExpired.mockReturnValue(true);
    refreshTokens.mockResolvedValue({ accessToken: 'fresh-token' });

    renderHook(() => useStructuredSession({ sessionId: 'ss-token', active: true }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('token=fresh-token');
  });

  it('does not reconnect a stale session after the hook switches to a new session id', async () => {
    const { rerender } = renderHook(
      ({ sessionId }) => useStructuredSession({ sessionId, active: true }),
      { initialProps: { sessionId: 'ss-one' } }
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/api/structured/sessions/ss-one/ws');

    rerender({ sessionId: 'ss-two' });

    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('/api/structured/sessions/ss-two/ws');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances.map((instance) => instance.url)).toEqual([
      expect.stringContaining('/api/structured/sessions/ss-one/ws'),
      expect.stringContaining('/api/structured/sessions/ss-two/ws'),
    ]);
  });

  it('reconnects when the window becomes active after a skipped timer reconnect', async () => {
    renderHook(() => useStructuredSession({ sessionId: 'ss-focus', active: true }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      setWindowActive(false);
      await Promise.resolve();
    });

    act(() => {
      MockWebSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(3000);
    });

    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      setWindowActive(true);
      await Promise.resolve();
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('/api/structured/sessions/ss-focus/ws');
  });

  it('sends structured composer text through the live input endpoint with fallback enabled', async () => {
    apiFetch.mockResolvedValue({ ok: true });
    const { result } = renderHook(() =>
      useStructuredSession({ sessionId: 'ss-send', active: false })
    );

    await act(async () => {
      await result.current.sendMessage('Hello from composer');
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/structured/sessions/ss-send/input', {
      method: 'POST',
      body: {
        text: 'Hello from composer\n',
        fallbackToMessage: true,
      },
    });
  });
  it('connects a paired native session only through the home socket proxy and closes it on workspace unmount', async () => {
    setActiveEnvironment({ id: 'remote-host' });
    const { unmount } = renderHook(() => useStructuredSession({ sessionId: 'ss-same-id', active: true }));
    await act(async () => { await Promise.resolve(); });
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toContain('/api/environments/remote-host/proxy/api/structured/sessions/ss-same-id/ws?token=test-token');
    expect(new URL(socket.url).host).toBe(window.location.host);
    unmount();
    expect(socket.closed).toBe(true);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('deduplicates replayed structured events and resumes from the last accepted sequence without submitting input', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-resume', active: true }));
    await act(async () => { await Promise.resolve(); });
    const first = MockWebSocket.instances[0];
    const event = { type: 'message_delta', role: 'assistant', content: 'Hello', seq: 1 };
    act(() => {
      first.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
      first.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }) });
    });
    expect(result.current.messages.map(message => message.content)).toEqual(['Hello']);
    await act(async () => {
      first.onclose({ code: 1006 });
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(MockWebSocket.instances[1].url).toContain('last_seq=1');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects stale events and prompt submissions after the environment generation changes', async () => {
    setActiveEnvironment({ id: 'remote-one' });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'same-id', active: true }));
    await act(async () => { await Promise.resolve(); });
    const old = MockWebSocket.instances[0];
    await act(async () => {
      setActiveEnvironment({ id: 'remote-two' });
      old.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq: 1, type: 'message_delta', role: 'assistant', content: 'wrong host' } }) });
      await result.current.sendMessage('must not reach new host');
      await vi.advanceTimersByTimeAsync(40000);
    });
    expect([old.closed, result.current.messages, apiFetch.mock.calls, MockWebSocket.instances.length]).toEqual([true, [], [], 1]);
  });

  it('stops retrying after remote access is revoked', async () => {
    setActiveEnvironment({ id: 'remote-revoked' });
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-revoked', active: true }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      MockWebSocket.instances[0].onclose({ code: 4403, reason: 'Permission denied' });
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect([result.current.connectionState, MockWebSocket.instances.length]).toEqual(['unavailable', 1]);
  });

  it('recovers a sequence gap with a fresh history request, ignoring the out-of-order delta', async () => {
    const { result } = renderHook(() => useStructuredSession({ sessionId: 'ss-gap', active: true }));
    await act(async () => { await Promise.resolve(); });
    const first = MockWebSocket.instances[0];
    await act(async () => {
      for (const seq of [1, 3]) first.onmessage({ data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { seq, type: 'message_delta', role: 'assistant', content: String(seq) } }) });
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.messages).toEqual([]);
    expect(new URL(MockWebSocket.instances[1].url).searchParams.has('last_seq')).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('resumes an offline-mounted session when the browser reports the network is online', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { unmount } = renderHook(() => useStructuredSession({ sessionId: 'ss-offline-start', active: true }));
    await act(async () => { await Promise.resolve(); });
    expect(MockWebSocket.instances).toHaveLength(0);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(MockWebSocket.instances).toHaveLength(1);
    unmount();
    vi.restoreAllMocks();
  });

  it('keeps observer history visible while refusing prompts, approvals and interruption', async () => {
    setActiveEnvironment({id:'observer',capabilities:{}});
    const {result}=renderHook(()=>useStructuredSession({sessionId:'ss-observer',active:true}));
    await act(async()=>{await Promise.resolve();});
    await act(async()=>{
      await result.current.sendMessage('blocked');
      await result.current.approve(true);
      await result.current.interrupt();
    });
    expect([apiFetch.mock.calls,result.current.messages,MockWebSocket.instances.length]).toEqual([[],[],1]);
  });

});
