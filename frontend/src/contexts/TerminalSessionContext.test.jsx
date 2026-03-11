import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';

const { addRecentFolder, apiFetch } = vi.hoisted(() => ({
  addRecentFolder: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('./FolderContext', () => ({
  useFolders: () => ({
    recentFolders: [],
    addRecentFolder,
  })
}));

vi.mock('../utils/api', () => ({
  apiFetch,
  apiGet: vi.fn(),
}));

function TestConsumer() {
  const { loadingSessions, selectSession } = useTerminalSession();

  return (
    <>
      <span data-testid="loading-state">{loadingSessions ? 'loading' : 'idle'}</span>
      <button type="button" onClick={() => selectSession('session-2')}>
        switch
      </button>
    </>
  );
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

describe('TerminalSessionContext', () => {
  beforeEach(() => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
