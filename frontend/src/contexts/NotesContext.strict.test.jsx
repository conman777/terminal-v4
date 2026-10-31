import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NotesProvider, useNotes } from './NotesContext';
import { NotesModal } from '../components/NotesModal';
import { apiFetch } from '../utils/api';

const fixture = vi.hoisted(() => ({ auth: null }));
vi.mock('./AuthContext', () => ({ useOptionalAuth: () => fixture.auth }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/strictAuthenticatedFetch', () => ({
  readStrictResponseMetadata: async response => ({ ok: response.ok, status: response.status }),
  validateStrictResponse: async () => {},
}));
vi.mock('../utils/remoteEnvironments', () => ({ getActiveEnvironment: () => null, subscribeEnvironment: () => () => {} }));
vi.mock('../utils/auth', () => ({ captureAuthScope: () => ({ userId: 'legacy-user' }), isAuthScopeCurrent: () => true, subscribeAuth: () => () => {} }));
beforeEach(() => { apiFetch.mockReset(); fixture.auth = { authLifecycle: null, strictReady: false, user: { id: 'account-a' } }; });
afterEach(cleanup);

it('shows the ownership review message from the session-bound API', async () => {
  const snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  fixture.auth = { authLifecycle: { read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() }, strictReady: true, user: snapshot.user };
  apiFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Note storage ownership is ambiguous. Administrator review is required.' }) });
  const { result } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
  expect(result.current.notesLoadError).toMatch(/ownership.*administrator/i);
});

it('loads and saves notes through the current strict authority', async () => {
  const snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ notes: [] }) })
    .mockResolvedValueOnce({ ok: true, status: 201 })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ notes: [{ id: 'note-a', title: 'title', content: 'draft', category: 'General' }] }) });
  const { result } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
  await act(async () => { await result.current.addNote('title', 'draft', 'General'); });
  expect(result.current.notes).toEqual([{ id: 'note-a', title: 'title', content: 'draft', category: 'General' }]);
  expect(apiFetch.mock.calls.map(([url, options]) => [url, options.method || 'GET', options.authLifecycle === lifecycle])).toEqual([
    ['/api/notes', 'GET', true], ['/api/notes', 'POST', true], ['/api/notes', 'GET', true],
  ]);
});

it('discards a delayed note list and refuses a replacement login', async () => {
  let snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  let finish;
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  snapshot = { ...snapshot, incarnation: 'inc-b', pair: { ...snapshot.pair, session: 'session-b' } };
  await act(async () => finish({ ok: true, status: 200, json: async () => ({ notes: [{ id: 'old', title: 'private' }] }) }));
  expect(result.current.notes).toEqual([]);
  await expect(result.current.addNote('title', 'draft', 'General')).rejects.toThrow(/secure|session|unavailable/i);
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('reports an unconfirmed save without loading under a replacement login', async () => {
  let snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ notes: [] }) })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addNote('title', 'draft', 'General'); });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  const completion = expect(pending).rejects.toThrow(/may have completed/i);
  snapshot = { ...snapshot, incarnation: 'inc-b', pair: { ...snapshot.pair, session: 'session-b' } };
  await act(async () => finish({ ok: true, status: 201 }));
  await completion;
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('hides another account’s notes and retains its draft until that account returns', async () => {
  const original = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  let snapshot = original;
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: original.user };
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ notes: [] }) });
  function Editor() {
    const value = useNotes();
    return <NotesModal isOpen notes={value.notes} onAdd={value.addNote} onUpdate={value.updateNote} onDelete={value.deleteNote} onClose={vi.fn()} loadStatus={value.notesLoadStatus} loadError={value.notesLoadError} onRetryLoad={value.reloadNotes} scopeKey={value.notesScopeKey} scopeHeld={value.notesScopeHeld} />;
  }
  const view = render(<NotesProvider><Editor /></NotesProvider>);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  await screen.findByRole('button', { name: 'New Note' });
  fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
  fireEvent.change(await screen.findByPlaceholderText('Untitled'), { target: { value: 'Private title' } });
  fireEvent.change(screen.getByPlaceholderText('Write something... (Markdown supported)'), { target: { value: 'Private draft' } });
  snapshot = { ...original, incarnation: 'inc-b', user: { id: 'account-b' }, pair: { ...original.pair, owner: 'account-b', session: 'session-b' } };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  view.rerender(<NotesProvider><Editor /></NotesProvider>);
  expect(screen.queryByDisplayValue('Private draft')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/original account/i);
  expect(screen.getByRole('dialog', { name: 'Notes' })).toHaveFocus();
  snapshot = original;
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: original.user };
  view.rerender(<NotesProvider><Editor /></NotesProvider>);
  expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('Private draft');
});

it('hides a retained draft when ownership becomes ambiguous and restores it after a successful review reload', async () => {
  const snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ notes: [] }) })
    .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Note storage ownership is ambiguous. Administrator review is required.' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ notes: [] }) });
  function Editor() {
    const value = useNotes();
    return <><button onClick={value.reloadNotes}>Refresh fixture</button><NotesModal isOpen notes={value.notes} onAdd={value.addNote} onUpdate={value.updateNote} onDelete={value.deleteNote} onClose={vi.fn()} loadStatus={value.notesLoadStatus} loadError={value.notesLoadError} onRetryLoad={value.reloadNotes} scopeKey={value.notesScopeKey} scopeHeld={value.notesScopeHeld} scopeHoldMessage={value.notesScopeHoldMessage} scopeHoldCanRetry={value.notesScopeHoldCanRetry} /></>;
  }
  render(<NotesProvider><Editor /></NotesProvider>);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
  fireEvent.change(await screen.findByPlaceholderText('Untitled'), { target: { value: 'Private title' } });
  fireEvent.change(screen.getByPlaceholderText('Write something... (Markdown supported)'), { target: { value: 'Private draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh fixture' }));
  await screen.findByText(/ownership.*administrator/i);
  expect(screen.queryByDisplayValue('Private draft')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading notes' }));
  await waitFor(() => expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('Private draft'));
});

it('blocks all strict requests and surfaces recovery without falling back to legacy credentials', async () => {
  const { result } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
  expect(result.current.notesLoadError).toMatch(/secure|session|unavailable/i);
  await act(async () => expect(result.current.reloadNotes()).resolves.toBe(false));
  await act(async () => expect(result.current.addNote('title', 'draft', 'General')).rejects.toThrow(/secure|session|unavailable/i));
  await act(async () => expect(result.current.updateNote('id', { content: 'draft' })).rejects.toThrow(/secure|session|unavailable/i));
  await act(async () => expect(result.current.deleteNote('id')).rejects.toThrow(/secure|session|unavailable/i));
  expect(apiFetch).not.toHaveBeenCalled();
});

it('retains a draft while hiding it across a strict account change', async () => {
  function Editor() {
    const value = useNotes();
    return <NotesModal isOpen notes={value.notes} onAdd={value.addNote} onUpdate={value.updateNote} onDelete={value.deleteNote} onClose={vi.fn()} loadStatus={value.notesLoadStatus} loadError={value.notesLoadError} onRetryLoad={value.reloadNotes} scopeKey={value.notesScopeKey} scopeHeld={value.notesScopeHeld} />;
  }
  const view = render(<NotesProvider><Editor /></NotesProvider>);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'New Note' }));
  fireEvent.change(await screen.findByPlaceholderText('Untitled'), { target: { value: 'Keep this title' } });
  fireEvent.change(screen.getByPlaceholderText('Write something... (Markdown supported)'), { target: { value: 'Keep this draft' } });
  fixture.auth = { authLifecycle: {}, strictReady: true, user: { id: 'account-b' } };
  view.rerender(<NotesProvider><Editor /></NotesProvider>);
  expect(screen.queryByDisplayValue('Keep this draft')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/original account/i);
  fixture.auth = { authLifecycle: null, strictReady: false, user: { id: 'account-a' } };
  view.rerender(<NotesProvider><Editor /></NotesProvider>);
  expect(screen.getByPlaceholderText('Untitled')).toHaveValue('Keep this title');
  expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('Keep this draft');
  const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/Could not save note/i);
  expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('Keep this draft');
  silence.mockRestore();
  expect(apiFetch).not.toHaveBeenCalled();
});

it('ignores a delayed legacy read after strict mode begins', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  fixture.auth = { authLifecycle: undefined, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true, json: async () => ({ notes: [{ id: 'old', title: 'Old', content: '', category: '' }] }) }));
  expect(result.current.notes).toEqual([]);
  expect(result.current.notesLoadStatus).toBe('error');
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('keeps strict mode closed if the authority property disappears', async () => {
  const { result, rerender } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
  const scopeKey = result.current.notesScopeKey;
  fixture.auth = { user: { id: 'account-a' } };
  rerender();
  await act(async () => expect(result.current.reloadNotes()).resolves.toBe(false));
  await expect(result.current.addNote('title', 'draft', 'General')).rejects.toThrow(/secure|session|unavailable/i);
  expect(result.current.notesScopeKey).toBe(scopeKey);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('reports an uncertain old save instead of retrying after strict mode begins', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ notes: [] }) })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addNote('title', 'draft', 'General'); });
  const completion = expect(pending).rejects.toThrow(/may have|unconfirmed/i);
  fixture.auth = { authLifecycle: undefined, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true }));
  await completion;
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('reports an already dispatched save when strict mode begins during its reload', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ notes: [] }) })
    .mockResolvedValueOnce({ ok: true })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useNotes, { wrapper: NotesProvider });
  await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addNote('title', 'draft', 'General'); });
  const completion = pending.then(() => '', error => error.message);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  fixture.auth = { authLifecycle: null, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true, json: async () => ({ notes: [] }) }));
  expect(await completion).toMatch(/may have|unconfirmed/i);
  expect(apiFetch).toHaveBeenCalledTimes(3);
});
