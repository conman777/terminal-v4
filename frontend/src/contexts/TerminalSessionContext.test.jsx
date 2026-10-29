import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setEnvironmentIdentity, setActiveEnvironment, getEnvironmentStorage } from '../utils/remoteEnvironments';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';
import { reopenWorkspaceSession } from '../utils/workspaceNavigation';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setUser } from '../utils/auth';

const { addRecentFolder, apiFetch, recentFolders } = vi.hoisted(() => ({
  addRecentFolder: vi.fn(),
  apiFetch: vi.fn(),
  recentFolders: [],
}));

vi.mock('./FolderContext', () => ({
  useFolders: () => ({
    recentFolders,
    addRecentFolder,
  })
}));

vi.mock('../utils/api', () => ({
  apiFetch,
  apiGet: vi.fn(),
}));

function TestConsumer() {
  const { loadingSessions, projectInfo, selectSession, sessions, activeSessionId, createSession } = useTerminalSession();

  return (
    <>
      <span data-testid="loading-state">{loadingSessions ? 'loading' : 'idle'}</span>
      <span data-testid="project-cwd">{projectInfo?.cwd ?? 'none'}</span>
      <span data-testid="session-ids">{sessions.map((session) => session.id).join(',')}</span>
      <span data-testid="active-session-id">{activeSessionId}</span>
      <button type="button" onClick={() => createSession()}>create terminal</button>
      <button type="button" onClick={() => selectSession('session-2')}>
        switch
      </button>
    </>
  );
}

function TestStructuredSessionConsumer() {
  const { sessions, closeSession } = useTerminalSession();

  return (
    <>
      <span data-testid="session-ids">{sessions.map((session) => session.id).join(',')}</span>
      <button type="button" onClick={() => closeSession('ss-structured')}>
        close structured
      </button>
    </>
  );
}

function TestStructuredLifecycleConsumer() {
  const { sessions, createStructuredSession, renameSession, updateThreadMetadata } = useTerminalSession();
  const structuredSession = sessions.find((session) => session.id.startsWith('ss-'));

  return (
    <>
      <span data-testid="session-ids">{sessions.map((session) => session.id).join(',')}</span>
      <span data-testid="structured-title">{structuredSession?.title ?? 'none'}</span>
      <span data-testid="structured-topic">{structuredSession?.thread?.topic ?? 'none'}</span>
      <span data-testid="structured-pinned">{String(Boolean(structuredSession?.thread?.pinned))}</span>
      <button
        type="button"
        onClick={() => createStructuredSession({ provider: 'claude', title: 'Agent thread' })}
      >
        create structured
      </button>
      <button
        type="button"
        onClick={() => renameSession('ss-structured', 'Renamed thread')}
      >
        rename structured
      </button>
      <button
        type="button"
        onClick={() => updateThreadMetadata('ss-structured', { topic: 'Review Rust rewrite', pinned: true })}
      >
        update structured thread
      </button>
    </>
  );
}

function TestV4SessionConsumer() {
  const { sessions, createStructuredSession } = useTerminalSession();
  return <><span data-testid="v4-runtime">{sessions.find(session => session.id === 'ss-owned')?.runtime}</span>
    <button onClick={() => createStructuredSession({ cwd: '/synthetic/project', provider: 'openai-api', model: 'chosen-model', reasoning: 'high' })}>create owned V4</button></>;
}

function TestGitBranchesConsumer() {
  const { listSessionGitBranches } = useTerminalSession();

  return (
    <button
      type="button"
      onClick={() => listSessionGitBranches('session-404')}
    >
      load branches
    </button>
  );
}

function TestThreadStateConsumer() {
  const { sessionsGroupedByProject, pinnedSessions, archivedSessions } = useTerminalSession();

  return (
    <>
      <span data-testid="thread-group-count">{String(sessionsGroupedByProject.length)}</span>
      <span data-testid="pinned-count">{String(pinnedSessions.length)}</span>
      <span data-testid="archived-count">{String(archivedSessions.length)}</span>
      <span data-testid="thread-session-ids">
        {sessionsGroupedByProject.flatMap((group) => group.sessions.map((session) => session.id)).join(',')}
      </span>
    </>
  );
}

function TestStructuredInputConsumer() {
  const { sendToSession } = useTerminalSession();

  return (
    <button
      type="button"
      onClick={() => sendToSession('ss-structured', '\r')}
    >
      send structured input
    </button>
  );
}

function TestWorkspaceContextConsumer() {
  const { activeSessionId, loadingSessions, projectInfo, selectSession, createStructuredSession, sessions, sessionLoadError, retryLoadSessions } = useTerminalSession();
  return <>
    <span data-testid="workspace-error">{sessionLoadError || 'none'}</span>
    <button onClick={() => retryLoadSessions()}>reload workspace inventory</button>
    <span data-testid="workspace-loading">{loadingSessions ? 'loading' : 'idle'}</span>
    <span data-testid="workspace-session">{activeSessionId || 'none'}</span>
    <span data-testid="workspace-session-ids">{sessions.map(session => session.id).join(',')}</span>
    <pre data-testid="workspace-context">{JSON.stringify(projectInfo)}</pre>
    <button onClick={() => selectSession('ss-workspace-one')}>select workspace one</button>
    <button onClick={() => selectSession('ss-workspace-two')}>select workspace two</button>
    <button onClick={() => selectSession('session-1')}>select first terminal</button>
    <button onClick={() => selectSession('session-2')}>select second terminal</button>
    <button onClick={() => createStructuredSession({ provider: 'deepseek', cwd: '/requested/alias', model: 'fixture-model' })}>create workspace conversation</button>
  </>;
}

function structuredSnapshot(overrides = {}) {
  return {
    id: 'ss-structured',
    cwd: 'C:\\repo',
    provider: 'claude',
    title: 'Structured session',
    createdAt: '2026-04-05T09:01:00.000Z',
    updatedAt: '2026-04-05T09:02:00.000Z',
    thread: {
      topic: 'Structured session',
      topicAutoGenerated: true,
      pinned: false,
      archived: false,
      projectPath: 'C:\\repo',
      lastActivityAt: '2026-04-05T09:02:00.000Z'
    },
    events: [],
    ...overrides
  };
}

describe('TerminalSessionContext', () => {
  beforeEach(() => {
    recentFolders.splice(0, recentFolders.length);
    apiFetch.mockImplementation(async (url) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: true, title: 'Terminal 1' },
              { id: 'session-2', isActive: true, title: 'Terminal 2' }
            ]
          })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => []
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: true, title: 'Terminal 1' },
              { id: 'session-2', isActive: true, title: 'Terminal 2' }
            ]
          })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    setEnvironmentIdentity(null);
    setActiveEnvironment(null);
    vi.clearAllMocks();
  });

  it.each(['pointerdown', 'touchstart', 'wheel'])('refreshes inventory once when %s resumes activity after idle', async (eventName) => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    try {
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      apiFetch.mockClear();
      now += 31_000;
      await act(async () => {
        window.dispatchEvent(new Event(eventName));
        window.dispatchEvent(new Event(eventName));
      });
      expect(apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/state'))).toHaveLength(1);
      expect(apiFetch.mock.calls.filter(([url]) => url === '/api/structured/sessions?view=inventory')).toHaveLength(1);
    } finally {
      view.unmount();
      clock.mockRestore();
    }
  });

  it('coalesces mixed activity after idle and removes listeners on unmount', async () => {
    let now = 2_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    try {
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      apiFetch.mockClear();
      now += 31_000;
      await act(async () => {
        for (const type of ['touchstart', 'pointerdown', 'wheel', 'mousemove', 'keydown']) window.dispatchEvent(new Event(type));
      });
      expect(apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/state'))).toHaveLength(1);
      view.unmount();
      apiFetch.mockClear();
      now += 31_000;
      await act(async () => window.dispatchEvent(new Event('pointerdown')));
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      clock.mockRestore();
    }
  });

  it('ignores an idle-refresh response from an account that has since changed', async () => {
    let now = 3_000_000;
    let releaseInventory;
    let delayed = false;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation((url, options) => {
      if (delayed && url === '/api/structured/sessions?view=inventory') {
        return new Promise(resolve => { releaseInventory = () => resolve({ ok: true, json: async () => [structuredSnapshot({ id: 'ss-stale-account', title: 'Old account response' })] }); });
      }
      return original(url, options);
    });
    setUser({ id: 'fixture-account-a' });
    const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    try {
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      delayed = true;
      now += 31_000;
      act(() => window.dispatchEvent(new Event('pointerdown')));
      await waitFor(() => expect(releaseInventory).toBeTypeOf('function'));
      act(() => setUser({ id: 'fixture-account-b' }));
      await act(async () => { releaseInventory(); });
      expect(view.result.current.sessions.some(session => session.id === 'ss-stale-account')).toBe(false);
    } finally {
      view.unmount();
      clock.mockRestore();
    }
  });

  it('retains an inventory error until a delayed retry succeeds', async () => {
    const original = apiFetch.getMockImplementation();
    let mode = 'fail';
    let release;
    apiFetch.mockImplementation((url, options) => {
      if (url !== '/api/terminal') return original(url, options);
      if (mode === 'fail') return Promise.resolve({ ok: false, status: 503 });
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ sessions: [] }) }); });
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
      await waitFor(() => expect(result.current.sessionLoadError).toContain('503'));
      mode = 'hold';
      let pending;
      act(() => { pending = result.current.retryLoadSessions(); });
      await waitFor(() => expect(release).toBeTypeOf('function'));
      expect(result.current.sessionLoadError).toContain('503');
      await act(async () => { release(); await pending; });
      expect(result.current.sessionLoadError).toBeNull();
    } finally { log.mockRestore(); }
  });

  it('does not trigger a full session reload when selecting another active session', async () => {
    render(
      <TerminalSessionProvider>
        <TestConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading-state')).toHaveTextContent('idle');
    });

    const terminalLoadCallsBeforeSwitch = apiFetch.mock.calls.filter(([url]) => url === '/api/terminal').length;

    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading-state')).toHaveTextContent('idle');
    });

    const terminalLoadCallsAfterSwitch = apiFetch.mock.calls.filter(([url]) => url === '/api/terminal').length;
    expect(terminalLoadCallsAfterSwitch).toBe(terminalLoadCallsBeforeSwitch);
  });

  it('clears stale project info when the next selected session has no project metadata', async () => {
    localStorage.setItem('lastActiveSession', 'session-1');
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    try {
      apiFetch.mockImplementation(async (url) => {
        if (url === '/api/terminal') {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                { id: 'session-1', isActive: true, title: 'Terminal 1' },
                { id: 'session-2', isActive: true, title: 'Terminal 2' }
              ]
            })
          };
        }

        if (url === '/api/structured/sessions?view=inventory') {
          return {
            ok: true,
            json: async () => []
          };
        }

        if (url === '/api/state?sessionId=session-1') {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                { id: 'session-1', isActive: true, title: 'Terminal 1' },
                { id: 'session-2', isActive: true, title: 'Terminal 2' }
              ],
              projectInfo: { cwd: 'C:\\repo\\one' }
            })
          };
        }

        if (url === '/api/state?sessionId=session-2') {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                { id: 'session-1', isActive: true, title: 'Terminal 1' },
                { id: 'session-2', isActive: true, title: 'Terminal 2' }
              ],
              projectInfo: null
            })
          };
        }

        throw new Error(`Unexpected apiFetch call: ${url}`);
      });

      render(
        <TerminalSessionProvider>
          <TestConsumer />
        </TerminalSessionProvider>
      );

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('project-cwd')).toHaveTextContent('C:\\repo\\one');
      });

      await act(async () => {
        screen.getByRole('button', { name: 'switch' }).click();
      });

      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('project-cwd')).toHaveTextContent('none');
      });
    } finally {
      hasFocusSpy.mockRestore();
    }
  });

  it('restores an inactive saved session only once during startup', async () => {
    localStorage.setItem('lastActiveSession', 'session-1');

    apiFetch.mockImplementation(async (url) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: false, title: 'Terminal 1' }
            ]
          })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => []
        };
      }

      if (url === '/api/terminal/session-1/restore') {
        return {
          ok: true,
          json: async () => ({})
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: true, title: 'Terminal 1' }
            ]
          })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading-state')).toHaveTextContent('idle');
    });

    await waitFor(() => {
      const restoreCalls = apiFetch.mock.calls.filter(([url]) => url === '/api/terminal/session-1/restore');
      expect(restoreCalls).toHaveLength(1);
    });
  });

  it('treats missing git branches as unavailable instead of logging an error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    apiFetch.mockImplementation(async (url) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (url === '/api/terminal/session-404/git-branches') {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'Git branches not available for this terminal' })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestGitBranchesConsumer />
      </TerminalSessionProvider>
    );

    await act(async () => {
      screen.getByRole('button', { name: 'load branches' }).click();
    });

    expect(errorSpy).not.toHaveBeenCalledWith('Failed to list git branches', expect.anything());
    errorSpy.mockRestore();
  });

  it('uses metadata-only inventory for initial and recurring lifecycle updates', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let snapshot = structuredSnapshot({
      provider: 'codex', runtime: 'codex', status: 'cleanup_required', statusSeq: 42, latestSeq: 42,
      thread: { topic: 'Review inventory', pinned: true, archived: false, projectPath: 'C:\\repo' },
    });
    delete snapshot.events;
    apiFetch.mockImplementation(async url => {
      if (url === '/api/terminal' || String(url).startsWith('/api/state')) {
        return { ok: true, json: async () => ({ sessions: [] }) };
      }
      if (url === '/api/structured/sessions?view=inventory') {
        return { ok: true, json: async () => [snapshot] };
      }
      throw new Error('Unexpected inventory fixture route: ' + url);
    });

    try {
      const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      expect(view.result.current.sessions[0]).toMatchObject({
        id: 'ss-structured', runtime: 'codex', title: 'Structured session', status: 'cleanup_required', statusSeq: 42,
        thread: { topic: 'Review inventory', pinned: true, projectPath: 'C:\\repo' },
      });
      expect(view.result.current.sessions[0]).not.toHaveProperty('events');

      snapshot = { ...snapshot, status: 'idle', statusSeq: 43, latestSeq: 43 };
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(view.result.current.sessions[0]).toMatchObject({ status: 'idle', statusSeq: 43 }));

      expect(apiFetch.mock.calls.filter(([url]) => String(url).startsWith('/api/structured/sessions')).map(([url]) => url)).toEqual([
        '/api/structured/sessions?view=inventory', '/api/structured/sessions?view=inventory',
      ]);
    } finally { hasFocus.mockRestore(); }
  });

  it('merges structured sessions into the session inventory', async () => {
    apiFetch.mockImplementation(async (url) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: true, title: 'Terminal 1', updatedAt: '2026-04-05T09:00:00.000Z' }
            ]
          })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => ([
            structuredSnapshot()
          ])
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              { id: 'session-1', isActive: true, title: 'Terminal 1', updatedAt: '2026-04-05T09:00:00.000Z' }
            ]
          })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-ids')).toHaveTextContent('ss-structured,session-1');
    });
  });

  it('creates structured sessions through the structured API route with backend metadata', async () => {
    recentFolders.push('C:\\repo');
    let structuredSessions = [];

    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (url === '/api/structured/sessions?view=inventory' && !options.method) {
        return {
          ok: true,
          json: async () => structuredSessions
        };
      }

      if (url === '/api/structured/sessions' && options.method === 'POST') {
        const payload = JSON.parse(options.body);
        expect(payload).toEqual({
          cwd: 'C:\\repo',
          provider: 'claude',
          title: 'Agent thread'
        });

        structuredSessions = [
          structuredSnapshot({
            id: 'ss-created',
            title: 'Agent thread',
            thread: {
              topic: 'Agent thread',
              topicAutoGenerated: false,
              pinned: false,
              archived: false,
              projectPath: 'C:\\repo',
              lastActivityAt: '2026-04-05T09:03:00.000Z'
            },
            updatedAt: '2026-04-05T09:03:00.000Z'
          })
        ];

        return {
          ok: true,
          json: async () => structuredSessions[0]
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestStructuredLifecycleConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-ids')).toHaveTextContent('');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'create structured' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-ids')).toHaveTextContent('ss-created');
    });

    const createCalls = apiFetch.mock.calls.filter(
      ([url, options]) => url === '/api/structured/sessions' && options?.method === 'POST'
    );
    expect(createCalls).toHaveLength(1);
    expect(screen.getByTestId('structured-title')).toHaveTextContent('Agent thread');
    expect(screen.getByTestId('structured-topic')).toHaveTextContent('Agent thread');
  });

  it('creates owned V4 sessions with the chosen model and reasoning and preserves runtime metadata', async () => {
    let snapshot = null;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions' && options.method === 'POST') {
        snapshot = structuredSnapshot({ id: 'ss-owned', runtime: 'v4', provider: 'openai-api', model: 'chosen-model', reasoning: 'high' });
        return { ok: true, json: async () => snapshot };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => snapshot ? [snapshot] : [] };
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [] }) };
      if (String(url).startsWith('/api/state')) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    render(<TerminalSessionProvider><TestV4SessionConsumer /></TerminalSessionProvider>);
    await act(async () => { screen.getByRole('button', { name: 'create owned V4' }).click(); });
    const call = apiFetch.mock.calls.find(([url, options]) => url === '/api/structured/sessions' && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toEqual({ cwd: '/synthetic/project', provider: 'openai-api', model: 'chosen-model', reasoning: 'high' });
    await waitFor(() => expect(screen.getByTestId('v4-runtime')).toHaveTextContent('v4'));
  });

  it.each([
    ['applies', 200, 'gpt-5.6-sol · low', ''],
    ['rejects', 409, 'gpt-5.5 · high', 'This conversation is busy'],
  ])('%s a Codex model selection PATCH for the same session (%s)', async (_, status, expectedSelection, expectedError) => {
    const original = structuredSnapshot({ id: 'ss-codex', runtime: 'codex', provider: 'codex', model: 'gpt-5.5', reasoning: 'high' });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-codex/selection' && options.method === 'PATCH') {
        return status === 200
          ? { ok: true, status, json: async () => ({ ...original, model: 'gpt-5.6-sol', reasoning: 'low' }) }
          : { ok: false, status, json: async () => ({ error: 'busy' }) };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [original] };
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [] }) };
      if (String(url).startsWith('/api/state')) return { ok: true, json: async () => ({ sessions: [] }) };
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });
    function SelectionConsumer() {
      const { sessions, updateStructuredSessionSelection } = useTerminalSession();
      const session = sessions.find(item => item.id === 'ss-codex');
      const [error, setError] = useState('');
      return <>
        <span data-testid="codex-selection">{session ? `${session.model} · ${session.reasoning}` : 'none'}</span>
        <span data-testid="codex-selection-error">{error}</span>
        <button onClick={() => updateStructuredSessionSelection('ss-codex', { model: 'gpt-5.6-sol', reasoning: 'low' }).catch(failure => setError(failure.message))}>change codex model</button>
      </>;
    }
    render(<TerminalSessionProvider><SelectionConsumer /></TerminalSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('codex-selection')).toHaveTextContent('gpt-5.5 · high'));
    await act(async () => { screen.getByRole('button', { name: 'change codex model' }).click(); });
    const patchCall = apiFetch.mock.calls.find(([url]) => url === '/api/structured/sessions/ss-codex/selection');
    expect(JSON.parse(patchCall[1].body)).toEqual({ model: 'gpt-5.6-sol', reasoning: 'low' });
    await waitFor(() => expect(screen.getByTestId('codex-selection')).toHaveTextContent(expectedSelection));
    expect(screen.getByTestId('codex-selection-error').textContent).toContain(expectedError);
  });

  it('creates a Codex session with an explicit speed and maps the returned serviceTier', async () => {
    let snapshot = null;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions' && options.method === 'POST') {
        snapshot = structuredSnapshot({ id: 'ss-fast', runtime: 'codex', provider: 'codex', model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' });
        return { ok: true, json: async () => snapshot };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => snapshot ? [snapshot] : [] };
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    let session;
    await act(async () => { session = await result.current.createStructuredSession({ cwd: '/synthetic/project', provider: 'codex', model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' }); });
    const call = apiFetch.mock.calls.find(([url, options]) => url === '/api/structured/sessions' && options?.method === 'POST');
    expect(JSON.parse(call[1].body)).toEqual({ cwd: '/synthetic/project', provider: 'codex', model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' });
    expect(session.serviceTier).toBe('fast');
  });

  it('prepares a new conversation before selection and keeps the old selection if preparation fails', async () => {
    const snapshot = structuredSnapshot({ id: 'ss-image', runtime: 'v4', provider: 'openai-api', model: 'fixture-model' });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions' && options.method === 'POST') return { ok: true, json: async () => snapshot };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    const selectionBefore = result.current.activeSessionId;
    const prepareSession = vi.fn(() => { throw new Error('Draft storage unavailable'); });
    await act(async () => {
      await expect(result.current.createStructuredSession({ cwd: '/project', provider: 'openai-api', prepareSession })).rejects.toThrow('Draft storage unavailable');
    });
    expect(prepareSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'ss-image', runtime: 'v4' }));
    expect(result.current.activeSessionId).toBe(selectionBefore);
  });

  it('does not select a prepared conversation when its originating desktop is no longer current', async () => {
    const snapshot = structuredSnapshot({ id: 'ss-image', runtime: 'v4', provider: 'openai-api', model: 'fixture-model' });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions' && options.method === 'POST') return { ok: true, json: async () => snapshot };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    const selectionBefore = result.current.activeSessionId;
    await act(async () => {
      await result.current.createStructuredSession({ cwd: '/project', provider: 'openai-api', prepareSession: vi.fn(), shouldSelectSession: () => false });
    });
    expect(result.current.activeSessionId).toBe(selectionBefore);
  });

  it.each(['pending', 'wrong_request', 'wrong_snapshot'])('holds an unconfirmed durable image start: %s', async mode => {
    const requestId = '00000000-0000-4000-8000-000000000001';
    const snapshot = structuredSnapshot({ id: 'ss-image', cwd: '/canonical/project', runtime: 'v4', provider: 'openai-api', model: 'fixture-model' });
    const selection = { cwd: '/canonical/project', provider: 'openai-api', model: 'fixture-model' };
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/start-requests' && options.method === 'POST') return { ok: true, status: mode === 'pending' ? 202 : 200,
        json: async () => ({ status: mode === 'pending' ? 'pending' : 'created', requestId: mode === 'wrong_request' ? 'another' : requestId, selection, sessionId: 'ss-image' }) };
      if (url === '/api/structured/sessions/ss-image') return { ok: true, json: async () => mode === 'wrong_snapshot' ? { ...snapshot, cwd: '/other/project' } : snapshot };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    const before = result.current.activeSessionId, prepareSession = vi.fn();
    await act(async () => {
      await expect(result.current.createStructuredSession({ cwd: '/project-alias', provider: 'openai-api', model: 'fixture-model', startRequestId: requestId, prepareSession })).rejects.toThrow();
    });
    expect(prepareSession).not.toHaveBeenCalled();
    expect(result.current.activeSessionId).toBe(before);
    expect(apiFetch.mock.calls.some(([url, options]) => url === '/api/structured/sessions' && options?.method === 'POST')).toBe(false);
  });

  it.each([
    ['sends an explicit speed change', { serviceTier: 'ultrafast' }, { serviceTier: 'ultrafast' }],
    ['sends an explicit native default', { serviceTier: null }, { serviceTier: null }],
    ['omits speed so the saved tier is preserved', {}, {}],
  ])('%s in the selection PATCH', async (_, change, expectedTier) => {
    const original = structuredSnapshot({ id: 'ss-codex', runtime: 'codex', provider: 'codex', model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-codex/selection' && options.method === 'PATCH') {
        return { ok: true, json: async () => ({ ...original, ...JSON.parse(options.body) }) };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [original] };
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions[0]?.serviceTier).toBe('fast'));
    await act(async () => { await result.current.updateStructuredSessionSelection('ss-codex', { model: 'gpt-5.5', reasoning: 'low', ...change }); });
    const patchCall = apiFetch.mock.calls.find(([url]) => url === '/api/structured/sessions/ss-codex/selection');
    expect(JSON.parse(patchCall[1].body)).toEqual({ model: 'gpt-5.5', reasoning: 'low', ...expectedTier });
  });

  it('does not let an older inventory response revert a confirmed model change', async () => {
    const original = structuredSnapshot({ id: 'ss-codex', runtime: 'codex', provider: 'codex', model: 'old-model', reasoning: 'high' });
    let holdInventory = false;
    let releaseInventory;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-codex/selection' && options.method === 'PATCH') {
        return { ok: true, json: async () => ({ ...original, model: 'new-model', reasoning: 'medium' }) };
      }
      if (url === '/api/structured/sessions?view=inventory') {
        if (holdInventory) return new Promise(resolve => { releaseInventory = () => resolve({ ok: true, json: async () => [original] }); });
        return { ok: true, json: async () => [original] };
      }
      return { ok: true, json: async () => ({ sessions: [] }) };
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions[0]?.model).toBe('old-model'));
    let pending;
    await act(async () => { holdInventory = true; pending = result.current.retryLoadSessions(); });
    await waitFor(() => expect(releaseInventory).toBeTypeOf('function'));
    await act(async () => { await result.current.updateStructuredSessionSelection('ss-codex', { model: 'new-model', reasoning: 'medium' }); });
    await act(async () => { releaseInventory(); await pending; });
    expect(result.current.sessions[0].model).toBe('new-model');
  });

  it('renames structured sessions through the structured API route', async () => {
    let structuredSessions = [
      structuredSnapshot()
    ];

    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => structuredSessions
        };
      }

      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        expect(JSON.parse(options.body)).toEqual({ title: 'Renamed thread' });
        structuredSessions = [
          structuredSnapshot({
            title: 'Renamed thread',
            updatedAt: '2026-04-05T09:05:00.000Z',
            thread: {
              topic: 'Renamed thread',
              topicAutoGenerated: false,
              pinned: false,
              archived: false,
              projectPath: 'C:\\repo',
              lastActivityAt: '2026-04-05T09:05:00.000Z'
            }
          })
        ];

        return {
          ok: true,
          json: async () => structuredSessions[0]
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestStructuredLifecycleConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('structured-title')).toHaveTextContent('Structured session');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'rename structured' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('structured-title')).toHaveTextContent('Renamed thread');
    });

    const renameCalls = apiFetch.mock.calls.filter(
      ([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH'
    );
    expect(renameCalls).toHaveLength(1);
    expect(screen.getByTestId('structured-topic')).toHaveTextContent('Renamed thread');
  });

  it.each([
    ['renameSession', 'session-1', '/api/terminal/session-1', 'PATCH'],
    ['renameSession', 'ss-structured', '/api/structured/sessions/ss-structured', 'PATCH'],
    ['closeSession', 'session-1', '/api/terminal/session-1', 'DELETE'],
    ['closeSession', 'ss-structured', '/api/structured/sessions/ss-structured', 'DELETE'],
  ])('returns a non-rejecting failure for %s on %s and preserves inventory for retry', async (action, sessionId, endpoint, method) => {
    const originalFetch = apiFetch.getMockImplementation();
    const failure = new Error('Synthetic connection failure');
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === endpoint && options.method === method) throw failure;
      if (url === '/api/structured/sessions?view=inventory') return {ok: true, json: async () => [structuredSnapshot()]};
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {result} = renderHook(() => useTerminalSession(), {
        wrapper: ({children}) => <TerminalSessionProvider>{children}</TerminalSessionProvider>
      });
      await waitFor(() => expect(result.current.loadingSessions).toBe(false));
      const before = result.current.sessions;
      let outcome;
      await act(async () => { outcome = await result.current[action](sessionId, 'Retained draft'); });
      if (action === 'renameSession' && sessionId === 'ss-structured') {
        expect(outcome.ok).toBe(false);
        expect(outcome.error.message).toMatch(/may have been saved.*reload.*retry/i);
      } else {
        expect(outcome).toEqual({ok: false, error: failure});
      }
      expect(result.current.sessions).toEqual(before);
      expect(apiFetch.mock.calls.filter(([url, options]) => url === endpoint && options?.method === method)).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['renameSession', 'session-1', '/api/terminal/session-1', 'PATCH', 'Failed to rename session (403)'],
    ['renameSession', 'ss-structured', '/api/structured/sessions/ss-structured', 'PATCH', 'Failed to rename structured session (403). The title may have been saved. Reload the thread before retrying.'],
    ['closeSession', 'session-1', '/api/terminal/session-1', 'DELETE', 'Failed to close session (403)'],
    ['closeSession', 'ss-structured', '/api/structured/sessions/ss-structured', 'DELETE', 'Failed to close structured session (403)'],
  ])('keeps %s permission errors recoverable on %s', async (action, sessionId, endpoint, method, message) => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === endpoint && options.method === method) return {ok: false, status: 403};
      if (url === '/api/structured/sessions?view=inventory') return {ok: true, json: async () => [structuredSnapshot()]};
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const {result} = renderHook(() => useTerminalSession(), {
        wrapper: ({children}) => <TerminalSessionProvider>{children}</TerminalSessionProvider>
      });
      await waitFor(() => expect(result.current.loadingSessions).toBe(false));
      const before = result.current.sessions;
      let outcome;
      await act(async () => { outcome = await result.current[action](sessionId, 'Retained draft'); });
      expect(outcome).toEqual({ok: false, error: new Error(message)});
      expect(result.current.sessions).toEqual(before);
    } finally {
      log.mockRestore();
    }
  });

  it('warns that an unavailable structured rename may have been saved', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: false, status: 503 };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.loadingSessions).toBe(false));
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.ok).toBe(false);
      expect(outcome.error.message).toMatch(/may have been saved.*reload.*retry/i);
      expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it.each(['503', '408', '429', '418', 'transport failure', 'unreadable success', 'empty success', 'wrong session', 'wrong title'])('requires a fresh title and explicit review after a %s structured rename', async failureMode => {
    const originalFetch = apiFetch.getMockImplementation();
    let patchCount = 0, inventoryAvailable = true, title = 'Structured session';
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 1) {
          if (failureMode === 'transport failure') throw new Error('Synthetic connection loss');
          if (failureMode === 'unreadable success') return { ok: true, json: async () => { throw new Error('Synthetic truncated response'); } };
          if (failureMode === 'empty success') return { ok: true, json: async () => ({}) };
          if (failureMode === 'wrong session') return { ok: true, json: async () => structuredSnapshot({ id: 'ss-other', title: 'New title' }) };
          if (failureMode === 'wrong title') return { ok: true, json: async () => structuredSnapshot({ title: 'Different title' }) };
          return { ok: false, status: Number(failureMode) };
        }
        return { ok: true, json: async () => structuredSnapshot({ title: 'New title' }) };
      }
      if (url === '/api/structured/sessions?view=inventory') return inventoryAvailable
        ? { ok: true, json: async () => [structuredSnapshot({ title })] }
        : { ok: false, status: 503 };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toMatch(/may have been saved/i);
      inventoryAvailable = false;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toMatch(/reload.*before retry/i);
      expect(patchCount).toBe(1);
      inventoryAvailable = true;
      title = 'Changed on another device';
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toContain('Changed on another device');
      expect(outcome.error.message).toMatch(/review.*before saving/i);
      expect(apiFetch.mock.calls.filter(([url]) => url === '/api/structured/sessions?view=inventory').at(-1)[1]).toMatchObject({ cache: 'no-store' });
      expect(patchCount).toBe(1);
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome).toBeUndefined();
      expect(patchCount).toBe(2);
    } finally { log.mockRestore(); }
  });

  it.each([
    ['missing title', [{ id: 'ss-structured' }]],
    ['empty title', [structuredSnapshot({ title: '' })]],
    ['whitespace title', [structuredSnapshot({ title: '  ' })]],
    ['non-string title', [structuredSnapshot({ title: 123 })]],
    ['duplicate session', [structuredSnapshot(), structuredSnapshot({ title: 'Other title' })]],
  ])('keeps the uncertain rename held when recovery inventory has %s', async (_description, invalidInventory) => {
    const originalFetch = apiFetch.getMockImplementation();
    let inventory = [structuredSnapshot()];
    let patches = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        patches += 1;
        return { ok: false, status: 503 };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => inventory };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await act(async () => { await result.current.renameSession('ss-structured', 'New title'); });
      const marker = Object.keys(sessionStorage).find(key => key.includes('structuredRenameRecovery:'));
      inventory = invalidInventory;
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toMatch(/reload.*before retry/i);
      expect(sessionStorage.getItem(marker)).toBeTruthy();
      expect(patches).toBe(1);
      expect(apiFetch.mock.calls.filter(([url]) => url === '/api/structured/sessions?view=inventory').at(-1)[1]).toMatchObject({ cache: 'no-store' });
    } finally { log.mockRestore(); }
  });

  it('reviews the raw structured title even when terminal inventory has the same ID', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let terminalTitle = 'Stale terminal title';
    let patchCount = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        patchCount += 1;
        return patchCount === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => structuredSnapshot({ title: 'New title' }) };
      }
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [{ id: 'ss-structured', title: terminalTitle, updatedAt: '2099-01-01T00:00:00Z' }] }) };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ title: 'Authoritative title' })] };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.loadingSessions).toBe(false));
      await act(async () => { await result.current.renameSession('ss-structured', 'New title'); });
      terminalTitle = 'New title';
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toContain('Current title: “Authoritative title”');
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome).toBeUndefined();
      expect(patchCount).toBe(2);
    } finally { log.mockRestore(); }
  });

  it('updates only the structured row after a successful rename when a terminal shares its ID', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ title: 'New title' }) };
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [{ id: 'ss-structured', shell: 'synthetic-terminal', title: 'Terminal title', updatedAt: '2020-01-01T00:00:00Z' }] }) };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.filter(session => session.id === 'ss-structured')).toHaveLength(2));
    await act(async () => { await result.current.renameSession('ss-structured', 'New title'); });
    expect(result.current.sessions.map(session => ({ shell: session.shell, title: session.title }))).toEqual([
      { shell: 'claude', title: 'New title' },
      { shell: 'synthetic-terminal', title: 'Terminal title' },
    ]);
  });

  it.each(['topic', 'snooze', 'settlement', 'selection', 'lifecycle refresh', 'failed lifecycle refresh'])('keeps a same-ID terminal unchanged during structured %s', async action => {
    const originalFetch = apiFetch.getMockImplementation();
    const terminal = { id: 'ss-structured', shell: 'synthetic-terminal', title: 'Terminal title', updatedAt: '2020-01-01T00:00:00Z', thread: { topic: 'Terminal topic' }, threadLifecycle: { sentinel: true } };
    const lifecycle = { supported: true, snoozed: false, requiresAttention: false, settlementSupported: true, settled: true };
    let inventoryCount = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [terminal] }) };
      if (url === '/api/structured/sessions?view=inventory') {
        inventoryCount += 1;
        if (action === 'failed lifecycle refresh' && inventoryCount > 1) return { ok: false, status: 503 };
        return { ok: true, json: async () => [structuredSnapshot({ runtime: 'v4', status: 'idle', threadLifecycle: lifecycle })] };
      }
      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') return { ok: true, json: async () => action === 'snooze'
        ? { threadLifecycleVersion: 1, thread: { snooze: { untilMs: 123, afterSeq: 0 } } }
        : action === 'settlement' ? { threadSettlementVersion: 1, thread: { settlement: { afterSeq: 0, queueFingerprint: 'a'.repeat(64) } } }
          : { thread: { topic: 'Updated topic' } } };
      if (url === '/api/structured/sessions/ss-structured/selection' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ model: 'new-model' }) };
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ runtime: 'v4', title: 'New title' }) };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.filter(session => session.id === 'ss-structured')).toHaveLength(2));
    await act(async () => {
      if (action === 'topic') await result.current.updateThreadMetadata('ss-structured', { topic: 'Updated topic' });
      else if (action === 'snooze') await result.current.updateThreadMetadata('ss-structured', { snoozeForSeconds: 3600 });
      else if (action === 'settlement') await result.current.updateThreadMetadata('ss-structured', { settled: true });
      else if (action === 'selection') await result.current.updateStructuredSessionSelection('ss-structured', { model: 'new-model' });
      else await result.current.renameSession('ss-structured', 'New title');
    });
    if (action.includes('lifecycle refresh')) await waitFor(() => expect(inventoryCount).toBeGreaterThan(1));
    expect(result.current.sessions.find(session => session.shell === 'synthetic-terminal')).toEqual(terminal);
  });

  it('rejects an over-80-byte structured title before sending or creating a recovery marker', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ title: '😀'.repeat(20) }) };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    let outcome;
    await act(async () => { outcome = await result.current.renameSession('ss-structured', '😀'.repeat(21)); });
    expect(outcome.error.message).toMatch(/80 UTF-8 bytes/i);
    expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH')).toHaveLength(0);
    expect(Object.keys(sessionStorage).filter(key => key.includes('structuredRenameRecovery:'))).toHaveLength(0);
    await act(async () => { outcome = await result.current.renameSession('ss-structured', '😀'.repeat(20)); });
    expect(outcome).toBeUndefined();
    expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH')).toHaveLength(1);
  });

  it('preserves a title whose 60th character is an emoji and rejects malformed or overlong titles', async () => {
    const title = `${'a'.repeat(59)}😀`;
    const originalFetch = apiFetch.getMockImplementation();
    const titles = [];
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        titles.push(JSON.parse(options.body).title);
        return { ok: true, json: async () => structuredSnapshot({ title }) };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    let outcome;
    await act(async () => { outcome = await result.current.renameSession('ss-structured', title); });
    expect(outcome).toBeUndefined();
    expect(titles).toEqual([title]);
    await act(async () => { outcome = await result.current.renameSession('ss-structured', 'a'.repeat(61)); });
    expect(outcome.error.message).toMatch(/60 characters/i);
    await act(async () => { outcome = await result.current.renameSession('ss-structured', '\ud83d'); });
    expect(outcome.error.message).toMatch(/valid Unicode/i);
    expect(titles).toEqual([title]);
  });

  it.each(['environment', 'account'])('rejects a delayed structured rename after switching %s without updating the new scope', async switchType => {
    const originalFetch = apiFetch.getMockImplementation();
    let completeRename;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return new Promise(resolve => { completeRename = resolve; });
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let pending;
    act(() => { pending = result.current.renameSession('ss-structured', 'Old environment title'); });
    await waitFor(() => expect(completeRename).toBeTypeOf('function'));
    act(() => switchType === 'environment' ? setActiveEnvironment({ id: 'different-environment' }) : setUser({ id: 'different-owner' }));
    let outcome;
    await act(async () => { completeRename({ ok: true, json: async () => structuredSnapshot({ title: 'Old environment title' }) }); outcome = await pending; });
    expect(outcome?.ok).toBe(false);
    expect(outcome.error.message).toMatch(/environment|account/i);
    expect(result.current.sessions.find(session => session.id === 'ss-structured')?.title).not.toBe('Old environment title');
  });

  it('does not apply an uncertain-rename refresh after the account changes', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let holdInventory = false, releaseInventory;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: false, status: 503 };
      if (url === '/api/structured/sessions?view=inventory') {
        if (holdInventory) return new Promise(resolve => { releaseInventory = resolve; });
        return { ok: true, json: async () => [structuredSnapshot()] };
      }
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await act(async () => { await result.current.renameSession('ss-structured', 'New title'); });
      holdInventory = true;
      let pending;
      act(() => { pending = result.current.renameSession('ss-structured', 'New title'); });
      await waitFor(() => expect(releaseInventory).toBeTypeOf('function'));
      act(() => setUser({ id: 'different-owner' }));
      let outcome;
      await act(async () => { releaseInventory({ ok: true, json: async () => [structuredSnapshot({ title: 'Previous owner title' })] }); outcome = await pending; });
      expect(outcome?.ok).toBe(false);
      expect(result.current.sessions.find(session => session.id === 'ss-structured')?.title).not.toBe('Previous owner title');
    } finally { log.mockRestore(); }
  });

  it('retains a pre-send rename marker across provider remount and requires fresh review', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let finishRename, patchCount = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        patchCount += 1;
        return new Promise(resolve => { finishRename = resolve; });
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ title: 'Current server title' })] };
      return originalFetch(url, options);
    });
    const wrapper = ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider>;
    const first = renderHook(() => useTerminalSession(), { wrapper });
    await waitFor(() => expect(first.result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let pending;
    act(() => { pending = first.result.current.renameSession('ss-structured', 'Private new title'); });
    await waitFor(() => expect(finishRename).toBeTypeOf('function'));
    const markerKey = Object.keys(sessionStorage).find(key => key.includes('structuredRenameRecovery:'));
    expect(markerKey).toBeTruthy();
    expect(sessionStorage.getItem(markerKey)).not.toContain('Private new title');
    first.unmount();
    const reopened = renderHook(() => useTerminalSession(), { wrapper });
    await waitFor(() => expect(reopened.result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let outcome;
    await act(async () => { outcome = await reopened.result.current.renameSession('ss-structured', 'Private new title'); });
    expect(outcome.error.message).toMatch(/in progress/i);
    expect(patchCount).toBe(1);
    await act(async () => { finishRename({ ok: false, status: 503 }); await pending; });
    await act(async () => { outcome = await reopened.result.current.renameSession('ss-structured', 'Private new title'); });
    expect(outcome.error.message).toContain('Current server title');
    expect(outcome.error.message).toMatch(/may still finish/i);
    expect(patchCount).toBe(1);
    expect(sessionStorage.getItem(markerKey)).toBeNull();
  });

  it('does not send a title change when its recovery marker cannot be saved', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const originalSetItem = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('structuredRenameRecovery:')) throw new Error('storage unavailable');
      return originalSetItem.call(this, key, value);
    });
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toMatch(/title.*storage/i);
      expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH')).toHaveLength(0);
    } finally { storage.mockRestore(); }
  });

  it('preserves a corrupt title recovery marker and refuses to send another rename', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: false, status: 503 };
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await act(async () => { await result.current.renameSession('ss-structured', 'New title'); });
      const key = Object.keys(sessionStorage).find(value => value.includes('structuredRenameRecovery:'));
      sessionStorage.setItem(key, 'corrupt');
      let outcome;
      await act(async () => { outcome = await result.current.renameSession('ss-structured', 'New title'); });
      expect(outcome.error.message).toMatch(/title recovery storage.*invalid/i);
      expect(sessionStorage.getItem(key)).toBe('corrupt');
      expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/structured/sessions/ss-structured' && options?.method === 'PATCH')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  it.each(['accounts', 'environments'])('keeps title recovery separate for %s sharing the same session ID', async scope => {
    const originalFetch = apiFetch.getMockImplementation();
    let patchCount = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        patchCount += 1;
        return patchCount === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => structuredSnapshot({ title: 'Second owner title' }) };
      }
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot()] };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setUser({ id: 'owner-one' });
      setEnvironmentIdentity('owner-one', window.location.origin);
      const wrapper = ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider>;
      const first = renderHook(() => useTerminalSession(), { wrapper });
      await waitFor(() => expect(first.result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await act(async () => { await first.result.current.renameSession('ss-structured', 'First owner title'); });
      const firstKey = Object.keys(sessionStorage).find(value => value.includes('structuredRenameRecovery:'));
      first.unmount();
      if (scope === 'accounts') {
        setUser({ id: 'owner-two' });
        setEnvironmentIdentity('owner-two', window.location.origin);
      } else {
        setActiveEnvironment({ id: 'different-host' });
      }
      const second = renderHook(() => useTerminalSession(), { wrapper });
      await waitFor(() => expect(second.result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      let outcome;
      await act(async () => { outcome = await second.result.current.renameSession('ss-structured', 'Second owner title'); });
      expect(outcome).toBeUndefined();
      expect(patchCount).toBe(2);
      expect(sessionStorage.getItem(firstKey)).toBeTruthy();
    } finally { log.mockRestore(); }
  });

  it('updates structured thread metadata through the structured API route', async () => {
    let structuredSessions = [
      structuredSnapshot()
    ];

    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => structuredSessions
        };
      }

      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') {
        expect(JSON.parse(options.body)).toEqual({
          topic: 'Review Rust rewrite',
          pinned: true
        });

        const thread = {
          topic: 'Review Rust rewrite',
          topicAutoGenerated: false,
          pinned: true,
          archived: false,
          projectPath: 'C:\\repo',
          lastActivityAt: '2026-04-05T09:06:00.000Z'
        };
        structuredSessions = [
          structuredSnapshot({
            updatedAt: '2026-04-05T09:06:00.000Z',
            thread
          })
        ];

        return {
          ok: true,
          json: async () => ({ thread })
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestStructuredLifecycleConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('structured-topic')).toHaveTextContent('Structured session');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'update structured thread' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('structured-topic')).toHaveTextContent('Review Rust rewrite');
    });

    const threadUpdateCalls = apiFetch.mock.calls.filter(
      ([url, options]) => url === '/api/structured/sessions/ss-structured/thread' && options?.method === 'PATCH'
    );
    expect(threadUpdateCalls).toHaveLength(1);
    expect(screen.getByTestId('structured-pinned')).toHaveTextContent('true');
  });

  it('requires a compatible server to confirm a snooze before changing the local thread state', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let compatible = false;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ threadLifecycle: { supported: true, snoozed: compatible, requiresAttention: false, ...(compatible ? { snoozedUntilMs: 123456 } : {}) } })] };
      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') return { ok: true, json: async () => compatible
        ? { threadLifecycleVersion: 1, thread: { snooze: { untilMs: 123456, afterSeq: 0 } } }
        : { thread: {} } };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await expect(act(async () => { await result.current.updateThreadMetadata('ss-structured', { snoozeForSeconds: 3600 }); })).rejects.toThrow('could not confirm');
      expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle.snoozed).toBe(false);
      compatible = true;
      await act(async () => { await result.current.updateThreadMetadata('ss-structured', { snoozeForSeconds: 3600 }); });
      expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle).toMatchObject({ snoozed: true, snoozedUntilMs: 123456 });
    } finally { log.mockRestore(); }
  });

  it('requires explicit server confirmation before applying a settlement change', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let compatible = false;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ runtime: 'v4', status: 'idle', threadLifecycle: { supported: true, snoozed: false, settlementSupported: true, settled: compatible, canSettle: !compatible, requiresAttention: false } })] };
      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') return { ok: true, json: async () => compatible
        ? { threadSettlementVersion: 1, thread: { settlement: { afterSeq: 0, queueFingerprint: 'a'.repeat(64) } } }
        : { thread: {} } };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      await expect(act(async () => { await result.current.updateThreadMetadata('ss-structured', { settled: true }); })).rejects.toThrow('could not confirm');
      expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle.settled).toBe(false);
      compatible = true;
      await act(async () => { await result.current.updateThreadMetadata('ss-structured', { settled: true }); });
      expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle.settled).toBe(true);
    } finally { log.mockRestore(); }
  });

  it('refreshes the authoritative settlement after a thread rename', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    const lifecycle = { supported: true, snoozed: false, settlementSupported: true, settled: true, canSettle: false, requiresAttention: false };
    let title = 'Structured session';
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ runtime: 'v4', status: 'idle', title, threadLifecycle: lifecycle })] };
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') {
        title = 'Renamed thread';
        return { ok: true, json: async () => structuredSnapshot({ runtime: 'v4', status: 'idle', title }) };
      }
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    await act(async () => { await result.current.renameSession('ss-structured', 'Renamed thread'); });
    await waitFor(() => expect(result.current.sessions.find(session => session.id === 'ss-structured')).toMatchObject({ title: 'Renamed thread', threadLifecycle: { settled: true } }));
  });

  it('does not block a completed rename while its lifecycle refresh is still waiting', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    const lifecycle = { supported: true, snoozed: false, settlementSupported: true, settled: true, canSettle: false, requiresAttention: false };
    let inventoryCalls = 0, release;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') {
        if (++inventoryCalls > 1) return new Promise(resolve => { release = resolve; });
        return { ok: true, json: async () => [structuredSnapshot({ runtime: 'v4', status: 'idle', threadLifecycle: lifecycle })] };
      }
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ runtime: 'v4', status: 'idle', title: 'Renamed thread' }) };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let finished = false;
    act(() => { void result.current.renameSession('ss-structured', 'Renamed thread').then(() => { finished = true; }); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    try { await waitFor(() => expect(finished).toBe(true)); }
    finally { await act(async () => release({ ok: false, status: 503 })); }
  });

  it('does not keep a stale settled classification when the post-rename inventory is unavailable', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    const lifecycle = { supported: true, snoozed: false, settlementSupported: true, settled: true, canSettle: false, requiresAttention: false };
    let inventoryCalls = 0;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return ++inventoryCalls === 1
        ? { ok: true, json: async () => [structuredSnapshot({ runtime: 'v4', status: 'idle', threadLifecycle: lifecycle })] }
        : { ok: false, status: 503 };
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return { ok: true, json: async () => structuredSnapshot({ runtime: 'v4', status: 'idle', title: 'Renamed thread' }) };
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.find(session => session.id === 'ss-structured')?.threadLifecycle?.settled).toBe(true));
    await act(async () => { await result.current.renameSession('ss-structured', 'Renamed thread'); });
    await waitFor(() => expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle).toBeUndefined());
  });

  it('does not let a delayed rename restore a settled state after a newer request', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    const lifecycle = { supported: true, snoozed: false, settlementSupported: true, settled: true, canSettle: false, requiresAttention: false };
    let inventory = structuredSnapshot({ runtime: 'v4', status: 'idle', statusSeq: 1, threadLifecycle: lifecycle });
    let completeRename;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [inventory] };
      if (url === '/api/structured/sessions/ss-structured' && options.method === 'PATCH') return new Promise(resolve => { completeRename = resolve; });
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let pending;
    act(() => { pending = result.current.renameSession('ss-structured', 'Renamed thread'); });
    await waitFor(() => expect(completeRename).toBeTypeOf('function'));
    inventory = structuredSnapshot({ runtime: 'v4', status: 'running', statusSeq: 2, threadLifecycle: { ...lifecycle, settled: false, requiresAttention: true } });
    await act(async () => { await result.current.retryLoadSessions(); });
    await act(async () => { completeRename({ ok: true, json: async () => structuredSnapshot({ runtime: 'v4', status: 'idle', statusSeq: 1, title: 'Renamed thread' }) }); await pending; });
    expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle).toMatchObject({ settled: false, requiresAttention: true });
  });

  it('does not let a delayed snooze response hide a newer pending request', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let completePatch;
    let inventory = structuredSnapshot({ status: 'running', statusSeq: 1, threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } });
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [inventory] };
      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') return new Promise(resolve => { completePatch = resolve; });
      return originalFetch(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
    let pending;
    act(() => { pending = result.current.updateThreadMetadata('ss-structured', { snoozeForSeconds: 3600 }); });
    await waitFor(() => expect(completePatch).toBeTypeOf('function'));
    inventory = structuredSnapshot({ status: 'running', statusSeq: 2, threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } });
    await act(async () => { await result.current.retryLoadSessions(); });
    await act(async () => { completePatch({ ok: true, json: async () => ({ threadLifecycleVersion: 1, thread: { snooze: { untilMs: 123456, afterSeq: 1 } } }) }); await pending; });
    expect(result.current.sessions.find(session => session.id === 'ss-structured').threadLifecycle).toMatchObject({ snoozed: false, requiresAttention: true });
  });

  it('reports an unconfirmed refresh when a newer inventory request supersedes it and fails', async () => {
    const originalFetch = apiFetch.getMockImplementation();
    let inventoryCalls = 0;
    let finishSnoozeInventory;
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/structured/sessions?view=inventory') {
        inventoryCalls++;
        if (inventoryCalls === 2) return new Promise(resolve => { finishSnoozeInventory = resolve; });
        if (inventoryCalls === 3) return { ok: false, status: 503 };
        return { ok: true, json: async () => [structuredSnapshot({ status: 'idle', threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } })] };
      }
      if (url === '/api/structured/sessions/ss-structured/thread' && options.method === 'PATCH') return { ok: true, json: async () => ({ threadLifecycleVersion: 1, thread: { snooze: { untilMs: 123456, afterSeq: 0 } } }) };
      return originalFetch(url, options);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useTerminalSession(), { wrapper: ({ children }) => <TerminalSessionProvider>{children}</TerminalSessionProvider> });
      await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-structured')).toBe(true));
      let pending;
      act(() => { pending = result.current.updateThreadMetadata('ss-structured', { snoozeForSeconds: 3600 }); });
      await waitFor(() => expect(finishSnoozeInventory).toBeTypeOf('function'));
      await act(async () => { await result.current.retryLoadSessions(); });
      finishSnoozeInventory({ ok: true, json: async () => [structuredSnapshot({ status: 'idle', threadLifecycle: { supported: true, snoozed: true, requiresAttention: false, snoozedUntilMs: 123456 } })] });
      await expect(act(async () => { await pending; })).rejects.toThrow('newer refresh');
    } finally { log.mockRestore(); }
  });

  it('closes structured sessions through the structured API route', async () => {
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({
            sessions: []
          })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => ([
            structuredSnapshot()
          ])
        };
      }

      if (url === '/api/structured/sessions/ss-structured') {
        expect(options.method).toBe('DELETE');
        return {
          ok: true,
          status: 204,
          json: async () => ({})
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            sessions: []
          })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestStructuredSessionConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-ids')).toHaveTextContent('ss-structured');
    });

    await act(async () => {
      screen.getByRole('button', { name: 'close structured' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('session-ids')).toHaveTextContent('');
    });
  });

  it('routes structured raw input through the structured input endpoint without fallback messaging', async () => {
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => ([structuredSnapshot()])
        };
      }

      if (url === '/api/structured/sessions/ss-structured/input') {
        expect(options.method).toBe('POST');
        expect(options.body).toEqual({ text: '\r' });
        return {
          ok: true,
          status: 202,
          json: async () => ({ status: 'accepted' })
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({ sessions: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestStructuredInputConsumer />
      </TerminalSessionProvider>
    );

    await act(async () => {
      screen.getByRole('button', { name: 'send structured input' }).click();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/structured/sessions/ss-structured/input', {
      method: 'POST',
      body: { text: '\r' }
    });
  });

  it('never falls back to a conversation\'s drawer terminal as the selected session', async () => {
    const original = apiFetch.getMockImplementation();
    localStorage.removeItem('lastActiveSession');
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/terminal') return { ok: true, json: async () => ({ sessions: [
        { id: 'drawer', isActive: true, title: 'Terminal', thread: { companionOf: 'ss-chat' } },
        { id: 'shell', isActive: true, title: 'Project shell' },
      ] }) };
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.activeSessionId).toBe('shell'));
  });

  it('lets a per-turn agent such as Claude Code start a turn from a sent message, but not from a bare keystroke', async () => {
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ id: 'ss-claude-chat', provider: 'claude' })] };
      if (url === '/api/structured/sessions/ss-claude-chat/input') return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) };
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-claude-chat')).toBe(true));
    let receipt;
    await act(async () => { receipt = await result.current.sendToSession('ss-claude-chat', 'Reply OK'); });
    expect(receipt).toEqual({ accepted: true });
    await act(async () => { await result.current.sendToSession('ss-claude-chat', '\r'); });
    const bodies = apiFetch.mock.calls.filter(([url]) => url === '/api/structured/sessions/ss-claude-chat/input').map(([, options]) => options.body);
    expect(bodies).toEqual([{ text: 'Reply OK', fallbackToMessage: true }, { text: '\r' }]);
  });

  it('does not confirm a Claude message without an acceptance response', async () => {
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ id: 'ss-claude-chat', provider: 'claude' })] };
      if (url === '/api/structured/sessions/ss-claude-chat/input') return { ok: true, status: 202, json: async () => ({ status: 'unknown' }) };
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-claude-chat')).toBe(true));
    await expect(result.current.sendToSession('ss-claude-chat', 'Reply OK')).rejects.toThrow('could not be confirmed');
  });

  it('sends a new V4 conversation message with an idempotent request identity', async () => {
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ id: 'ss-owned-start', runtime: 'v4', provider: 'openai-api' })] };
      if (url === '/api/structured/sessions/ss-owned-start/input') return { ok: true, json: async () => ({ status: 'accepted', requestId: options.body.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1 }) };
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-owned-start')).toBe(true));
    let receipt;
    await act(async () => { receipt = await result.current.sendToSession('ss-owned-start', 'Inspect the project'); });
    const request = apiFetch.mock.calls.find(([url]) => url === '/api/structured/sessions/ss-owned-start/input');
    expect(request[1].body).toEqual({ text: 'Inspect the project', fallbackToMessage: true, requestId: expect.any(String) });
    expect(receipt).toEqual(expect.objectContaining({ accepted: true, requestId: request[1].body.requestId }));
  });

  it('does not confirm a V4 send after switching environments while its response is pending', async () => {
    const original = apiFetch.getMockImplementation();
    let finish;
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ id: 'ss-owned-stale', runtime: 'v4', provider: 'openai-api' })] };
      if (url === '/api/structured/sessions/ss-owned-stale/input') return new Promise(resolve => {
        finish = () => resolve({ ok: true, json: async () => ({ status: 'accepted', requestId: options.body.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1 }) });
      });
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-owned-stale')).toBe(true));
    const store = getComposerDraftStore('ss-owned-stale');
    store.setText('Keep this task');
    let pending;
    act(() => { pending = result.current.sendToSession('ss-owned-stale', 'Keep this task'); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'other-server', capabilities: { agentExecute: true, terminalInput: true } }));
    let receipt;
    await act(async () => { finish(); receipt = await pending; });
    expect(receipt).toEqual({ accepted: false, stale: true });
    expect(store.getSnapshot().text).toBe('Keep this task');
  });

  it('uses an acknowledged request identity for preview context sent to local Codex and preserves it after rejection', async () => {
    const original = apiFetch.getMockImplementation();
    let reject = true;
    apiFetch.mockImplementation(async (url, options) => {
      if (url === '/api/structured/sessions?view=inventory') return { ok: true, json: async () => [structuredSnapshot({ id: 'ss-codex-preview', provider: 'codex', runtime: 'codex' })] };
      if (url === '/api/structured/sessions/ss-codex-preview/input') return reject
        ? { ok: false, status: 409, json: async () => ({ error: 'Codex is working. Use Stop.' }) }
        : { ok: true, json: async () => ({ status: 'accepted', requestId: options.body.requestId, turnId: 'turn', messageId: 'message', acceptedSeq: 1 }) };
      return original(url, options);
    });
    const { result } = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
    await waitFor(() => expect(result.current.sessions.some(session => session.id === 'ss-codex-preview')).toBe(true));
    await expect(result.current.sendToSession('ss-codex-preview', 'Inspect this preview\r')).rejects.toThrow('Codex is working');
    reject = false;
    let receipt;
    await act(async () => { receipt = await result.current.sendToSession('ss-codex-preview', 'Inspect this preview\r'); });
    const requests = apiFetch.mock.calls.filter(([url]) => url === '/api/structured/sessions/ss-codex-preview/input');
    expect(requests.map(([, options]) => options.body)).toEqual([
      { text: 'Inspect this preview', fallbackToMessage: true, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
      requests[0][1].body,
    ]);
    expect(receipt).toEqual(expect.objectContaining({ accepted: true, requestId: requests[0][1].body.requestId }));
    expect(getComposerDraftStore('ss-codex-preview').getSnapshot().text).toBe('');
    act(() => getComposerDraftStore('ss-codex-preview').setText('Keep my own draft'));
    await act(async () => { await result.current.sendToSession('ss-codex-preview', 'Different preview context'); });
    expect(getComposerDraftStore('ss-codex-preview').getSnapshot().text).toBe('Keep my own draft');
  });

  it('keeps inactive persisted sessions visible in thread groupings after restart', async () => {
    apiFetch.mockImplementation(async (url) => {
      if (url === '/api/terminal') {
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                id: 'session-1',
                isActive: false,
                title: 'Saved thread',
                cwd: 'C:\\repo',
                updatedAt: '2026-03-12T08:00:00.000Z',
                thread: {
                  topic: 'Saved thread',
                  pinned: true,
                  archived: false,
                  projectPath: 'C:\\repo',
                  lastActivityAt: '2026-03-12T08:00:00.000Z'
                }
              },
              {
                id: 'session-2',
                isActive: false,
                title: 'Archived thread',
                cwd: 'C:\\repo',
                updatedAt: '2026-03-12T07:00:00.000Z',
                thread: {
                  topic: 'Archived thread',
                  pinned: false,
                  archived: true,
                  projectPath: 'C:\\repo',
                  lastActivityAt: '2026-03-12T07:00:00.000Z'
                }
              }
            ]
          })
        };
      }

      if (url === '/api/structured/sessions?view=inventory') {
        return {
          ok: true,
          json: async () => []
        };
      }

      if (String(url).startsWith('/api/state')) {
        return {
          ok: true,
          json: async () => ({
            sessions: []
          })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <TerminalSessionProvider>
        <TestThreadStateConsumer />
      </TerminalSessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('thread-group-count')).toHaveTextContent('1');
    });

    expect(screen.getByTestId('pinned-count')).toHaveTextContent('1');
    expect(screen.getByTestId('archived-count')).toHaveTextContent('1');
    expect(screen.getByTestId('thread-session-ids')).toHaveTextContent('session-1');
  });
  it('keeps the selected remote session through an offline reload instead of deleting it after a failed list request', async () => {
    setEnvironmentIdentity('alice');
    setActiveEnvironment({ id: 'remote-host' });
    const storage = getEnvironmentStorage();
    storage.setItem('lastActiveSession', 'selected-remote-session');
    apiFetch.mockRejectedValue(new TypeError('Network unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<TerminalSessionProvider><TestConsumer /></TerminalSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('idle'));
    expect([screen.getByTestId('active-session-id').textContent, storage.getItem('lastActiveSession')])
      .toEqual(['selected-remote-session', 'selected-remote-session']);
    unmount();
    log.mockRestore();
  });
  it('persists a newly created terminal as the selected session within its owner and environment', async () => {
    setEnvironmentIdentity('alice');
    setActiveEnvironment({ id: 'remote-host', capabilities: { terminalInput: true } });
    const original = apiFetch.getMockImplementation();
    apiFetch.mockImplementation((url, options) => options?.method === 'POST' && url === '/api/terminal'
      ? Promise.resolve({ ok: true, json: async () => ({ session: { id: 'created-terminal', isActive: true } }) })
      : original(url, options));
    render(<TerminalSessionProvider><TestConsumer /></TerminalSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('idle'));
    await act(async () => screen.getByRole('button', { name: 'create terminal' }).click());
    expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe('created-terminal');
  });

  it('blocks creating and sending to remote sessions without explicit capabilities', async () => {
    setActiveEnvironment({id:'observer',label:'Observer host',capabilities:{}});
    let api;
    function PermissionsConsumer(){api=useTerminalSession();return null;}
    render(<TerminalSessionProvider><PermissionsConsumer /></TerminalSessionProvider>);
    await waitFor(()=>expect(api.loadingSessions).toBe(false));
    await expect(api.createSession()).rejects.toThrow('does not allow');
    await expect(api.createStructuredSession({cwd:'/work',provider:'claude'})).rejects.toThrow('does not allow');
    const sender=vi.fn();api.registerTerminalSender('session-1',sender);
    await api.sendToSession('session-1','echo blocked');
    await api.sendToSession('ss-structured','blocked');
    expect(sender).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([]);
  });

  it('rejects stale creation and input callbacks after switching environments', async () => {
    let api;
    function PermissionsConsumer(){api=useTerminalSession();return null;}
    render(<TerminalSessionProvider><PermissionsConsumer /></TerminalSessionProvider>);
    await waitFor(()=>expect(api.loadingSessions).toBe(false));
    const previous=api;
    setActiveEnvironment({id:'new-host',capabilities:{terminalInput:true,agentExecute:true}});
    await expect(previous.createSession()).rejects.toThrow('environment changed');
    await previous.sendToSession('session-1','must not reach new host');
    expect(apiFetch.mock.calls.filter(([,options])=>options?.method==='POST')).toEqual([]);
  });


  describe('selected workspace context', () => {
    const terminals = [
      { id: 'session-1', isActive: true, cwd: '/pty/unrelated', thread: { projectPath: '/pty/unrelated' } },
      { id: 'session-2', isActive: true, cwd: '/pty/second', thread: { projectPath: '/pty/second' } },
    ];
    const owned = (id = 'ss-workspace-one', cwd = '/canonical/one') => structuredSnapshot({
      id, cwd, runtime: 'v4', provider: 'deepseek',
      thread: { projectPath: '/editable/sidebar-group', lastActivityAt: '2026-04-05T09:02:00.000Z' },
    });
    const workspaceInfo = () => JSON.parse(screen.getByTestId('workspace-context').textContent);
    const renderWorkspace = () => render(<TerminalSessionProvider><TestWorkspaceContextConsumer /></TerminalSessionProvider>);
    const focusPoll = async () => { await act(async () => { window.dispatchEvent(new Event('focus')); }); };
    const json = value => ({ ok: true, json: async () => value });
    function inventory(snapshots, stateInfo = null) {
      apiFetch.mockImplementation(async url => {
        if (url === '/api/terminal') return json({ sessions: terminals });
        if (url === '/api/structured/sessions?view=inventory') return json(snapshots);
        if (String(url).startsWith('/api/state')) return json({ sessions: terminals, projectInfo: stateInfo });
        throw new Error('Unexpected workspace fixture route: ' + url);
      });
    }

    it('uses the canonical created structured cwd before its inventory reload completes', async () => {
      let snapshots = [], reload = false, releaseReload;
      apiFetch.mockImplementation(async (url, options = {}) => {
        if (url === '/api/terminal') return reload ? new Promise(resolve => { releaseReload = () => resolve(json({ sessions: terminals })); }) : json({ sessions: terminals });
        if (url === '/api/structured/sessions' && options.method === 'POST') { snapshots = [owned('ss-created-workspace', '/canonical/created')]; reload = true; return json(snapshots[0]); }
        if (url === '/api/structured/sessions?view=inventory') return json(snapshots);
        if (String(url).startsWith('/api/state')) return json({ sessions: terminals, projectInfo: null });
        throw new Error('Unexpected workspace fixture route: ' + url);
      });
      renderWorkspace();
      await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
      await act(async () => { screen.getByRole('button', { name: 'create workspace conversation' }).click(); });
      try {
        expect(screen.getByTestId('workspace-session')).toHaveTextContent('ss-created-workspace');
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/created', projectType: 'unknown' });
      } finally { await act(async () => { releaseReload?.(); }); }
    });

    it('restores the selected structured cwd from mixed inventory without borrowing PTY metadata', async () => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      inventory([owned()]);
      renderWorkspace();
      await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
      expect(screen.getByTestId('workspace-session')).toHaveTextContent('ss-workspace-one');
      expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/one', projectType: 'unknown' });
      expect(workspaceInfo().gitBranch).toBeUndefined();
      expect(workspaceInfo().startCommand).toBeUndefined();
    });

    it('switches structured workspaces immediately and survives unrelated null PTY polls', async () => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      inventory([owned(), owned('ss-workspace-two', '/canonical/two')]);
      try {
        renderWorkspace();
        await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
        await act(async () => { screen.getByRole('button', { name: 'select workspace two' }).click(); });
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/two', projectType: 'unknown' });
        await focusPoll();
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/two', projectType: 'unknown' });
        await act(async () => { screen.getByRole('button', { name: 'select workspace one' }).click(); });
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/one', projectType: 'unknown' });
      } finally { hasFocus.mockRestore(); }
    });

    it('fences a late PTY project response after the selected session becomes structured', async () => {
      localStorage.setItem('lastActiveSession', 'session-1');
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      let releaseState;
      inventory([owned()]);
      const existing = apiFetch.getMockImplementation();
      apiFetch.mockImplementation(async url => url === '/api/state?sessionId=session-1'
        ? new Promise(resolve => { releaseState = () => resolve(json({ sessions: terminals, projectInfo: { cwd: '/pty/unrelated', gitBranch: 'unrelated-branch', projectType: 'node', projectName: 'Unrelated app', startCommand: 'fixture-only-command' } })); })
        : existing(url));
      try {
        renderWorkspace();
        await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
        await focusPoll();
        expect(releaseState).toBeTypeOf('function');
        await act(async () => { screen.getByRole('button', { name: 'select workspace one' }).click(); releaseState(); });
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/one', projectType: 'unknown' });
        expect(workspaceInfo().gitBranch).toBeUndefined();
        expect(workspaceInfo().projectName).toBeUndefined();
        expect(workspaceInfo().startCommand).toBeUndefined();
      } finally { hasFocus.mockRestore(); }
    });

    it('does not carry a previous PTY branch or start command into a newly selected terminal', async () => {
      localStorage.setItem('lastActiveSession', 'session-1');
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      inventory([owned()], { cwd: '/pty/unrelated', gitBranch: 'unrelated-branch', projectType: 'node', startCommand: 'fixture-only-command' });
      try {
        renderWorkspace();
        await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
        await focusPoll();
        expect(workspaceInfo().gitBranch).toBe('unrelated-branch');
        await act(async () => { screen.getByRole('button', { name: 'select second terminal' }).click(); });
        expect(workspaceInfo()).toMatchObject({ cwd: '/pty/second', projectType: 'unknown' });
        expect(workspaceInfo().gitBranch).toBeUndefined();
        expect(workspaceInfo().startCommand).toBeUndefined();
      } finally { hasFocus.mockRestore(); }
    });

    it('rejects a late PTY response after an ABA selection and a newer response for the same session', async () => {
      localStorage.setItem('lastActiveSession', 'session-1');
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      let firstState = true, releaseOld;
      inventory([owned()]);
      const existing = apiFetch.getMockImplementation();
      apiFetch.mockImplementation(async url => {
        if (url === '/api/state?sessionId=session-1') {
          if (firstState) { firstState = false; return new Promise(resolve => { releaseOld = () => resolve(json({ sessions: terminals, projectInfo: { cwd: '/pty/unrelated', gitBranch: 'old-branch', projectType: 'node' } })); }); }
          return json({ sessions: terminals, projectInfo: { cwd: '/pty/unrelated', gitBranch: 'new-branch', projectType: 'node' } });
        }
        return existing(url);
      });
      try {
        renderWorkspace();
        await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
        await focusPoll();
        await act(async () => { screen.getByRole('button', { name: 'select second terminal' }).click(); });
        await act(async () => { screen.getByRole('button', { name: 'select first terminal' }).click(); });
        await focusPoll();
        expect(workspaceInfo().gitBranch).toBe('new-branch');
        await act(async () => { releaseOld(); });
        expect(workspaceInfo().gitBranch).toBe('new-branch');
      } finally { hasFocus.mockRestore(); }
    });

    it('does not let an older same-selection poll remove a structured snapshot loaded by a newer poll', async () => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      let snapshots = [owned()], firstState = true, releaseOld;
      apiFetch.mockImplementation(async url => {
        if (url === '/api/terminal') return json({ sessions: terminals });
        if (url === '/api/structured/sessions?view=inventory') return json(snapshots);
        if (url === '/api/state') {
          if (firstState) { firstState = false; return new Promise(resolve => { releaseOld = () => resolve(json({ sessions: terminals, projectInfo: null })); }); }
          return json({ sessions: terminals, projectInfo: null });
        }
        throw new Error('Unexpected workspace fixture route: ' + url);
      });
      try {
        renderWorkspace();
        await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
        await focusPoll();
        snapshots = [owned(), owned('ss-workspace-two', '/canonical/two')];
        await focusPoll();
        expect(screen.getByTestId('workspace-session-ids')).toHaveTextContent('ss-workspace-two');
        await act(async () => { releaseOld(); });
        expect(screen.getByTestId('workspace-session-ids')).toHaveTextContent('ss-workspace-two');
      } finally { hasFocus.mockRestore(); }
    });

    it.each(['pending', 'completed'])('ignores an obsolete inventory failure while the newer inventory is %s', async mode => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      let terminalCalls = 0, rejectOld, releaseNew;
      apiFetch.mockImplementation(async url => {
        if (url === '/api/terminal') return ++terminalCalls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : new Promise(resolve => { releaseNew = () => resolve(json({ sessions: terminals })); });
        if (url === '/api/structured/sessions?view=inventory') return json([owned()]);
        throw new Error('Unexpected workspace fixture route: ' + url);
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderWorkspace();
        await act(async () => { screen.getByRole('button', { name: 'reload workspace inventory' }).click(); });
        if (mode === 'completed') await act(async () => { releaseNew(); });
        await act(async () => { rejectOld(new Error('Synthetic obsolete inventory failure')); });
        expect(screen.getByTestId('workspace-error')).toHaveTextContent('none');
        expect(screen.getByTestId('workspace-loading')).toHaveTextContent(mode === 'pending' ? 'loading' : 'idle');
      } finally { await act(async () => { releaseNew?.(); });log.mockRestore(); }
    });

    it.each([false, true])('does not undo a later structured selection after inactive PTY restore settles with success=%s', async success => {
      localStorage.setItem('lastActiveSession', 'session-1');
      const inactive = [{ ...terminals[0], isActive: false }, terminals[1]];
      let releaseRestore;
      apiFetch.mockImplementation(async (url, options = {}) => {
        if (url === '/api/terminal') return json({ sessions: inactive });
        if (url === '/api/structured/sessions?view=inventory') return json([owned()]);
        if (url === '/api/terminal/session-1/restore') return new Promise(resolve => { releaseRestore = () => { if (success) inactive[0] = { ...inactive[0], isActive: true };resolve({ ok: success, status: success ? 200 : 503, json: async () => ({}) }); }; });
        if (String(url).startsWith('/api/state')) return json({ sessions: inactive, projectInfo: null });
        throw new Error('Unexpected workspace fixture route: ' + url);
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderWorkspace();
        await waitFor(() => expect(releaseRestore).toBeTypeOf('function'));
        await act(async () => { screen.getByRole('button', { name: 'select workspace one' }).click(); releaseRestore(); });
        expect(screen.getByTestId('workspace-session')).toHaveTextContent('ss-workspace-one');
        expect(workspaceInfo()).toMatchObject({ cwd: '/canonical/one', projectType: 'unknown' });
        expect(screen.getByTestId('workspace-session-ids')).toHaveTextContent('ss-workspace-one');
      } finally { log.mockRestore(); }
    });

    it.each(['B-first', 'C-first'])('lets the last requested history navigation win with real context tokens when completion order is %s', async order => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      const pending = new Map();
      const history = [...terminals, { id: 'session-b', isActive: false, cwd: '/history/b', thread: { projectPath: '/history/b' } }, { id: 'session-c', isActive: false, cwd: '/history/c', thread: { projectPath: '/history/c' } }];
      apiFetch.mockImplementation(async url => {
        if (url === '/api/terminal') return json({ sessions: history });
        if (url === '/api/structured/sessions?view=inventory') return json([owned()]);
        if (url.endsWith('/restore')) return new Promise(resolve => pending.set(url.includes('session-b') ? 'B' : 'C', () => resolve(json({}))));
        throw new Error('Unexpected history fixture route: ' + url);
      });
      const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      const addSessionToDesktop = vi.fn();
      const actions = { restoreSession: (...args) => view.result.current.restoreSession(...args), selectSession: (...args) => view.result.current.selectSession(...args), unarchiveSession: vi.fn(async () => {}), addSessionToDesktop, setPaneSession: vi.fn(), focusPane: vi.fn() };
      let b, c;
      act(() => { b = reopenWorkspaceSession('session-b', actions, 'pane');c = reopenWorkspaceSession('session-c', actions, 'pane'); });
      const first = order === 'B-first' ? 'B' : 'C', second = first === 'B' ? 'C' : 'B';
      await act(async () => { pending.get(first)();await (first === 'B' ? b : c); });
      await act(async () => { pending.get(second)();await (second === 'B' ? b : c); });
      expect(view.result.current.activeSessionId).toBe('session-c');
      expect(addSessionToDesktop.mock.calls).toEqual([['session-c']]);
    });

    it('an explicit selection of the already current session cancels an older pending history intent', async () => {
      localStorage.setItem('lastActiveSession', 'ss-workspace-one');
      let releaseRestore;
      inventory([owned()]);const existing = apiFetch.getMockImplementation();
      apiFetch.mockImplementation(async url => url === '/api/terminal/session-b/restore' ? new Promise(resolve => { releaseRestore = () => resolve(json({})); }) : existing(url));
      const view = renderHook(() => useTerminalSession(), { wrapper: TerminalSessionProvider });
      await waitFor(() => expect(view.result.current.loadingSessions).toBe(false));
      const addSessionToDesktop = vi.fn();
      let pending;
      act(() => { pending = reopenWorkspaceSession('session-b', { restoreSession: (...args) => view.result.current.restoreSession(...args), selectSession: (...args) => view.result.current.selectSession(...args), unarchiveSession: vi.fn(async () => {}), addSessionToDesktop, setPaneSession: vi.fn(), focusPane: vi.fn() }, 'pane'); });
      act(() => { view.result.current.selectSession('ss-workspace-one'); });
      await act(async () => { releaseRestore();await pending; });
      expect(view.result.current.activeSessionId).toBe('ss-workspace-one');
      expect(addSessionToDesktop).not.toHaveBeenCalled();
    });

    it('restores only the new owner and environment workspace after a provider remount', async () => {
      setEnvironmentIdentity('workspace-fixture-owner-one', 'https://workspace-home.invalid');
      getEnvironmentStorage().setItem('lastActiveSession', 'ss-workspace-one');
      inventory([owned()]);
      const first = renderWorkspace();
      await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
      first.unmount();
      setEnvironmentIdentity('workspace-fixture-owner-two', 'https://workspace-home.invalid');
      setActiveEnvironment({ id: 'workspace-fixture-host', capabilities: { agentExecute: true } });
      getEnvironmentStorage().setItem('lastActiveSession', 'ss-workspace-one');
      inventory([owned('ss-workspace-one', '/new-owner/remote-workspace')]);
      renderWorkspace();
      expect(workspaceInfo()).toBeNull();
      await waitFor(() => expect(screen.getByTestId('workspace-loading')).toHaveTextContent('idle'));
      expect(workspaceInfo()).toMatchObject({ cwd: '/new-owner/remote-workspace', projectType: 'unknown' });
    });
  });

});
