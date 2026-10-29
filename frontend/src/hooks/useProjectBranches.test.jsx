import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectBranches } from './useProjectBranches';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

describe('useProjectBranches', () => {
  beforeEach(() => apiFetch.mockReset());

  it('looks up every distinct project folder in one request', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ branches: { '/work/a': 'main', '/work/b': null } }) });
    const { result } = renderHook(() => useProjectBranches(['/work/b', '/work/a', '/work/a', '', null]));
    await waitFor(() => expect(result.current).toEqual({ '/work/a': 'main', '/work/b': null }));
    expect(apiFetch.mock.calls).toEqual([['/api/workspace/git/branches', { method: 'POST', body: { paths: ['/work/a', '/work/b'] } }]]);
  });

  it('makes no request when no project folders are known', () => {
    renderHook(() => useProjectBranches([]));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
