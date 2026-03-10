import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/auth', () => ({
  getAccessToken: vi.fn(() => 'stream-token')
}));

import { useTerminalStream } from './useTerminalStream';

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  addEventListener(event, callback) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.push(callback);
    this.listeners.set(event, callbacks);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach((callback) => callback({ data }));
  }

  close() {
    this.closed = true;
  }
}

MockEventSource.instances = [];

describe('useTerminalStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    global.EventSource = MockEventSource;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('caps retained terminal events to the most recent 500 entries', () => {
    const { result } = renderHook(() => useTerminalStream('session-1'));
    const source = MockEventSource.instances[0];

    act(() => {
      for (let index = 0; index < 505; index += 1) {
        source.emit('data', JSON.stringify({ id: index }));
      }
    });

    expect(result.current).toHaveLength(500);
    expect(result.current[0]).toMatchObject({ id: 5, role: 'terminal' });
    expect(result.current.at(-1)).toMatchObject({ id: 504, role: 'terminal' });
  });

  it('ignores late events after cleanup', () => {
    const { result, unmount } = renderHook(() => useTerminalStream('session-2'));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit('data', JSON.stringify({ id: 1 }));
    });
    expect(result.current).toHaveLength(1);

    unmount();

    act(() => {
      source.emit('data', JSON.stringify({ id: 2 }));
    });

    expect(source.closed).toBe(true);
    expect(result.current).toHaveLength(1);
  });
});
