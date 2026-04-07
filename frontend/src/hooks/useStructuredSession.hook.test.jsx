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
  getAccessToken: vi.fn(() => 'test-token')
}));

vi.mock('../utils/windowActivity', () => ({
  isWindowActive: vi.fn(() => windowActivityState.active),
  subscribeWindowActivity: vi.fn((listener) => {
    windowActivityState.listeners.add(listener);
    return () => windowActivityState.listeners.delete(listener);
  })
}));

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

    act(() => {
      setWindowActive(true);
    });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('/api/structured/sessions/ss-focus/ws');
  });
});
