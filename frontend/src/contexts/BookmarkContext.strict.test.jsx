import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BookmarkProvider, useBookmarks } from './BookmarkContext';
import { BookmarkModal } from '../components/BookmarkModal';
import { apiFetch } from '../utils/api';

const fixture = vi.hoisted(() => ({ auth: null }));
vi.mock('./AuthContext', () => ({ useOptionalAuth: () => fixture.auth }));
vi.mock('./TerminalSessionContext', () => ({ useTerminalSession: () => ({ activeSessionId: 'terminal-fixture' }) }));
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/strictAuthenticatedFetch', () => ({
  readStrictResponseMetadata: async response => ({ ok: response.ok, status: response.status }),
  validateStrictResponse: async () => {},
}));
vi.mock('../utils/remoteEnvironments', () => ({ getActiveEnvironment: () => null, subscribeEnvironment: () => () => {} }));
vi.mock('../utils/auth', () => ({ captureAuthScope: () => ({ userId: 'legacy-user' }), isAuthScopeCurrent: () => true, subscribeAuth: () => () => {} }));
beforeEach(() => { apiFetch.mockReset(); fixture.auth = { authLifecycle: null, strictReady: false, user: { id: 'account-a' } }; });
afterEach(cleanup);

it('loads and saves bookmarks through the original strict session without enabling terminal execution', async () => {
  const snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ bookmarks: [] }) })
    .mockResolvedValueOnce({ ok: true, status: 201 })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ bookmarks: [{ id: 'b', name: 'Draft', command: 'echo draft', category: 'General' }] }) });
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  await act(async () => result.current.addBookmark('Draft', 'echo draft', 'General'));
  expect(result.current.bookmarks).toEqual([{ id: 'b', name: 'Draft', command: 'echo draft', category: 'General' }]);
  await expect(result.current.executeBookmark('echo draft')).rejects.toThrow(/secure|session|unavailable/i);
  expect(apiFetch.mock.calls.map(([url, options]) => [url, options.method || 'GET', options.authLifecycle === lifecycle])).toEqual([
    ['/api/bookmarks', 'GET', true], ['/api/bookmarks', 'POST', true], ['/api/bookmarks', 'GET', true],
  ]);
});

it('discards a delayed strict bookmark read and refuses a replacement login', async () => {
  let snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  let finish;
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  snapshot = { ...snapshot, incarnation: 'inc-b', pair: { ...snapshot.pair, session: 'session-b' } };
  await act(async () => finish({ ok: true, status: 200, json: async () => ({ bookmarks: [{ id: 'old', name: 'private', command: 'secret', category: 'General' }] }) }));
  expect(result.current.bookmarks).toEqual([]);
  await expect(result.current.addBookmark('Draft', 'echo draft', 'General')).rejects.toThrow(/secure|session|unavailable/i);
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('holds an already dispatched strict bookmark change if the session changes before confirmation', async () => {
  let snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ bookmarks: [] }) })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addBookmark('Draft', 'echo draft', 'General'); });
  const completion = pending.catch(value => value);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  snapshot = { ...snapshot, incarnation: 'inc-b', pair: { ...snapshot.pair, session: 'session-b' } };
  await act(async () => finish({ ok: true, status: 201 }));
  const error = await completion;
  expect([error.outcomeUncertain, apiFetch.mock.calls.length]).toEqual([true, 2]);
});

it('hides a strict bookmark draft on an account change and restores it when the original session returns', async () => {
  const original = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  let snapshot = original;
  const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: original.user };
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ bookmarks: [] }) }));
  function Editor() {
    const value = useBookmarks();
    return <BookmarkModal isOpen bookmarks={value.bookmarks} onAdd={value.addBookmark} onClose={vi.fn()}
      loadStatus={value.bookmarksLoadStatus} loadError={value.bookmarksLoadError} onRetryLoad={value.reloadBookmarks}
      scopeKey={value.bookmarksScopeKey} scopeHeld={value.bookmarksScopeHeld} scopeHoldMessage={value.bookmarksScopeHoldMessage} scopeHoldCanRetry={value.bookmarksScopeHoldCanRetry} />;
  }
  const view = render(<BookmarkProvider><Editor /></BookmarkProvider>);
  await screen.findByText(/No bookmarks yet/);
  fireEvent.click(screen.getByTitle('Add bookmark'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Private draft' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo private' } });
  snapshot = { ...original, incarnation: 'inc-b', user: { id: 'account-b' }, pair: { ...original.pair, owner: 'account-b', session: 'session-b' } };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  view.rerender(<BookmarkProvider><Editor /></BookmarkProvider>);
  expect(screen.queryByDisplayValue('Private draft')).not.toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/original account/i);
  expect(screen.queryByRole('button', { name: 'Retry loading bookmarks' })).not.toBeInTheDocument();
  snapshot = original;
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: original.user };
  view.rerender(<BookmarkProvider><Editor /></BookmarkProvider>);
  expect(screen.getByLabelText('Name')).toHaveValue('Private draft');
  expect(screen.getByLabelText('Command')).toHaveValue('echo private');
});

it('holds strict bookmarks on an ownership conflict without falling back to legacy requests', async () => {
  const snapshot = { status: 'active', incarnation: 'inc-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: 'http://localhost/', accessToken: 'token-a' } };
  const lifecycle = { read: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn() };
  fixture.auth = { authLifecycle: lifecycle, strictReady: true, user: snapshot.user };
  apiFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' }) });
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksScopeHeld).toBe(true));
  expect([result.current.bookmarks, result.current.bookmarksScopeHoldCanRetry]).toEqual([[], true]);
  expect(apiFetch.mock.calls.map(([, options]) => options.authLifecycle)).toEqual([lifecycle]);
});

it('hides an already loaded legacy account when strict mode selects a different account', async () => {
  fixture.auth = null;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [{ id: 'old', name: 'Private', command: 'secret', category: 'General' }] }) });
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  fixture.auth = { authLifecycle: {}, strictReady: true, user: { id: 'account-b' } };
  rerender();
  expect([result.current.bookmarksScopeHeld, result.current.bookmarks]).toEqual([true, []]);
});

it('blocks all strict requests including terminal input without using legacy credentials', async () => {
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('error'));
  expect(result.current.bookmarksLoadError).toMatch(/secure|session|unavailable/i);
  await act(async () => expect(result.current.reloadBookmarks()).resolves.toBe(false));
  await act(async () => expect(result.current.addBookmark('name', 'echo draft', 'General')).rejects.toThrow(/secure|session|unavailable/i));
  await act(async () => expect(result.current.updateBookmark('id', { command: 'draft' })).rejects.toThrow(/secure|session|unavailable/i));
  await act(async () => expect(result.current.deleteBookmark('id')).rejects.toThrow(/secure|session|unavailable/i));
  await act(async () => expect(result.current.executeBookmark('echo draft')).rejects.toThrow(/secure|session|unavailable/i));
  expect(apiFetch).not.toHaveBeenCalled();
});

it('keeps an editor draft visible across strict readiness and account changes', async () => {
  function Editor() {
    const value = useBookmarks();
    return <BookmarkModal isOpen bookmarks={value.bookmarks} onAdd={value.addBookmark} onUpdate={value.updateBookmark} onDelete={value.deleteBookmark} onExecute={value.executeBookmark} onClose={vi.fn()} loadStatus={value.bookmarksLoadStatus} loadError={value.bookmarksLoadError} onRetryLoad={value.reloadBookmarks} scopeKey={value.bookmarksScopeKey} />;
  }
  const view = render(<BookmarkProvider><Editor /></BookmarkProvider>);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByTitle('Add bookmark'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep this name' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo keep-draft' } });
  fixture.auth = { authLifecycle: {}, strictReady: true, user: { id: 'account-b' } };
  view.rerender(<BookmarkProvider><Editor /></BookmarkProvider>);
  expect(screen.getByLabelText('Name')).toHaveValue('Keep this name');
  expect(screen.getByLabelText('Command')).toHaveValue('echo keep-draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/Could not save bookmark/i);
  expect(screen.getByLabelText('Command')).toHaveValue('echo keep-draft');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('ignores a delayed legacy read after strict mode begins', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
  fixture.auth = { authLifecycle: undefined, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true, json: async () => ({ bookmarks: [{ id: 'old', name: 'Old', command: '', category: '' }] }) }));
  expect(result.current.bookmarks).toEqual([]);
  expect(result.current.bookmarksLoadStatus).toBe('error');
  expect(apiFetch).toHaveBeenCalledOnce();
});

it('keeps strict mode closed if the authority property disappears', async () => {
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('error'));
  const scopeKey = result.current.bookmarksScopeKey;
  fixture.auth = { user: { id: 'account-a' } };
  rerender();
  await act(async () => expect(result.current.reloadBookmarks()).resolves.toBe(false));
  await expect(result.current.executeBookmark('echo blocked')).rejects.toThrow(/secure|session|unavailable/i);
  expect(result.current.bookmarksScopeKey).toBe(scopeKey);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('reports an uncertain old terminal command after strict mode begins', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.executeBookmark('echo fixture'); });
  const completion = expect(pending).rejects.toThrow(/may have|unconfirmed/i);
  fixture.auth = { authLifecycle: undefined, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true }));
  await completion;
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('reports an uncertain old save after strict mode begins', async () => {
  fixture.auth = null;
  let fail;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addBookmark('name', 'echo fixture', 'General'); });
  const completion = pending.then(() => '', error => error.message);
  fixture.auth = { authLifecycle: null, strictReady: false };
  rerender();
  await act(async () => fail(new Error('Synthetic connection closed')));
  expect(await completion).toMatch(/may have|unconfirmed/i);
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('reports an already dispatched change when strict mode begins during its reload', async () => {
  fixture.auth = null;
  let finish;
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
    .mockResolvedValueOnce({ ok: true })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  let pending;
  act(() => { pending = result.current.addBookmark('name', 'echo fixture', 'General'); });
  const completion = pending.then(() => '', error => error.message);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  fixture.auth = { authLifecycle: null, strictReady: false };
  rerender();
  await act(async () => finish({ ok: true, json: async () => ({ bookmarks: [] }) }));
  expect(await completion).toMatch(/may have|unconfirmed/i);
  expect(apiFetch).toHaveBeenCalledTimes(3);
});
