import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIdleDetection } from './useIdleDetection';
import { SESSION_BUSY_WINDOW_MS } from '../constants/sessionActivity';

describe('useIdleDetection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the shared busy window before transitioning to idle', () => {
    const onActivityChange = vi.fn();
    const startFaviconFlash = vi.fn();
    const stopFaviconFlash = vi.fn();
    const { result } = renderHook(() => useIdleDetection({ onActivityChange, startFaviconFlash, stopFaviconFlash }));

    act(() => {
      result.current.markUserInput();
      result.current.resetIdleTimer(false);
    });

    expect(onActivityChange).toHaveBeenCalledWith(true);
    expect(startFaviconFlash).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(SESSION_BUSY_WINDOW_MS - 1);
    });

    expect(onActivityChange).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onActivityChange).toHaveBeenLastCalledWith(false);
    expect(stopFaviconFlash).toHaveBeenCalledTimes(1);
  });

  it('does not activate when output is ignored during scrolling', () => {
    const onActivityChange = vi.fn();
    const { result } = renderHook(() => useIdleDetection({ onActivityChange }));

    act(() => {
      result.current.markUserInput();
      result.current.resetIdleTimer(true);
      vi.runOnlyPendingTimers();
    });

    expect(onActivityChange).not.toHaveBeenCalled();
  });
});
