import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('./FolderContext', () => ({
  useFolders: () => ({ recentFolders: [], addRecentFolder: vi.fn() })
}));

vi.mock('../utils/api', () => ({ apiFetch, apiGet: vi.fn() }));

function Consumer() {
  const { loadingSessions, sessions } = useTerminalSession();
  return (
    <>
      <span data-testid="loading-state">{loadingSessions ? 'loading' : 'idle'}</span>
      <span data-testid="session-ids">{sessions.map(session => session.id).join(',')}</span>
    </>
  );
}

const json = body => ({ ok: true, json: async () => body });
const isStateUrl = url => String(url).startsWith('/api/state');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const refreshNow = () => act(async () => { window.dispatchEvent(new Event('focus')); });

describe('TerminalSessionContext background refresh', () => {
  let errorLog;

  beforeEach(() => {
    apiFetch.mockReset();
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorLog.mockRestore();
  });

  it('keeps the initial load when a failed background refresh starts while it is pending', async () => {
    const initialTerminals = deferred();
    apiFetch.mockImplementation(async url => {
      if (url === '/api/terminal') return initialTerminals.promise;
      if (url === '/api/structured/sessions?view=inventory') return json([]);
      if (isStateUrl(url)) return { ok: false, status: 503 };
      throw new Error(`unexpected request ${url}`);
    });

    render(<TerminalSessionProvider><Consumer /></TerminalSessionProvider>);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/terminal'));
    await refreshNow();
    await act(async () => { initialTerminals.resolve(json({ sessions: [{ id: 'session-1', isActive: true }] })); });

    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('idle'));
    expect(screen.getByTestId('session-ids')).toHaveTextContent('session-1');
  });

  it('applies a slow background refresh even when later refreshes start before it returns', async () => {
    const stateResponses = [];
    let holdState = false;
    apiFetch.mockImplementation(async url => {
      if (url === '/api/terminal') return json({ sessions: [{ id: 'session-1', isActive: true }] });
      if (url === '/api/structured/sessions?view=inventory') return json([]);
      if (isStateUrl(url)) {
        if (!holdState) return json({ sessions: [{ id: 'session-1', isActive: true }] });
        const response = deferred();
        stateResponses.push(response);
        return response.promise;
      }
      throw new Error(`unexpected request ${url}`);
    });

    render(<TerminalSessionProvider><Consumer /></TerminalSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('loading-state')).toHaveTextContent('idle'));
    await waitFor(() => expect(screen.getByTestId('session-ids')).toHaveTextContent('session-1'));

    holdState = true;
    await refreshNow();
    await refreshNow();
    await waitFor(() => expect(stateResponses).toHaveLength(2));

    await act(async () => { stateResponses[0].resolve(json({ sessions: [{ id: 'session-from-first', isActive: true }] })); });
    await waitFor(() => expect(screen.getByTestId('session-ids')).toHaveTextContent('session-from-first'));

    await act(async () => { stateResponses[1].resolve(json({ sessions: [{ id: 'session-from-second', isActive: true }] })); });
    await waitFor(() => expect(screen.getByTestId('session-ids')).toHaveTextContent('session-from-second'));
  });

  it('does not let an older refresh overwrite a newer one that already applied', async () => {
    const stateResponses = [];
    let holdState = false;
    apiFetch.mockImplementation(async url => {
      if (url === '/api/terminal') return json({ sessions: [{ id: 'session-1', isActive: true }] });
      if (url === '/api/structured/sessions?view=inventory') return json([]);
      if (isStateUrl(url)) {
        if (!holdState) return json({ sessions: [{ id: 'session-1', isActive: true }] });
        const response = deferred();
        stateResponses.push(response);
        return response.promise;
      }
      throw new Error(`unexpected request ${url}`);
    });

    render(<TerminalSessionProvider><Consumer /></TerminalSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('session-ids')).toHaveTextContent('session-1'));

    holdState = true;
    await refreshNow();
    await refreshNow();
    await waitFor(() => expect(stateResponses).toHaveLength(2));

    await act(async () => { stateResponses[1].resolve(json({ sessions: [{ id: 'session-newer', isActive: true }] })); });
    await waitFor(() => expect(screen.getByTestId('session-ids')).toHaveTextContent('session-newer'));
    await act(async () => { stateResponses[0].resolve(json({ sessions: [{ id: 'session-older', isActive: true }] })); });
    expect(screen.getByTestId('session-ids')).toHaveTextContent('session-newer');
  });
});
