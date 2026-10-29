import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSnoozeExpiry } from './useSnoozeExpiry';
import { isSnoozedThread } from '../utils/threadLifecycle';

describe('useSnoozeExpiry', () => {
  afterEach(() => vi.useRealTimers());

  it('re-renders when a snooze expires so the thread returns to the inbox without a refresh', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const session = { id: 'ss-a', threadLifecycle: { supported: true, snoozed: true, requiresAttention: false, snoozedUntilMs: 1_005_000 } };
    let renders = 0;
    renderHook(() => { renders += 1; useSnoozeExpiry([session]); });
    const before = renders;
    expect(isSnoozedThread(session)).toBe(true);
    act(() => { vi.advanceTimersByTime(5_100); });
    expect(renders).toBeGreaterThan(before);
    expect(isSnoozedThread(session)).toBe(false);
  });
});
