import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionActivity } from './useSessionActivity';

describe('useSessionActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks unfocused session activity as unread attention', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setFocusedSession('session-a');
    });

    act(() => {
      result.current.markActivity('session-b');
    });

    expect(result.current.activity['session-b']).toEqual(expect.objectContaining({
      hasUnread: true,
      needsAttention: true,
      isBusy: false
    }));
  });

  it('clears busy when setBusy(id, false) is called', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setBusy('session-b', true);
    });
    expect(result.current.activity['session-b'].isBusy).toBe(true);

    act(() => {
      result.current.setBusy('session-b', false);
    });
    expect(result.current.activity['session-b'].isBusy).toBe(false);
  });

  it('returns a default activity snapshot for unknown sessions', () => {
    const { result } = renderHook(() => useSessionActivity());

    expect(result.current.getActivity('missing-session')).toEqual({
      hasUnread: false,
      needsAttention: false,
      lastActivity: 0,
      isBusy: false
    });
  });

  it('auto-clears busy after staleness timeout', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setBusy('session-a', true);
    });
    expect(result.current.activity['session-a'].isBusy).toBe(true);

    // Advance past the 8s staleness window + 2s interval tick
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(result.current.activity['session-a'].isBusy).toBe(false);
  });

  it('does not auto-clear busy if activity is refreshed', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setBusy('session-a', true);
    });

    // Advance 6 seconds then re-assert busy (refreshes lastActivity)
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    act(() => {
      result.current.setBusy('session-a', true);
    });

    // Advance another 6 seconds (total 12s from start, but only 6s from last refresh)
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current.activity['session-a'].isBusy).toBe(true);

    // Advance 4 more seconds to exceed 8s from last refresh
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.activity['session-a'].isBusy).toBe(false);
  });
});
