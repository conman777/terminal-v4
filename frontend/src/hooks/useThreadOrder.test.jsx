import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadOrder } from './useThreadOrder';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

describe('useThreadOrder', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('loads the saved order from the server', async () => {
    apiFetch.mockResolvedValue(reply(200, { revision: 3, projects: { '/p': ['b', 'a'] } }));
    const { result } = renderHook(() => useThreadOrder());
    await waitFor(() => expect(result.current.orders).toEqual({ '/p': ['b', 'a'] }));
    expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('makes no request while disabled and loads when enabled', async () => {
    apiFetch.mockResolvedValue(reply(200, { revision: 1, projects: { '/p': ['a'] } }));
    const { result, rerender } = renderHook(({ enabled }) => useThreadOrder({ enabled }), { initialProps: { enabled: false } });
    await act(async () => {});
    expect(apiFetch).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.orders).toEqual({ '/p': ['a'] }));
  });

  it('saves a reorder against the loaded revision and shows it immediately', async () => {
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 3, projects: {} }));
    const { result } = renderHook(() => useThreadOrder());
    await waitFor(() => expect(result.current.ready).toBe(true));
    let outcome;
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 4, projects: { '/p': ['b', 'a'] } }));
    await act(async () => { outcome = await result.current.reorder('/p', ['b', 'a']); });
    expect(outcome).toEqual({ ok: true });
    expect(apiFetch).toHaveBeenLastCalledWith('/api/thread-order', { method: 'PUT', body: { projectPath: '/p', order: ['b', 'a'], expectedRevision: 3 } });
    expect(result.current.orders).toEqual({ '/p': ['b', 'a'] });
  });

  it('chains two quick reorders on the revision returned by the first', async () => {
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 0, projects: {} }));
    const { result } = renderHook(() => useThreadOrder());
    await waitFor(() => expect(result.current.ready).toBe(true));
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 1, projects: { '/p': ['b', 'a', 'c'] } }));
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 2, projects: { '/p': ['c', 'b', 'a'] } }));
    await act(async () => {
      await Promise.all([result.current.reorder('/p', ['b', 'a', 'c']), result.current.reorder('/p', ['c', 'b', 'a'])]);
    });
    expect(apiFetch.mock.calls.slice(1).map(([, options]) => options.body.expectedRevision)).toEqual([0, 1]);
    expect(result.current.orders).toEqual({ '/p': ['c', 'b', 'a'] });
  });

  it('adopts the server order and reports a stale revision', async () => {
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 1, projects: { '/p': ['a', 'b'] } }));
    const { result } = renderHook(() => useThreadOrder());
    await waitFor(() => expect(result.current.ready).toBe(true));
    apiFetch.mockResolvedValueOnce(reply(409, { error: 'Thread order changed elsewhere', current: { revision: 5, projects: { '/p': ['b', 'a'] } } }));
    let outcome;
    await act(async () => { outcome = await result.current.reorder('/p', ['a', 'b']); });
    expect(outcome).toEqual({ ok: false, stale: true });
    expect(result.current.orders).toEqual({ '/p': ['b', 'a'] });
    expect(result.current.error).toBe('Thread order changed on another device. Showing the latest order.');
  });

  it('rolls back and reports a failed save', async () => {
    apiFetch.mockResolvedValueOnce(reply(200, { revision: 1, projects: { '/p': ['a', 'b'] } }));
    const { result } = renderHook(() => useThreadOrder());
    await waitFor(() => expect(result.current.ready).toBe(true));
    apiFetch.mockResolvedValueOnce(reply(500, { error: 'nope' }));
    await act(async () => { await result.current.reorder('/p', ['b', 'a']); });
    expect(result.current.orders).toEqual({ '/p': ['a', 'b'] });
    expect(result.current.error).toBe('Could not save the thread order. Try again.');
  });

  it('keeps default ordering when the request itself fails', async () => {
    apiFetch.mockImplementation(async () => { throw new Error('offline'); });
    const { result } = renderHook(() => useThreadOrder());
    await act(async () => {});
    let outcome;
    await act(async () => { outcome = await result.current.reorder('/p', ['a']); });
    expect(result.current.orders).toEqual({});
    expect(outcome).toEqual({ ok: false });
  });

  it('keeps default ordering when the saved order cannot be loaded (server error)', async () => {
    apiFetch.mockResolvedValue(reply(503, { error: 'unavailable' }));
    const { result } = renderHook(() => useThreadOrder());
    await act(async () => {});
    expect(result.current.orders).toEqual({});
    let outcome;
    await act(async () => { outcome = await result.current.reorder('/p', ['a']); });
    expect(outcome).toEqual({ ok: false });
  });
});
