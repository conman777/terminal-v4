import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionActivity } from './useSessionActivity';

describe('useSessionActivity', () => {
  beforeEach(() => {
    window.localStorage.clear();
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
      isBusy: false,
      isDone: false
    }));
  });

  it('marks unfocused sessions as done when work finishes', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setFocusedSession('session-a');
      result.current.setBusy('session-b', true);
      result.current.setBusy('session-b', false);
    });

    expect(result.current.activity['session-b']).toEqual(expect.objectContaining({
      hasUnread: false,
      needsAttention: true,
      isBusy: false,
      isDone: true
    }));
  });

  it('clears done state when new background activity arrives', () => {
    const { result } = renderHook(() => useSessionActivity());

    act(() => {
      result.current.setFocusedSession('session-a');
      result.current.setBusy('session-b', true);
      result.current.setBusy('session-b', false);
      result.current.markActivity('session-b');
    });

    expect(result.current.activity['session-b']).toEqual(expect.objectContaining({
      hasUnread: true,
      needsAttention: true,
      isBusy: false,
      isDone: false
    }));
  });

  it('returns a default activity snapshot for unknown sessions', () => {
    const { result } = renderHook(() => useSessionActivity());

    expect(result.current.getActivity('missing-session')).toEqual({
      hasUnread: false,
      needsAttention: false,
      lastActivity: 0,
      isBusy: false,
      isDone: false
    });
  });
});
