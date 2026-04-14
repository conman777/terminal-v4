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

function setVisualViewport(height = 768, offsetTop = 0, width = 390, offsetLeft = 0) {
  const listeners = new Map();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      height,
      width,
      offsetTop,
      offsetLeft,
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

function setInnerHeight(height) {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height
  });
}

function setInnerWidth(width) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width
  });
}

describe('useViewportHeight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(isTouchLikeDevice).mockReturnValue(true);
    vi.mocked(windowActivity.isWindowActive).mockReturnValue(true);
    vi.mocked(windowActivity.subscribeWindowActivity).mockImplementation(() => () => {});
    setInnerHeight(812);
    setInnerWidth(390);
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
    expect(result.current).toEqual({ height: 640, width: 390, offsetTop: 0, offsetLeft: 0 });

    act(() => {
      window.visualViewport.height = 402;
      window.visualViewport.offsetTop = 248;
      window.visualViewport.__listeners.get('resize')?.();
    });

    expect(result.current).toEqual({ height: 402, width: 390, offsetTop: 248, offsetLeft: 0 });
    input.remove();
  });

  it('keeps polling while text entry remains focused even if visualViewport events stop firing', () => {
    setVisualViewport(374, 392);
    setInnerHeight(374);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 374, width: 390, offsetTop: 392, offsetLeft: 0 });

    act(() => {
      setInnerHeight(670);
      window.visualViewport.height = 670;
      window.visualViewport.offsetTop = 96;
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toEqual({ height: 670, width: 390, offsetTop: 96, offsetLeft: 0 });
    input.remove();
  });

  it('keeps the shrunken visual viewport while text entry remains focused without an offset top', () => {
    setVisualViewport(402, 0);
    setInnerHeight(812);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 402, width: 390, offsetTop: 0, offsetLeft: 0 });

    input.remove();
  });

  it('tracks horizontal visual viewport drift while text entry remains focused', () => {
    setVisualViewport(670, 0, 385, 27);
    setInnerWidth(440);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 670, width: 385, offsetTop: 0, offsetLeft: 27 });

    act(() => {
      document.body.tabIndex = -1;
      input.blur();
      document.body.focus();
      window.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      window.visualViewport.width = 440;
      window.visualViewport.offsetLeft = 0;
      window.visualViewport.__listeners.get('resize')?.();
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toEqual({ height: 812, width: 440, offsetTop: 0, offsetLeft: 0 });
    input.remove();
  });

  it('restores the full viewport when text entry blurs even if visualViewport height stays stale', () => {
    setVisualViewport(402, 248);
    setInnerHeight(812);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 402, width: 390, offsetTop: 248, offsetLeft: 0 });

    act(() => {
      document.body.tabIndex = -1;
      input.blur();
      document.body.focus();
      setInnerHeight(812);
      window.visualViewport.height = 402;
      window.visualViewport.offsetTop = 0;
      window.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      window.visualViewport.__listeners.get('resize')?.();
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toEqual({ height: 812, width: 390, offsetTop: 0, offsetLeft: 0 });
    input.remove();
  });

  it('ignores transient zero/invalid visual viewport heights', () => {
    setVisualViewport(812, 0);

    const { result } = renderHook(() => useViewportMetrics());
    expect(result.current).toEqual({ height: 812, width: 390, offsetTop: 0, offsetLeft: 0 });

    act(() => {
      window.visualViewport.height = 0;
      window.visualViewport.offsetTop = -12;
      window.visualViewport.__listeners.get('resize')?.();
    });

    expect(result.current).toEqual({ height: 812, width: 390, offsetTop: 0, offsetLeft: 0 });
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
