import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('./FolderContext', () => ({
  useFolders: () => ({ recentFolders: [], addRecentFolder: vi.fn() })
}));

vi.mock('../utils/api', () => ({ apiFetch, apiGet: vi.fn() }));

const json = body => ({ ok: true, json: async () => body });

describe('TerminalSessionContext createSession request identity', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/terminal' && options?.method === 'POST') return json({ session: { id: 'terminal-new', isActive: true } });
      if (url === '/api/terminal') return json({ sessions: [] });
      if (url === '/api/structured/sessions?view=inventory') return json([]);
      if (String(url).startsWith('/api/state')) return json({ sessions: [] });
      throw new Error(`unexpected request ${url}`);
    });
  });

  it('forwards requestId and companionOf so the server can link and deduplicate the create', async () => {
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));

    await act(async () => {
      await result.current.createSession({ cwd: '/repo', requestId: 'req-12345678', companionOf: 'ss-1', select: false });
    });

    const post = apiFetch.mock.calls.find(([url, options]) => url === '/api/terminal' && options?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({ cwd: '/repo', requestId: 'req-12345678', companionOf: 'ss-1' });
  });
});
