import { describe, expect, it, vi } from 'vitest';
import { createAutoIdleEventLoopMonitor } from './event-loop-monitor';

describe('createAutoIdleEventLoopMonitor', () => {
  it('enables the histogram lazily and reuses it across reads', () => {
    const histogram = {
      mean: 12e6,
      max: 27e6,
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn()
    };
    const createHistogram = vi.fn(() => histogram);
    const setTimeoutSpy = vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setTimeout;
    const clearTimeoutSpy = vi.fn() as unknown as typeof clearTimeout;

    const monitor = createAutoIdleEventLoopMonitor({
      createHistogram,
      timerApi: {
        setTimeout: setTimeoutSpy,
        clearTimeout: clearTimeoutSpy
      }
    });

    expect(createHistogram).not.toHaveBeenCalled();

    expect(monitor.read()).toEqual({ meanMs: 12, maxMs: 27 });
    expect(monitor.read()).toEqual({ meanMs: 12, maxMs: 27 });

    expect(createHistogram).toHaveBeenCalledTimes(1);
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    expect(histogram.reset).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('disables the histogram after the idle timeout', () => {
    vi.useFakeTimers();

    const histogram = {
      mean: 0,
      max: 0,
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn()
    };
    const createHistogram = vi.fn(() => histogram);

    const monitor = createAutoIdleEventLoopMonitor({
      idleTimeoutMs: 250,
      createHistogram
    });

    monitor.read();
    expect(histogram.disable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(histogram.disable).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(histogram.disable).toHaveBeenCalledTimes(1);

    monitor.read();
    expect(createHistogram).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('returns zeroes when the histogram has not collected samples yet', () => {
    const histogram = {
      mean: Number.NaN,
      max: Number.NaN,
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn()
    };

    const monitor = createAutoIdleEventLoopMonitor({
      createHistogram: () => histogram,
      timerApi: {
        setTimeout: vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setTimeout,
        clearTimeout: vi.fn() as unknown as typeof clearTimeout
      }
    });

    expect(monitor.read()).toEqual({ meanMs: 0, maxMs: 0 });
  });
});
