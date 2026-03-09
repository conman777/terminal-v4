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

  it('does not extend stale backend busy timestamps when a snapshot timestamp is provided', () => {
    const { result } = renderHook(() => useSessionActivity());
    const snapshotTs = Date.now() - 7000;

    act(() => {
      result.current.setBusy('session-a', true, { lastActivityAt: snapshotTs });
    });

    expect(result.current.activity['session-a']).toEqual(expect.objectContaining({
      isBusy: true,
      lastActivity: snapshotTs
    }));

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.activity['session-a'].isBusy).toBe(false);
  });

  it('does not restore busy from an older backend snapshot after a local idle transition', () => {
    const { result } = renderHook(() => useSessionActivity());
    const snapshotTs = Date.now() - 5000;

    act(() => {
      result.current.setBusy('session-a', true, { lastActivityAt: snapshotTs });
    });

    expect(result.current.activity['session-a']).toEqual(expect.objectContaining({
      isBusy: true,
      lastActivity: snapshotTs
    }));

    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.setBusy('session-a', false);
    });

    const localIdleTs = result.current.activity['session-a'].lastActivity;
    expect(result.current.activity['session-a']).toEqual(expect.objectContaining({
      isBusy: false
    }));
    expect(localIdleTs).toBeGreaterThan(snapshotTs);

    act(() => {
      result.current.setBusy('session-a', true, { lastActivityAt: snapshotTs });
    });

    expect(result.current.activity['session-a']).toEqual(expect.objectContaining({
      isBusy: false,
      lastActivity: localIdleTs
    }));
  });

  it('marks an unfocused session as needing attention when work completes', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setFocusedSession('session-a');
      result.current.setBusy('session-b', true);
    });

    act(() => {
      result.current.setBusy('session-b', false);
    });

    expect(result.current.activity['session-b']).toEqual(expect.objectContaining({
      isBusy: false,
      hasUnread: true,
      needsAttention: true
    }));
  });
});
