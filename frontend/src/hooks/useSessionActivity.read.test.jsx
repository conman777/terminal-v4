import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSessionActivity } from './useSessionActivity';

describe('reading session attention', () => {
  it.each(['setFocusedSession', 'clearUnread'])('clears attention with %s and permits fresh offscreen attention', action => {
    const { result } = renderHook(useSessionActivity);
    act(() => { result.current.setFocusedSession('a'); result.current.markActivity('b'); result.current.setBusy('b', true); });
    expect(result.current.getActivity('b')).toEqual(expect.objectContaining({ hasUnread: true, needsAttention: true, isBusy: true }));
    act(() => result.current[action]('b'));
    act(() => result.current.setFocusedSession('a'));
    expect(result.current.getActivity('b')).toEqual(expect.objectContaining({ hasUnread: false, needsAttention: false, isBusy: true }));
    act(() => result.current.markActivity('b'));
    expect(result.current.getActivity('b')).toEqual(expect.objectContaining({ hasUnread: true, needsAttention: true }));
  });
});
