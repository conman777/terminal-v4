import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceGitStatus } from './useWorkspaceGitStatus';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

describe('useWorkspaceGitStatus', () => {
  beforeEach(() => apiFetch.mockReset());

  it('summarises the branch and uncommitted line changes for a folder', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ branch: 'main', files: [{ path: 'a.js', added: 3, removed: 1 }, { path: 'new.txt', added: null, removed: 0 }] }) });
    const { result } = renderHook(() => useWorkspaceGitStatus('/repo'));
    await waitFor(() => { const { refresh, ...summary } = result.current; expect([summary, typeof refresh]).toEqual([{ branch: 'main', added: 3, removed: 1, files: 2, available: true, status: 'success' }, 'function']); });
    expect(apiFetch.mock.calls[0][0]).toBe('/api/workspace/git/status?path=%2Frepo&mode=unstaged');
  });

  it('reports no repository when the folder is not tracked by Git', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Not a Git repository' }) });
    const { result } = renderHook(() => useWorkspaceGitStatus('/plain'));
    await waitFor(() => expect(result.current.status).toBe('not-repository'));
    expect(result.current.available).toBe(false);
  });

  it('ignores a late response from the previous workspace', async () => {
    let resolveOld;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ branch: 'new', files: [] }) });
    const { result, rerender } = renderHook(({ cwd }) => useWorkspaceGitStatus(cwd), { initialProps: { cwd: '/old' } });
    expect(result.current.status).toBe('loading');
    rerender({ cwd: '/new' });
    await waitFor(() => expect(result.current.branch).toBe('new'));
    resolveOld({ ok: true, json: async () => ({ branch: 'old', files: [] }) });
    await Promise.resolve();
    expect(result.current.branch).toBe('new');
  });

  it('reports server errors separately from a non-Git folder', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() => useWorkspaceGitStatus('/repo'));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('stops asking about folders that are not Git repositories', async () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Not a Git repository' }) });
      renderHook(() => useWorkspaceGitStatus('/plain'));
      await vi.advanceTimersByTimeAsync(60000);
      expect(apiFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
