import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useViewportHeight } from './useViewportHeight';
import { isTouchLikeDevice } from '../utils/deviceDetection';

vi.mock('../utils/deviceDetection', () => ({
  isTouchLikeDevice: vi.fn()
}));

function setVisualViewport(height = 768) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      height,
      width: 390,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  });
}

describe('useViewportHeight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(isTouchLikeDevice).mockReturnValue(true);
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
});
