import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeActiveTerminalResize } from './observeActiveTerminalResize';

describe('observeActiveTerminalResize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fits once on activate and ignores the initial ResizeObserver delivery', () => {
    const callbacks = [];
    class FakeResizeObserver {
      constructor(cb) {
        this.cb = cb;
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => {
      rafQueue[id - 1] = null;
    });

    const onFit = vi.fn();
    const onActivate = vi.fn();
    const stop = observeActiveTerminalResize(document.createElement('div'), {
      onFit,
      onActivate,
    });

    // Observer fires before activation rAF — must be ignored.
    callbacks[0]?.();
    expect(onFit).not.toHaveBeenCalled();

    rafQueue[0]?.();
    expect(onFit).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);

    // Subsequent observer deliveries schedule another fit.
    callbacks[0]?.();
    expect(onFit).toHaveBeenCalledTimes(1);
    rafQueue[1]?.();
    expect(onFit).toHaveBeenCalledTimes(2);

    stop();
  });

  it('does not fit after stop', () => {
    const callbacks = [];
    class FakeResizeObserver {
      constructor(cb) {
        this.cb = cb;
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const onFit = vi.fn();
    const stop = observeActiveTerminalResize(document.createElement('div'), {
      onFit,
      onActivate: () => {},
    });

    stop();
    rafQueue[0]?.();
    callbacks[0]?.();
    expect(onFit).not.toHaveBeenCalled();
  });
});
