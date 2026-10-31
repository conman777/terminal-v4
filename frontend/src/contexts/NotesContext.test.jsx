import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesProvider, useNotes } from './NotesContext';
import { apiFetch } from '../utils/api';
import { NotesModal } from '../components/NotesModal';

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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NotesProvider mutation errors', () => {
  it('treats a server error after a note write as an unconfirmed outcome', async () => {
    apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ notes: [] }) }).mockResolvedValueOnce({ ok: false, status: 500 });
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
    await act(async () => expect(result.current.addNote('title', 'draft', 'General')).rejects.toMatchObject({ outcomeUncertain: true }));
  });
  it.each([
    ['addNote', ['Draft title', 'Draft content', 'General']],
    ['updateNote', ['alpha', { content: 'Draft content' }]],
    ['deleteNote', ['alpha']],
  ])('rejects failed %s requests so the editor can retain its draft', async (method, args) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockReset().mockResolvedValueOnce({ ok: true, json: async () => ({ notes: [] }) }).mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledOnce());
    await act(async () => expect(result.current[method](...args)).rejects.toThrow('(500)'));
  });
});

describe('NotesProvider editor integration', () => {
  function Editor({ onClose }) {
    const { notes, addNote, updateNote, deleteNote, notesLoadStatus, notesLoadError, reloadNotes, notesScopeKey } = useNotes();
    return <NotesModal isOpen loadStatus={notesLoadStatus} loadError={notesLoadError} onRetryLoad={reloadNotes} scopeKey={notesScopeKey} notes={notes} onAdd={addNote} onUpdate={updateNote} onDelete={deleteNote} onClose={onClose} />;
  }

  it('keeps an existing draft open after a real provider HTTP failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockReset().mockImplementation(async (url, options) => options?.method
      ? { ok: false, status: 500 }
      : { ok: true, json: async () => ({ notes: [{ id: 'alpha', title: 'Alpha', content: 'Original', category: 'General' }] }) });
    const onClose = vi.fn();
    await act(async () => render(<NotesProvider><Editor onClose={onClose} /></NotesProvider>));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Alpha/ })));
    fireEvent.change(screen.getByPlaceholderText('Write something... (Markdown supported)'), { target: { value: 'Unsaved draft' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
    expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('Unsaved draft');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenLastCalledWith('/api/notes/alpha', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ title: 'Alpha', content: 'Unsaved draft', category: 'General' }) }));
  });

  it('keeps a new draft after a real provider HTTP failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockReset().mockImplementation(async (url, options) => options?.method
      ? { ok: false, status: 500 }
      : { ok: true, json: async () => ({ notes: [] }) });
    await act(async () => render(<NotesProvider><Editor onClose={vi.fn()} /></NotesProvider>));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New Note' })));
    fireEvent.change(screen.getByPlaceholderText('Untitled'), { target: { value: 'Keep this draft' } });
    fireEvent.change(screen.getByPlaceholderText('Write something... (Markdown supported)'), { target: { value: 'New content' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByPlaceholderText('Untitled')).toHaveValue('Keep this draft');
    expect(screen.getByPlaceholderText('Write something... (Markdown supported)')).toHaveValue('New content');
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i);
  });
});


describe('NotesProvider load health and scope', () => {
  const row = { id: 'synthetic-row', title: 'Synthetic note', content: 'Synthetic text', category: 'Fixture' };
  const response = rows => ({ ok: true, json: async () => ({ notes: rows }) });
  it('explains when stored note ownership needs administrator review', async () => {
    apiFetch.mockReset().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'Note storage ownership is ambiguous. Administrator review is required.' }) });
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
    expect(result.current.notesLoadError).toMatch(/ownership.*administrator/i);
    expect(result.current.notes).toEqual([]);
  });
  it('distinguishes initial failure from confirmed empty and retries with reads only', async () => {
    apiFetch.mockReset().mockRejectedValueOnce(new Error('Synthetic read offline')).mockResolvedValue(response([]));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
    expect(result.current.notesLoadError).toBe('Synthetic read offline');
    await act(async () => result.current.reloadNotes());
    expect([result.current.notesLoadStatus, result.current.notesLoadError, result.current.notes]).toEqual(['ready', '', []]);
    expect(apiFetch.mock.calls.every(([url, options]) => url === '/api/notes' && !options?.method)).toBe(true);
  });
  it('retains rows on read failure and keeps mutation errors separate', async () => {
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockResolvedValueOnce({ ok: false, status: 500 }).mockRejectedValueOnce(new Error('Refresh offline'));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
    await act(async () => expect(result.current.updateNote(row.id, { category: 'Revised' })).rejects.toThrow('(500)'));
    expect([result.current.notesLoadStatus, result.current.notesLoadError]).toEqual(['ready', '']);
    await act(async () => result.current.reloadNotes());
    expect([result.current.notes, result.current.notesLoadStatus]).toEqual([[row], 'error']);
  });
  it.each(['success', 'failure'])('ignores an older read %s after a newer retry succeeds', async outcome => {
    let finish, fail;
    apiFetch.mockReset().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; })).mockResolvedValue(response([row]));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await act(async () => result.current.reloadNotes());
    await act(async () => outcome === 'success' ? finish(response([])) : fail(new Error('Old read failure')));
    expect([result.current.notes, result.current.notesLoadStatus, result.current.notesLoadError]).toEqual([[row], 'ready', '']);
  });
  it('clears rows on identity change and rejects old callbacks', async () => {
    let finish;
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
    const oldUpdate = result.current.updateNote, oldScope = result.current.notesScopeKey;
    act(() => { scope.authEpoch++; scope.authListeners.forEach(listener => listener('identity')); });
    expect([result.current.notes, result.current.notesLoadStatus]).toEqual([[], 'loading']);
    expect(result.current.notesScopeKey).not.toBe(oldScope);
    await expect(oldUpdate(row.id, { category: 'Wrong scope' })).rejects.toThrow(/scope|changed/i);
    await act(async () => finish(response([])));
    expect(apiFetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('does not refresh after an old-scope mutation completes', async () => {
    let finishWrite;
    apiFetch.mockReset().mockResolvedValueOnce(response([row])).mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; })).mockResolvedValue(response([]));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('ready'));
    let pending;
    act(() => { pending = result.current.updateNote(row.id, { category: 'Old scope write' }); });
    const rejected = expect(pending).rejects.toThrow(/scope|changed/i);
    await act(async () => { scope.authEpoch++; scope.authListeners.forEach(listener => listener('identity')); });
    await act(async () => finishWrite({ ok: true }));
    await rejected;
    expect(result.current.notes).toEqual([]);
    expect(apiFetch.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(2);
  });
  it('fences a Home read while remote and reloads on return', async () => {
    let finishOld;
    apiFetch.mockReset().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(response([row]));
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    act(() => { scope.environment = { id: 'synthetic-remote' }; scope.environmentListeners.forEach(listener => listener()); });
    expect([result.current.notes, result.current.notesLoadStatus]).toEqual([[], 'unavailable']);
    await act(async () => result.current.reloadNotes());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => finishOld(response([row])));
    expect(result.current.notes).toEqual([]);
    await act(async () => { scope.environment = null; scope.environmentListeners.forEach(listener => listener()); });
    expect([result.current.notes, result.current.notesLoadStatus]).toEqual([[row], 'ready']);
  });
  it('treats malformed collections as failed reads', async () => {
    apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ notes: null }) });
    const { result } = renderHook(useNotes, { wrapper: NotesProvider });
    await waitFor(() => expect(result.current.notesLoadStatus).toBe('error'));
    expect(result.current.notesLoadError).toMatch(/read|load|invalid/i);
  });
});

it('shows a failed initial read through the modal and retries without mutating or losing its new draft',async()=>{
 apiFetch.mockReset().mockRejectedValueOnce(new Error('Notes read offline')).mockResolvedValue({ok:true,json:async()=>({notes:[]})});
 function Fixture(){const value=useNotes();return <NotesModal isOpen notes={value.notes} onAdd={value.addNote} onUpdate={value.updateNote} onDelete={value.deleteNote} onClose={vi.fn()} loadStatus={value.notesLoadStatus} loadError={value.notesLoadError} onRetryLoad={value.reloadNotes} scopeKey={value.notesScopeKey}/>;}
 render(<NotesProvider><Fixture/></NotesProvider>);
 await screen.findByRole('button',{name:'Retry loading notes'});
 expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New note',exact:true})));
 fireEvent.change(screen.getByLabelText('Note title'),{target:{value:'Draft during load failure'}});
 fireEvent.change(screen.getByLabelText('Note content'),{target:{value:'Keep this draft'}});
 const retry=screen.getByRole('button',{name:'Retry loading notes'});retry.focus();
 await act(async()=>fireEvent.click(retry));
 expect(screen.getByLabelText('Note title')).toHaveFocus();
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 expect(screen.getByLabelText('Note title')).toHaveValue('Draft during load failure');
 expect(screen.getByLabelText('Note content')).toHaveValue('Keep this draft');
 expect(apiFetch.mock.calls.every(([path,options])=>path==='/api/notes'&&!options?.method)).toBe(true);
});

it('keeps a successful note mutation successful when only its refresh fails',async()=>{
 apiFetch.mockReset().mockResolvedValueOnce({ok:true,json:async()=>({notes:[]})}).mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(new Error('Read refresh offline'));
 const {result}=renderHook(useNotes,{wrapper:NotesProvider});
 await waitFor(()=>expect(result.current.notesLoadStatus).toBe('ready'));
 await act(async()=>expect(result.current.updateNote('synthetic-id',{category:'Fixture'})).resolves.toBeUndefined());
 expect([result.current.notesLoadStatus,result.current.notesLoadError]).toEqual(['error','Read refresh offline']);
});

it.each(['rotation','identity'])('does not reset notes scope for a same-account %s notification',async reason=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({notes:[]})});
 const {result}=renderHook(useNotes,{wrapper:NotesProvider});
 await waitFor(()=>expect(result.current.notesLoadStatus).toBe('ready'));
 const key=result.current.notesScopeKey;
 act(()=>scope.authListeners.forEach(listener=>listener(reason)));
 expect(result.current.notesScopeKey).toBe(key);
 expect(apiFetch).toHaveBeenCalledOnce();
});

it('does not autosave an old modal draft into a new account when its scope resets',async()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 const oldNote={id:'same-synthetic-id',title:'Old account note',content:'Old content',category:'Fixture'};
 apiFetch.mockReset().mockResolvedValueOnce({ok:true,json:async()=>({notes:[oldNote]})}).mockResolvedValue({ok:true,json:async()=>({notes:[]})});
 function Fixture(){const value=useNotes();return <NotesModal isOpen notes={value.notes} onAdd={value.addNote} onUpdate={value.updateNote} onDelete={value.deleteNote} onClose={vi.fn()} loadStatus={value.notesLoadStatus} loadError={value.notesLoadError} onRetryLoad={value.reloadNotes} scopeKey={value.notesScopeKey}/>;}
 render(<NotesProvider><Fixture/></NotesProvider>);
 fireEvent.click(await screen.findByRole('button',{name:/Old account note/}));
 await screen.findByLabelText('Note content');
 fireEvent.change(screen.getByLabelText('Note content'),{target:{value:'Private old-scope draft'}});
 await act(async()=>{scope.authEpoch++;scope.authListeners.forEach(listener=>listener('identity'));});
 expect(screen.queryByRole('textbox',{name:'Note content'})).not.toBeInTheDocument();
 expect(screen.queryByText('Old account note')).not.toBeInTheDocument();
 expect(apiFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});

it('does not abort an authorized note write during same-scope refresh-with-user notification',async()=>{
 let finishWrite, writeSignal;
 apiFetch.mockReset().mockImplementation((_url,options)=>options?.method?new Promise(resolve=>{finishWrite=()=>resolve({ok:true});writeSignal=options.signal;}):Promise.resolve({ok:true,json:async()=>({notes:[]})}));
 const {result}=renderHook(useNotes,{wrapper:NotesProvider});
 await waitFor(()=>expect(result.current.notesLoadStatus).toBe('ready'));
 const key=result.current.notesScopeKey;
 let pending;act(()=>{pending=result.current.updateNote('synthetic-id',{category:'Fixture'});});
 const completion=pending.then(()=>({ok:true}),error=>({ok:false,error:error.message}));
 act(()=>scope.authListeners.forEach(listener=>listener('identity')));
 expect(writeSignal.aborted).toBe(false);
 expect(result.current.notesScopeKey).toBe(key);
 await act(async()=>finishWrite());expect(await completion).toEqual({ok:true});
});

it('keeps an unsent note draft when refresh returns the same account identity',async()=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({notes:[]})});
 function Fixture(){const v=useNotes();return <NotesModal isOpen notes={v.notes} onClose={vi.fn()} onAdd={v.addNote} onUpdate={v.updateNote} loadStatus={v.notesLoadStatus} loadError={v.notesLoadError} onRetryLoad={v.reloadNotes} scopeKey={v.notesScopeKey}/>;}
 render(<NotesProvider><Fixture/></NotesProvider>);
 await screen.findByText('No notes yet');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'New note',exact:true})));
 fireEvent.change(screen.getByLabelText('Note title'),{target:{value:'Keep same-account note draft'}});
 act(()=>scope.authListeners.forEach(listener=>listener('identity')));
 expect(screen.getByLabelText('Note title')).toHaveValue('Keep same-account note draft');
 expect(apiFetch).toHaveBeenCalledOnce();
});

it('rejects a note write if authentication changed before its notification is delivered',async()=>{
 apiFetch.mockReset().mockResolvedValue({ok:true,json:async()=>({notes:[]})});
 const {result}=renderHook(useNotes,{wrapper:NotesProvider});
 await waitFor(()=>expect(result.current.notesLoadStatus).toBe('ready'));
 scope.authEpoch++;
 await act(async()=>expect(result.current.updateNote('old-synthetic-id',{category:'Do not cross scope'})).rejects.toThrow(/scope|changed/i));
 expect(apiFetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
