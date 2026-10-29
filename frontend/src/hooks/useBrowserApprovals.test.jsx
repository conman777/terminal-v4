import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserApprovals } from './useBrowserApprovals';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const respond = requests => ({ ok: true, json: async () => ({ requests }) });

describe('useBrowserApprovals', () => {
  beforeEach(() => { vi.useFakeTimers(); apiFetch.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('polls slowly while nothing is pending and quickly once a request appears', async () => {
    apiFetch.mockResolvedValueOnce(respond([])).mockResolvedValue(respond([{ id: 'a', label: 'claude:s:t' }]));
    renderHook(() => useBrowserApprovals(true, 2500, 10000));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
    const callsBeforeIdleDelay = apiFetch.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect([callsBeforeIdleDelay, apiFetch.mock.calls.length]).toEqual([1, 3]);
  });
});
