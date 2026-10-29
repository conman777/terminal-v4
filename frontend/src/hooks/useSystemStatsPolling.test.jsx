import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSystemStatsPolling } from './useSystemStatsPolling';

const mocks = vi.hoisted(() => ({ get: vi.fn(), active: true, listener: null }));
vi.mock('../utils/api', () => ({ apiGet: (...args) => mocks.get(...args) }));
vi.mock('../utils/windowActivity', () => ({
  isWindowActive: () => mocks.active,
  subscribeWindowActivity: listener => {
    mocks.listener = listener;
    return () => { mocks.listener = null; };
  },
}));

const interval = 5000;
const sample = { cpuPercent: 12, timestamp: 1000 };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = () => act(async () => {});
function activity(active) {
  act(() => {
    mocks.active = active;
    mocks.listener?.(active);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.active = true;
  mocks.get.mockReset().mockResolvedValue({ stats: sample });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSystemStatsPolling', () => {
  it('shares one request across subscribers and fetches once on resume', async () => {
    const first = renderHook(() => useSystemStatsPolling());
    const second = renderHook(() => useSystemStatsPolling());
    await flush();
    expect([first.result.current, second.result.current]).toEqual([sample, sample]);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    activity(false);
    await act(async () => vi.advanceTimersByTime(interval * 3));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    activity(true);
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('waits for a slow request before scheduling another', async () => {
    const pending = deferred();
    mocks.get.mockReturnValueOnce(pending.promise);
    renderHook(() => useSystemStatsPolling());
    await act(async () => vi.advanceTimersByTime(interval * 3));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ stats: sample }));
    await act(async () => vi.advanceTimersByTime(interval));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('retires an in-flight request when the last subscriber leaves', async () => {
    const pending = deferred();
    mocks.get.mockReturnValueOnce(pending.promise);
    const first = renderHook(() => useSystemStatsPolling());
    const options = mocks.get.mock.calls[0][1];
    first.unmount();
    expect(options?.signal.aborted).toBe(true);
    const second = renderHook(() => useSystemStatsPolling());
    await flush();
    await act(async () => pending.resolve({ stats: { cpuPercent: 99 } }));
    expect(second.result.current).toEqual(sample);
  });

  it('retries a failure and stops timers when disabled', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Synthetic temporary failure'));
    const { rerender, result } = renderHook(({ enabled }) => useSystemStatsPolling(enabled), { initialProps: { enabled: true } });
    await flush();
    await act(async () => vi.advanceTimersByTime(interval));
    expect(result.current).toEqual(sample);
    rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTime(interval * 3));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});
