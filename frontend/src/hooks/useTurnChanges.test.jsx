import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../utils/api';
import { useTurnChanges } from './useTurnChanges';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));

const SESSION = 'session-1';
const first = { t1: { files: [{ path: 'a.js' }], added: 1, removed: 0, from: 'a', to: 'b' } };
const second = { ...first, t2: { files: [{ path: 'b.js' }], added: 2, removed: 0, from: 'b', to: 'c' } };

beforeEach(() => vi.mocked(apiGet).mockReset());

describe('useTurnChanges', () => {
  it('loads saved turn changes and reloads when a turn finishes', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ turns: first }).mockResolvedValueOnce({ turns: second });
    const { result, rerender } = renderHook(({ streaming }) => useTurnChanges(SESSION, streaming), { initialProps: { streaming: false } });
    await waitFor(() => expect(result.current).toEqual(first));
    rerender({ streaming: true });
    rerender({ streaming: false });
    await waitFor(() => expect(result.current).toEqual(second));
    expect(vi.mocked(apiGet).mock.calls).toEqual([[`/api/structured/sessions/${SESSION}/turn-changes`], [`/api/structured/sessions/${SESSION}/turn-changes`]]);
  });

  it('stays empty without a structured session', () => {
    const { result } = renderHook(() => useTurnChanges(null, false));
    expect([result.current, vi.mocked(apiGet).mock.calls.length]).toEqual([{}, 0]);
  });
});
