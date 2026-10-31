import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPullRequestMentionCache, useCurrentPullRequest } from './useCurrentPullRequest';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiGet }));

const pr = { number: 7, title: 'Fix login', url: 'https://github.com/acme/app/pull/7', state: 'OPEN' };

describe('useCurrentPullRequest', () => {
  beforeEach(() => { apiGet.mockReset(); resetPullRequestMentionCache(); setActiveEnvironment(null); setEnvironmentIdentity(''); setUser({ id: 'pr-owner-a' }); });

  it('offers the current branch pull request as a mention', async () => {
    apiGet.mockResolvedValue({ pullRequest: pr });
    const { result } = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(result.current).toEqual([{ id: '7', title: '#7 Fix login', url: pr.url }]));
    expect(apiGet).toHaveBeenCalledWith('/api/workspace/git/pull-request?path=%2Frepo', { signal: expect.any(AbortSignal) });
  });

  it.each([
    ['no pull request', { pullRequest: null }],
    ['an unavailable status', { availability: 'error', reason: 'gh missing', pullRequest: null }],
    ['a pull request without a number', { pullRequest: { title: 'x' } }],
  ])('offers nothing for %s', async (_name, response) => {
    apiGet.mockResolvedValue(response);
    const { result } = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('offers nothing and does not ask when disabled or without a folder', () => {
    renderHook(() => useCurrentPullRequest('', 'feature'));
    renderHook(() => useCurrentPullRequest('/repo', 'feature', { enabled: false }));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('offers nothing when the request fails', async () => {
    apiGet.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('drops the previous folder pull request immediately when the folder changes', async () => {
    apiGet.mockResolvedValueOnce({ pullRequest: pr }).mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook(({ cwd }) => useCurrentPullRequest(cwd, 'feature'), { initialProps: { cwd: '/repo' } });
    await waitFor(() => expect(result.current).toHaveLength(1));
    rerender({ cwd: '/other' });
    expect(result.current).toEqual([]);
  });

  it('reuses a recent answer for the same folder and branch', async () => {
    apiGet.mockResolvedValue({ pullRequest: pr });
    const first = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    first.unmount();
    const second = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    expect(second.result.current).toHaveLength(1);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it.each(['account', 'environment'])('immediately drops a cached pull request on %s changes for the same folder', async change => {
    let resolveNew;
    apiGet.mockResolvedValueOnce({ pullRequest: pr }).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    const { result } = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => { if (change === 'account') setUser({ id: 'pr-owner-b' }); else setActiveEnvironment({ id: 'host-b' }); });
    expect(result.current).toEqual([]);
    await waitFor(() => expect(resolveNew).toBeTypeOf('function'));
    await act(async () => resolveNew({ pullRequest: { ...pr, number: 8, title: 'Other' } }));
    expect(result.current).toEqual([{ id: '8', title: '#8 Other', url: pr.url }]);
  });

  it('ignores a late old-environment response even after switching back', async () => {
    let resolveOld;
    apiGet.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ pullRequest: null });
    const { result } = renderHook(() => useCurrentPullRequest('/repo', 'feature'));
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'host-b' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => resolveOld({ pullRequest: pr }));
    act(() => setActiveEnvironment(null));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(result.current).toEqual([]);
  });
});
