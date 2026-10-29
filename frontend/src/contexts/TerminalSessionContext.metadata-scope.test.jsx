import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginAuthChange } from '../utils/auth';
import { getEnvironmentStorage, setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ apiFetch }));
vi.mock('./FolderContext', () => ({ useFolders: () => ({ recentFolders: [], addRecentFolder: vi.fn() }) }));

describe('thread metadata scope', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { setActiveEnvironment(null); setEnvironmentIdentity(null); vi.clearAllMocks(); });

  it.each([
    ['structured', 'ss-thread', 'account'],
    ['structured', 'ss-thread', 'account identity'],
    ['structured', 'ss-thread', 'environment'],
    ['terminal', 'terminal-1', 'account'],
    ['terminal', 'terminal-1', 'account identity'],
    ['terminal', 'terminal-1', 'environment'],
  ])('does not apply a delayed %s update for %s after a %s change', async (kind, id, change) => {
    let resolveBody;
    const body = new Promise(resolve => { resolveBody = resolve; });
    const response = (value) => ({ ok: true, json: async () => value });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (options.method === 'PATCH') return { ok: true, json: () => body };
      if (url === '/api/terminal') return response({ sessions: [{ id: 'terminal-1', isActive: true, title: 'Terminal', thread: { pinned: false } }] });
      if (url === '/api/structured/sessions?view=inventory') return response([{ id: 'ss-thread', provider: 'claude', runtime: 'claude', cwd: '/tmp/synthetic', title: 'Thread', thread: { pinned: false } }]);
      if (String(url).startsWith('/api/state')) return response({ sessions: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const oldStorage = getEnvironmentStorage();
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    await waitFor(() => expect(result.current.sessions.some(session => session.id === id)).toBe(true));
    const before = result.current.sessions;
    const savedBefore = oldStorage.getItem('structuredSessionMetadata');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let pending;
      act(() => { pending = result.current.updateThreadMetadata(id, { pinned: true }).catch(error => error); });
      await waitFor(() => expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true));
      act(() => {
        if (change === 'account') beginAuthChange();
        else if (change === 'account identity') localStorage.setItem('terminal_user', JSON.stringify({ id: 'another-user' }));
        else setActiveEnvironment({ id: 'synthetic-remote' });
      });
      let outcome;
      await act(async () => { resolveBody({ thread: { pinned: true } }); outcome = await pending; });
      expect(outcome).toBeInstanceOf(Error);
      expect(result.current.sessions).toEqual(before);
      expect(oldStorage.getItem('structuredSessionMetadata')).toBe(savedBefore);
    } finally { log.mockRestore(); }
  });
});
