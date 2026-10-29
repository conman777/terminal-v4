import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { useInstalledSkills } from './useInstalledSkills';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));

it('never shows one environment’s skills in another environment for the same workspace path', async () => {
  let finishSecond;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ skills: [{ name: 'first-skill' }] }) });
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  const { result, unmount } = renderHook(() => useInstalledSkills('/same-path'));
  await waitFor(() => expect(result.current).toEqual([{ name: 'first-skill' }]));
  act(() => setActiveEnvironment({ id: 'another-server' }));
  expect(result.current).toEqual([]);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  await act(async () => { finishSecond({ ok: true, json: async () => ({ skills: [{ name: 'second-skill' }] }) }); });
  expect(result.current).toEqual([{ name: 'second-skill' }]);
  unmount();
  act(() => setActiveEnvironment(null));
});
