import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';
import { BookmarkProvider, useBookmarks } from './BookmarkContext';
import { claimTerminalCommand } from '../utils/terminalCommandDelivery';

vi.mock('./FolderContext', () => ({ useFolders: () => ({ recentFolders: [], addRecentFolder: vi.fn() }) }));
vi.mock('../utils/auth', () => ({
  getAccessToken: () => null, clearTokens: vi.fn(), refreshTokens: vi.fn(),
  getAuthInitializing: () => false, captureAuthScope: () => 'synthetic', isAuthScopeCurrent: () => true,
  subscribeAuth: () => () => {},
}));
const sessionId = 'synthetic-delivery';
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const wrapper = ({ children }) => <TerminalSessionProvider><BookmarkProvider>{children}</BookmarkProvider></TerminalSessionProvider>;

describe('terminal context callers invalidate composer recovery through the real HTTP boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn(async (url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path === '/api/terminal') return json({ sessions: [{ id: sessionId, isActive: true, shell: '/bin/sh', cwd: '/synthetic' }] });
      if (path === '/api/structured/sessions') return json([]);
      if (path === '/api/bookmarks') return json({ bookmarks: [] });
      if (path.endsWith('/input') && options.method === 'POST') return json({});
      if (path.startsWith(`/api/terminal/${sessionId}/`)) return json({});
      throw new Error(`Unlisted synthetic request: ${path}`);
    });
  });

  it.each(['sendToSession', 'navigateSession', 'executeBookmark'])('invalidates an existing Enter-only receipt before %s', async action => {
    const { result } = renderHook(() => ({ terminal: useTerminalSession(), bookmarks: useBookmarks() }), { wrapper });
    await waitFor(() => expect(result.current.terminal.loadingSessions).toBe(false));
    act(() => result.current.terminal.selectSession(sessionId));
    const lease = claimTerminalCommand(sessionId, 'echo original');
    lease.beforeSend(); lease.acceptText();
    await act(async () => {
      if (action === 'executeBookmark') await result.current.bookmarks.executeBookmark('echo bookmark');
      else await result.current.terminal[action](sessionId, action === 'navigateSession' ? '/synthetic/other' : 'context input');
    });
    expect(() => claimTerminalCommand(sessionId, 'echo original')).toThrow('replay is blocked');
    const commands = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/input')).map(([, options]) => JSON.parse(options.body).command);
    expect(commands).toEqual([action === 'executeBookmark' ? 'echo bookmark\r' : action === 'navigateSession' ? "cd -- '/synthetic/other'\r" : 'context input']);
  });
});
