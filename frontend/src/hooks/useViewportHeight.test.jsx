import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewportHeight, useViewportMetrics } from './useViewportHeight';
import { isTouchLikeDevice } from '../utils/deviceDetection';
import * as windowActivity from '../utils/windowActivity';

vi.mock('../utils/deviceDetection', () => ({
  isTouchLikeDevice: vi.fn()
}));

vi.mock('../utils/windowActivity', () => ({
  isWindowActive: vi.fn(),
  subscribeWindowActivity: vi.fn()
}));

function setVisualViewport(height = 768, offsetTop = 0) {
  const listeners = new Map();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      height,
      width: 390,
      offsetTop,
      addEventListener: vi.fn((event, listener) => {
        listeners.set(event, listener);
      }),
      removeEventListener: vi.fn((event) => {
        listeners.delete(event);
      }),
      __listeners: listeners
    }
  });
}

describe('useViewportHeight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(isTouchLikeDevice).mockReturnValue(true);
    vi.mocked(windowActivity.isWindowActive).mockReturnValue(true);
    vi.mocked(windowActivity.subscribeWindowActivity).mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('avoids continuous fallback polling when visualViewport is available', () => {
    setVisualViewport();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    renderHook(() => useViewportHeight());
    expect(setIntervalSpy.mock.calls.map(([, interval]) => interval)).not.toContain(2000);

    act(() => {
      window.dispatchEvent(new Event('focusin'));
    });
    expect(setIntervalSpy.mock.calls.map(([, interval]) => interval)).toContain(100);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(setIntervalSpy.mock.calls.map(([, interval]) => interval)).not.toContain(2000);

    setIntervalSpy.mockRestore();
  });

  it('keeps fallback polling when visualViewport is unavailable', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      writable: true,
      value: null
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    renderHook(() => useViewportHeight());
    expect(setIntervalSpy.mock.calls.map(([, interval]) => interval)).toContain(2000);

    setIntervalSpy.mockRestore();
  });

  it('restores height after the visual viewport grows when the keyboard closes', () => {
    setVisualViewport(640);

    const { result } = renderHook(() => useViewportHeight());
    expect(result.current).toBe(640);

    act(() => {
      window.visualViewport.height = 812;
      window.visualViewport.__listeners.get('resize')?.();
    });

    expect(result.current).toBe(812);
  });

  it('tracks the visual viewport offset top without double-counting it into height', () => {
    setVisualViewport(640, 0);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 640, offsetTop: 0 });

    act(() => {
      window.visualViewport.height = 402;
      window.visualViewport.offsetTop = 248;
      window.visualViewport.__listeners.get('resize')?.();
    });

    expect(result.current).toEqual({ height: 402, offsetTop: 248 });
    input.remove();
  });

  it('ignores transient zero/invalid visual viewport heights', () => {
    setVisualViewport(812, 0);

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 812, offsetTop: 0 });

    act(() => {
      window.visualViewport.height = 0;
      window.visualViewport.offsetTop = -12;
      window.visualViewport.__listeners.get('resize')?.();
    });

    expect(result.current).toEqual({ height: 812, offsetTop: 0 });
  });

  it('stops fallback polling while the window is inactive', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      writable: true,
      value: null
    });
    let handleWindowActivityChange = null;
    vi.mocked(windowActivity.subscribeWindowActivity).mockImplementation((listener) => {
      handleWindowActivityChange = listener;
      return () => {};
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    renderHook(() => useViewportHeight());
    expect(setIntervalSpy.mock.calls.map(([, interval]) => interval)).toContain(2000);

    act(() => {
      handleWindowActivityChange?.(false);
    });

    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
