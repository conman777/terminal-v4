import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));

vi.mock('../utils/auth', () => ({
  getAccessToken: vi.fn(() => 'stream-token')
}));

import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
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
    apiFetch.mockReset();
    global.EventSource = MockEventSource;
  });

  afterEach(() => {
    setActiveEnvironment(null);
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
  it('deduplicates sequenced replay and resets state when changing sessions', () => {
    const { result, rerender } = renderHook(({ id }) => useTerminalStream(id), { initialProps: { id: 'one' } });
    const first = MockEventSource.instances[0];
    act(() => {
      first.emit('data', JSON.stringify({ text: 'one', seq: 1 }));
      first.emit('data', JSON.stringify({ text: 'one', seq: 1 }));
      first.emit('data', JSON.stringify({ text: 'two', seq: 2 }));
    });
    expect(result.current.map(event => event.text)).toEqual(['one', 'two']);
    rerender({ id: 'two' });
    act(() => first.emit('data', JSON.stringify({ text: 'stale', seq: 3 })));
    expect(result.current).toEqual([]);
  });

  it('closes the old host stream immediately when switching environments', () => {
    setActiveEnvironment({ id: 'remote-one' });
    const { result } = renderHook(() => useTerminalStream('same-id'));
    const first = MockEventSource.instances[0];
    act(() => {
      setActiveEnvironment({ id: 'remote-two' });
      first.emit('data', JSON.stringify({ text: 'wrong host', seq: 1 }));
    });
    expect([first.closed, result.current]).toEqual([true, []]);
  });

  it('reconciles missed sequenced output before reconnecting and stops after a permission rejection', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ history: [{ seq: 2, text: 'missed' }] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    const { result, unmount } = renderHook(() => useTerminalStream('resume'));
    const first = MockEventSource.instances[0];
    act(() => first.emit('data', JSON.stringify({ seq: 1, text: 'first' })));
    await act(async () => {
      first.onerror();
      await vi.advanceTimersByTimeAsync(1500);
    });
    const second = MockEventSource.instances[1];
    expect(result.current.map(event => event.text)).toEqual(['first', 'missed']);
    expect(second.url).toContain('afterSeq=2');
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/terminal/resume/history?historyEvents=500&historyChars=200000&afterSeq=1');
    await act(async () => {
      second.onerror();
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect([second.closed, MockEventSource.instances.length]).toEqual([true, 2]);
    unmount();
    vi.useRealTimers();
  });

  it('opens an offline-mounted stream when the browser comes online', async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { unmount } = renderHook(() => useTerminalStream('offline-start'));
    expect(MockEventSource.instances).toHaveLength(0);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(MockEventSource.instances).toHaveLength(1);
    unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

});
