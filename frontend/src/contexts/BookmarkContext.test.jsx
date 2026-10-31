import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookmarkProvider, useBookmarks } from './BookmarkContext';
import { apiFetch } from '../utils/api';
import { BookmarkModal } from '../components/BookmarkModal';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const scope = vi.hoisted(() => ({ environment: null, environmentListeners: new Set(), authEpoch: 0, authListeners: new Set() }));
vi.mock('../utils/remoteEnvironments', () => ({
  getActiveEnvironment: () => scope.environment,
  subscribeEnvironment: listener => { scope.environmentListeners.add(listener); return () => scope.environmentListeners.delete(listener); },
}));
vi.mock('../utils/auth', () => ({
  captureAuthScope: () => ({ epoch: scope.authEpoch }),
  isAuthScopeCurrent: captured => captured.epoch === scope.authEpoch,
  subscribeAuth: listener => { scope.authListeners.add(listener); return () => scope.authListeners.delete(listener); },
}));
beforeEach(() => { scope.environment = null; scope.authEpoch = 0; scope.environmentListeners.clear(); scope.authListeners.clear(); });
const session = vi.hoisted(() => ({ activeSessionId: 'session' }));
vi.mock('./TerminalSessionContext', () => ({ useTerminalSession: () => session }));
beforeEach(() => { session.activeSessionId = 'session'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('BookmarkProvider mutation errors', () => {
  it.each([
    ['addBookmark', ['Draft name', 'echo draft', 'General']],
    ['updateBookmark', ['alpha', { command: 'echo draft' }]],
    ['deleteBookmark', ['alpha']],
  ])('rejects failed %s requests so the editor can retain its draft', async (method, args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) }).mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    await act(async () => expect(result.current[method](...args)).rejects.toThrow('(500)'));
  });
});


describe('BookmarkProvider execution', () => {
  it.each([null, 'ss-synthetic'])('rejects a non-PTY session (%s) without sending terminal input', async (sessionId) => {
    session.activeSessionId = sessionId;
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ bookmarks: [] }) });
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    await expect(result.current.executeBookmark('echo synthetic')).rejects.toThrow(/terminal|PTY/);
    expect(apiFetch.mock.calls.map(([path]) => path)).toEqual(['/api/bookmarks']);
  });

  it('rejects HTTP input failures and allows a successful retry with the saved command', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    await expect(result.current.executeBookmark('echo synthetic')).rejects.toThrow('(403)');
    await expect(result.current.executeBookmark('echo synthetic')).resolves.toBeUndefined();
    expect(apiFetch.mock.calls.slice(1)).toEqual(Array(2).fill([
      '/api/terminal/session/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo synthetic\r' }) },
    ]));
  });
});


describe('BookmarkProvider load health and scope', () => {
  const row = { id: 'synthetic-row', name: 'Synthetic bookmark', command: 'echo synthetic', category: 'Fixture' };
  const response = rows => ({ ok: true, json: async () => ({ bookmarks: rows }) });
  it('hides previously loaded bookmarks after an ownership conflict and restores them only after a successful retry', async () => {
    const conflict = { ok: false, status: 409, json: async () => ({ error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' }) };
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockResolvedValueOnce(conflict).mockResolvedValueOnce(response([row]));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
    await act(async () => result.current.reloadBookmarks());
    expect([result.current.bookmarksScopeHeld, result.current.bookmarks, result.current.bookmarksLoadError]).toEqual([
      true, [], 'Bookmark storage ownership is ambiguous. Administrator review is required.',
    ]);
    await act(async () => result.current.reloadBookmarks());
    expect([result.current.bookmarksScopeHeld, result.current.bookmarks]).toEqual([false, [row]]);
  });
  it('distinguishes initial failure from confirmed empty and retries with reads only', async () => {
    apiFetch.mockReset().mockRejectedValueOnce(new Error('Synthetic read offline')).mockResolvedValue(response([]));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('error'));
    expect(result.current.bookmarksLoadError).toBe('Synthetic read offline');
    await act(async () => result.current.reloadBookmarks());
    expect([result.current.bookmarksLoadStatus, result.current.bookmarksLoadError, result.current.bookmarks]).toEqual(['ready', '', []]);
    expect(apiFetch.mock.calls.every(([url, options]) => url === '/api/bookmarks' && !options?.method)).toBe(true);
  });
  it('retains rows on read failure and keeps mutation errors separate', async () => {
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockResolvedValueOnce({ ok: false, status: 500 }).mockRejectedValueOnce(new Error('Refresh offline'));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
    await act(async () => expect(result.current.updateBookmark(row.id, { category: 'Revised' })).rejects.toThrow('(500)'));
    expect([result.current.bookmarksLoadStatus, result.current.bookmarksLoadError]).toEqual(['ready', '']);
    await act(async () => result.current.reloadBookmarks());
    expect([result.current.bookmarks, result.current.bookmarksLoadStatus]).toEqual([[row], 'error']);
  });
  it.each(['success', 'failure'])('ignores an older read %s after a newer retry succeeds', async outcome => {
    let finish, fail;
    apiFetch.mockReset().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; })).mockResolvedValue(response([row]));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await act(async () => result.current.reloadBookmarks());
    await act(async () => outcome === 'success' ? finish(response([])) : fail(new Error('Old read failure')));
    expect([result.current.bookmarks, result.current.bookmarksLoadStatus, result.current.bookmarksLoadError]).toEqual([[row], 'ready', '']);
  });
  it('clears rows on identity change and rejects old callbacks', async () => {
    let finish;
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
    const oldUpdate = result.current.updateBookmark, oldScope = result.current.bookmarksScopeKey;
    act(() => { scope.authEpoch++; scope.authListeners.forEach(listener => listener('identity')); });
    expect([result.current.bookmarks, result.current.bookmarksLoadStatus]).toEqual([[], 'loading']);
    expect(result.current.bookmarksScopeKey).not.toBe(oldScope);
    await expect(oldUpdate(row.id, { category: 'Wrong scope' })).rejects.toThrow(/scope|changed/i);
    await act(async () => finish(response([])));
    expect(apiFetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('does not refresh after an old-scope mutation completes', async () => {
    let finishWrite;
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; })).mockResolvedValue(response([]));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
    let pending;
    act(() => { pending = result.current.updateBookmark(row.id, { category: 'Old scope write' }); });
    const rejected = expect(pending).rejects.toThrow(/scope|changed/i);
    await act(async () => { scope.authEpoch++; scope.authListeners.forEach(listener => listener('identity')); });
    await act(async () => finishWrite({ ok: true }));
    await rejected;
    expect(result.current.bookmarks).toEqual([]);
    expect(apiFetch.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2);
  });
  it('fences a Home read while remote and reloads on return', async () => {
    let finishOld;
    apiFetch.mockReset().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(response([row]));
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    act(() => { scope.environment = { id: 'synthetic-remote' }; scope.environmentListeners.forEach(listener => listener()); });
    expect([result.current.bookmarks, result.current.bookmarksLoadStatus]).toEqual([[], 'unavailable']);
    await act(async () => result.current.reloadBookmarks());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => finishOld(response([row])));
    expect(result.current.bookmarks).toEqual([]);
    await act(async () => { scope.environment = null; scope.environmentListeners.forEach(listener => listener()); });
    expect([result.current.bookmarks, result.current.bookmarksLoadStatus]).toEqual([[row], 'ready']);
  });
  it('treats malformed collections as failed reads', async () => {
    apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ bookmarks: null }) });
    const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
    await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('error'));
    expect(result.current.bookmarksLoadError).toMatch(/read|load|invalid/i);
  });
});

it('shows bookmark read failure in the modal and preserves its draft through read-only retry',async()=>{
 apiFetch.mockReset().mockRejectedValueOnce(new Error('Bookmarks read offline')).mockResolvedValue({ok:true,json:async()=>({bookmarks:[]})});
 function Fixture(){const value=useBookmarks();return <BookmarkModal isOpen bookmarks={value.bookmarks} onAdd={value.addBookmark} onUpdate={value.updateBookmark} onDelete={value.deleteBookmark} onExecute={value.executeBookmark} onClose={vi.fn()} loadStatus={value.bookmarksLoadStatus} loadError={value.bookmarksLoadError} onRetryLoad={value.reloadBookmarks} scopeKey={value.bookmarksScopeKey}/>;}
 render(<BookmarkProvider><Fixture/></BookmarkProvider>);
 await screen.findByRole('button',{name:'Retry loading bookmarks'});
 expect(screen.queryByText(/No bookmarks yet/)).not.toBeInTheDocument();
 expect(screen.queryByText('All Bookmarks (0)')).not.toBeInTheDocument();
 fireEvent.click(screen.getByTitle('Add bookmark'));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Draft during read failure'}});
 fireEvent.change(screen.getByLabelText('Command'),{target:{value:'echo keep-draft'}});
 const retry=screen.getByRole('button',{name:'Retry loading bookmarks'});retry.focus();
 await act(async()=>fireEvent.click(retry));
 expect(screen.getByLabelText('Name')).toHaveFocus();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Name')).toHaveValue('Draft during read failure');
 expect(screen.getByLabelText('Command')).toHaveValue('echo keep-draft');
 expect(apiFetch.mock.calls.every(([path,options])=>path==='/api/bookmarks'&&!options?.method)).toBe(true);
});

it('keeps a successful bookmark mutation successful when only its refresh fails',async()=>{
 apiFetch.mockReset().mockResolvedValueOnce({ok:true,json:async()=>({bookmarks:[]})}).mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(new Error('Read refresh offline'));
 const {result}=renderHook(useBookmarks,{wrapper:BookmarkProvider});
 await waitFor(()=>expect(result.current.bookmarksLoadStatus).toBe('ready'));
 await act(async()=>expect(result.current.updateBookmark('synthetic-id',{category:'Fixture'})).resolves.toBeUndefined());
 expect([result.current.bookmarksLoadStatus,result.current.bookmarksLoadError]).toEqual(['error','Read refresh offline']);
});

it.each(['rotation','identity'])('does not reset bookmarks scope for a same-account %s notification',async reason=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({bookmarks:[]})});
 const {result}=renderHook(useBookmarks,{wrapper:BookmarkProvider});
 await waitFor(()=>expect(result.current.bookmarksLoadStatus).toBe('ready'));
 const key=result.current.bookmarksScopeKey;
 act(()=>scope.authListeners.forEach(listener=>listener(reason)));
 expect(result.current.bookmarksScopeKey).toBe(key);
 expect(apiFetch).toHaveBeenCalledOnce();
});

it('does not abort an authorized bookmark write during same-scope refresh-with-user notification',async()=>{
 let finishWrite, writeSignal;
 apiFetch.mockReset().mockImplementation((_url,options)=>options?.method?new Promise(resolve=>{finishWrite=()=>resolve({ok:true});writeSignal=options.signal;}):Promise.resolve({ok:true,json:async()=>({bookmarks:[]})}));
 const {result}=renderHook(useBookmarks,{wrapper:BookmarkProvider});
 await waitFor(()=>expect(result.current.bookmarksLoadStatus).toBe('ready'));
 const key=result.current.bookmarksScopeKey;
 let pending;act(()=>{pending=result.current.updateBookmark('synthetic-id',{category:'Fixture'});});
 const completion=pending.then(()=>({ok:true}),error=>({ok:false,error:error.message}));
 act(()=>scope.authListeners.forEach(listener=>listener('identity')));
 expect(writeSignal.aborted).toBe(false);
 expect(result.current.bookmarksScopeKey).toBe(key);
 await act(async()=>finishWrite());expect(await completion).toEqual({ok:true});
});

it('keeps an unsent bookmark draft when refresh returns the same account identity',async()=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({bookmarks:[]})});
 function Fixture(){const v=useBookmarks();return <BookmarkModal isOpen bookmarks={v.bookmarks} onClose={vi.fn()} onAdd={v.addBookmark} onUpdate={v.updateBookmark} loadStatus={v.bookmarksLoadStatus} loadError={v.bookmarksLoadError} onRetryLoad={v.reloadBookmarks} scopeKey={v.bookmarksScopeKey}/>;}
 render(<BookmarkProvider><Fixture/></BookmarkProvider>);
 await screen.findByText(/No bookmarks yet/);fireEvent.click(screen.getByTitle('Add bookmark'));
 fireEvent.change(screen.getByLabelText('Name'),{target:{value:'Keep same-account bookmark draft'}});
 act(()=>scope.authListeners.forEach(listener=>listener('identity')));
 expect(screen.getByLabelText('Name')).toHaveValue('Keep same-account bookmark draft');
 expect(apiFetch).toHaveBeenCalledOnce();
});

it('holds a draft after a rejected ownership conflict and restores it on read-only retry', async () => {
  const conflict = { ok: false, status: 409, json: async () => ({ error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' }) };
  apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
    .mockResolvedValueOnce(conflict).mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) });
  function Fixture() {
    const v = useBookmarks();
    return <BookmarkModal isOpen bookmarks={v.bookmarks} onClose={vi.fn()} onAdd={v.addBookmark}
      loadStatus={v.bookmarksLoadStatus} loadError={v.bookmarksLoadError} onRetryLoad={v.reloadBookmarks}
      scopeKey={v.bookmarksScopeKey} scopeHeld={v.bookmarksScopeHeld} scopeHoldMessage={v.bookmarksScopeHoldMessage} />;
  }
  render(<BookmarkProvider><Fixture /></BookmarkProvider>);
  await screen.findByText(/No bookmarks yet/);
  fireEvent.click(screen.getByTitle('Add bookmark'));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retained draft' } });
  fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'echo retained' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
  expect(screen.getByRole('alert')).toHaveTextContent('Administrator review is required');
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry loading bookmarks' })));
  expect(screen.getByLabelText('Name')).toHaveValue('Retained draft');
  expect(screen.getByLabelText('Command')).toHaveValue('echo retained');
  expect(apiFetch.mock.calls.map(([, options]) => options?.method || 'GET')).toEqual(['GET', 'POST', 'GET']);
});

it('reports an unconfirmed result when ownership becomes ambiguous after a successful write', async () => {
  const conflict = { ok: false, status: 409, json: async () => ({ error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' }) };
  apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ bookmarks: [] }) })
    .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(conflict);
  const { result } = renderHook(useBookmarks, { wrapper: BookmarkProvider });
  await waitFor(() => expect(result.current.bookmarksLoadStatus).toBe('ready'));
  let outcome;
  await act(async () => { outcome = await result.current.addBookmark('draft', 'echo draft', 'General').catch(error => error); });
  expect([outcome.outcomeUncertain, result.current.bookmarksScopeHeld]).toEqual([true, true]);
});

it('rejects a bookmark write if authentication changed before its notification is delivered',async()=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({bookmarks:[]})});
 const {result}=renderHook(useBookmarks,{wrapper:BookmarkProvider});
 await waitFor(()=>expect(result.current.bookmarksLoadStatus).toBe('ready'));
 scope.authEpoch++;
 await act(async()=>expect(result.current.updateBookmark('old-synthetic-id',{category:'Do not cross scope'})).rejects.toThrow(/scope|changed/i));
 expect(apiFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
