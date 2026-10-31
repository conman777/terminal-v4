import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { NotesProvider, useNotes } from './NotesContext';
import { BookmarkProvider, useBookmarks } from './BookmarkContext';
import { resolveHomeApiUrl } from '../utils/apiBase';

vi.mock('./TerminalSessionContext', () => ({ useTerminalSession: () => ({ activeSessionId: 'terminal-fixture' }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('loads notes and bookmarks with the validated strict provider', async () => {
  const home = new URL(resolveHomeApiUrl('/'), window.location.origin).href;
  const snapshot = { status: 'active', revision: 'revision-a', controlRevision: 'control-a', incarnation: 'incarnation-a', refreshReserved: false, user: { id: 'account-a', username: 'fixture' }, pair: { home, owner: 'account-a', session: 'session-a', accessToken: 'strict-token' } };
  const notifications = { subscribe: () => () => {}, publish: () => true };
  const lifecycle = { read: vi.fn(async () => snapshot), login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), recoverLogin: vi.fn(), resumeLogout: vi.fn(), recoverRetirements: vi.fn(), pendingLogins: vi.fn(), notifications };
  const strictAuth = { lifecycle, home, validateSession: async () => ({ status: 'valid' }), subscribe: notifications.subscribe };
  localStorage.setItem('terminal_access_token', 'legacy-fixture');
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/api/notes') ? { notes: [] } : { bookmarks: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  function Probe() {
    const auth = useAuth(), notes = useNotes(), bookmarks = useBookmarks();
    return <><output aria-label="strict ready">{String(auth.strictReady)}</output><output aria-label="notes status">{notes.notesLoadStatus}</output><output aria-label="bookmarks status">{bookmarks.bookmarksLoadStatus}</output></>;
  }
  function Workspace() {
    const auth = useAuth();
    return auth.user ? <NotesProvider><BookmarkProvider><Probe /></BookmarkProvider></NotesProvider> : <output aria-label="strict ready">false</output>;
  }
  render(<AuthProvider strictAuth={strictAuth}><Workspace /></AuthProvider>);
  await waitFor(() => expect(screen.getByLabelText('strict ready')).toHaveTextContent('true'));
  await waitFor(() => expect(screen.getByLabelText('notes status')).toHaveTextContent('ready'));
  await waitFor(() => expect(screen.getByLabelText('bookmarks status')).toHaveTextContent('ready'));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.map(([, options]) => new Headers(options.headers).get('authorization'))).toEqual(['Bearer strict-token', 'Bearer strict-token']);
  expect(localStorage.getItem('terminal_access_token')).toBe('legacy-fixture');
});

it('shows a strict bookmark ownership hold using the guarded response metadata', async () => {
  const home = new URL(resolveHomeApiUrl('/'), window.location.origin).href;
  const snapshot = { status: 'active', revision: 'revision-a', controlRevision: 'control-a', incarnation: 'incarnation-a', refreshReserved: false, user: { id: 'account-a', username: 'fixture' }, pair: { home, owner: 'account-a', session: 'session-a', accessToken: 'strict-token' } };
  const notifications = { subscribe: () => () => {}, publish: () => true };
  const lifecycle = { read: vi.fn(async () => snapshot), login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), recoverLogin: vi.fn(), resumeLogout: vi.fn(), recoverRetirements: vi.fn(), pendingLogins: vi.fn(), notifications };
  const strictAuth = { lifecycle, home, validateSession: async () => ({ status: 'valid' }), subscribe: notifications.subscribe };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' }), { status: 409, headers: { 'content-type': 'application/json' } }));
  function Probe() {
    const value = useBookmarks();
    return <><output aria-label="held">{String(value.bookmarksScopeHeld)}</output><output aria-label="message">{value.bookmarksScopeHoldMessage}</output></>;
  }
  function Workspace() {
    const auth = useAuth();
    return auth.user ? <BookmarkProvider><Probe /></BookmarkProvider> : null;
  }
  render(<AuthProvider strictAuth={strictAuth}><Workspace /></AuthProvider>);
  await waitFor(() => expect(screen.getByLabelText('held')).toHaveTextContent('true'));
  expect(screen.getByLabelText('message')).toHaveTextContent('Administrator review is required.');
});
