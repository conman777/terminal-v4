import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { insertMention, mentionQuery, useFileMentions } from './useFileMentions';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));

describe('file mentions', () => {
  it('finds the mention being typed and replaces it with the chosen file', () => {
    expect([mentionQuery('Look at @src/lo'), mentionQuery('email me@x.com'), mentionQuery('Done'), insertMention('Look at @src/lo', 'src/login.js')])
      .toEqual(['src/lo', null, null, 'Look at @src/login.js ']);
  });

  it('asks the server for matching project files', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ files: ['src/login.js'] }) });
    const { result } = renderHook(() => useFileMentions('/work', 'log'));
    await waitFor(() => expect(result.current).toEqual(['src/login.js']));
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/workspace/files?path=%2Fwork&query=log');
  });

  it('clears matches immediately when the environment changes', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ files: ['private-old-file'] }) });
    const { result, unmount } = renderHook(() => useFileMentions('/work', 'private'));
    await waitFor(() => expect(result.current).toEqual(['private-old-file']));
    act(() => setActiveEnvironment({ id: 'new-server' }));
    expect(result.current).toEqual([]);
    unmount();
    act(() => setActiveEnvironment(null));
  });
});
