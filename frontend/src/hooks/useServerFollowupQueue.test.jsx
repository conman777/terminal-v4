import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerFollowupQueue } from './useServerFollowupQueue';

const probe = vi.hoisted(() => vi.fn());
vi.mock('../utils/serverFollowupQueue', () => ({ probeServerFollowupQueue: probe }));
const snapshot = { revision: 1, mode: 'running', holdReason: null, items: [], order: [] };

beforeEach(() => { probe.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('useServerFollowupQueue', () => {
  it('does not probe without a session and reports unavailable', () => {
    const { result } = renderHook(() => useServerFollowupQueue(null));
    expect(result.current.status).toBe('unavailable');
    expect(probe).not.toHaveBeenCalled();
  });

  it('is unknown until the probe settles, then exposes the snapshot', async () => {
    probe.mockResolvedValue({ status: 'available', snapshot });
    const { result } = renderHook(() => useServerFollowupQueue('ss-1', { pollMs: 0 }));
    expect(result.current.status).toBe('unknown');
    await waitFor(() => expect(result.current.status).toBe('available'));
    expect(result.current.snapshot).toBe(snapshot);
  });

  it('keeps the tab-local fallback label reason when the host has no queue', async () => {
    probe.mockResolvedValue({ status: 'unavailable', reason: 'Follow-up queues are available only in V4 conversations' });
    const { result } = renderHook(() => useServerFollowupQueue('ss-1', { pollMs: 0 }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.reason).toMatch(/only in V4/);
  });

  it('retries an unknown probe and does not downgrade an available queue on a transient failure', async () => {
    vi.useFakeTimers();
    probe.mockResolvedValueOnce({ status: 'unknown' }).mockResolvedValueOnce({ status: 'available', snapshot }).mockResolvedValue({ status: 'unknown' });
    const { result } = renderHook(() => useServerFollowupQueue('ss-1', { pollMs: 1000, retryMs: 1000 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current.status).toBe('available');
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(result.current.status).toBe('available');
  });

  it('forgets the previous session while the next one is probing', async () => {
    probe.mockResolvedValueOnce({ status: 'available', snapshot });
    const { result, rerender } = renderHook(({ id }) => useServerFollowupQueue(id, { pollMs: 0 }), { initialProps: { id: 'ss-1' } });
    await waitFor(() => expect(result.current.status).toBe('available'));
    let release;
    probe.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    rerender({ id: 'ss-2' });
    expect(result.current.status).toBe('unknown');
    await act(async () => release({ status: 'unavailable', reason: 'none' }));
  });
});
