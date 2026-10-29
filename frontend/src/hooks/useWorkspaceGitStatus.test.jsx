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
    await waitFor(() => { const { refresh, ...summary } = result.current; expect([summary, typeof refresh]).toEqual([{ branch: 'main', added: 3, removed: 1, files: 2, available: true }, 'function']); });
    expect(apiFetch.mock.calls[0][0]).toBe('/api/workspace/git/status?path=%2Frepo&mode=unstaged');
  });

  it('reports no repository when the folder is not tracked by Git', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Not a Git repository' }) });
    const { result } = renderHook(() => useWorkspaceGitStatus('/plain'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current.available).toBe(false);
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
