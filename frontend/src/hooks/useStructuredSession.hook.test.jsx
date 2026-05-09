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
});
