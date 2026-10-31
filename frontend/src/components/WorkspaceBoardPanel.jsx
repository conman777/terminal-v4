import { useEffect, useReducer, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { createUuid } from '../utils/createUuid';
import './WorkspaceBoardPanel.css';

const drafts = new Map();
const emptyDraft = () => ({ title: '', description: '', status: 'open', blockedReason: '' });
const statuses = [['open', 'Open'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done']];

function BoardContent({ workspacePath, scopeKey, authScope, environmentSignal }) {
  const [draft, setDraftState] = useState(() => drafts.get(scopeKey)?.draft || emptyDraft());
  const [editing, setEditingState] = useState(() => drafts.get(scopeKey)?.editing || null);
  const [pending, setPendingState] = useState(() => drafts.get(scopeKey)?.pending || null);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false);
  const lock = useRef(false);
  const saved = useRef({ draft, editing, pending });
  function save(patch) { saved.current = { ...saved.current, ...patch }; drafts.set(scopeKey, saved.current); }
  function setDraft(value) { save({ draft: value }); setDraftState(value); }
  function setEditing(value) { save({ editing: value }); setEditingState(value); }
  function setPending(value) { save({ pending: value }); setPendingState(value); }
  function current() { return alive.current && isAuthScopeCurrent(authScope) && !environmentSignal.aborted; }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    setError('');
    apiFetch('/api/workspace/board?' + new URLSearchParams({ path: workspacePath }), { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load task board');
        if (!Array.isArray(data.items)) throw new Error('Invalid task board response');
        if (current() && !controller.signal.aborted) setItems(data.items);
      }).catch(err => { if (current() && !controller.signal.aborted) setError(err.message || 'Unable to load task board'); });
    return () => { alive.current = false; controller.abort(); };
  }, [workspacePath, refresh]);

  async function send(operation) {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError(''); setConflict(false);
    setPending(operation);
    try {
      const response = await apiFetch(operation.url, { method: operation.method, body: operation.body, signal: environmentSignal });
      const data = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) {
        if (response.status === 409 && data.error === 'Board revision is stale' && operation.method !== 'POST') { setPending(null); setConflict(true); setItems(null); setRefresh(value => value + 1); throw new Error(data.error); }
        if (response.status === 409 && (pending || data.error === 'operationId already used with a different request')) throw new Error(data.error || 'Unable to confirm the uncertain write');
        if (response.status < 500 && response.status !== 408 && response.status !== 429) setPending(null);
        throw new Error(data.error || 'Unable to save task');
      }
      setPending(null);
      if (operation.method !== 'DELETE') { setDraft(emptyDraft()); setEditing(null); }
      setRefresh(value => value + 1);
    } catch (err) {
      if (current()) setError(err.message || 'The result is uncertain. Retry the same operation.');
    } finally { lock.current = false; if (current()) setBusy(false); }
  }
  function submit(event) {
    event.preventDefault();
    if (!draft.title.trim() || pending) return;
    const body = { path: workspacePath, operationId: createUuid(), title: draft.title, description: draft.description };
    if (editing) Object.assign(body, { expectedRevision: editing.revision, status: draft.status, blockedReason: draft.blockedReason || null });
    send({ method: editing ? 'PATCH' : 'POST', url: '/api/workspace/board' + (editing ? '/' + encodeURIComponent(editing.id) : ''), body });
  }
  function edit(item) { setEditing({ id: item.id, revision: item.revision }); setDraft({ title: item.title, description: item.description || '', status: item.status, blockedReason: item.blockedReason || '' }); setConflict(false); setError(''); }
  function remove(item) {
    send({ method: 'DELETE', url: '/api/workspace/board/' + encodeURIComponent(item.id), body: { path: workspacePath, operationId: createUuid(), expectedRevision: item.revision } });
  }
  const latest = editing && items?.find(item => item.id === editing.id);
  return <section className="workspace-board" aria-label="Task board">
    <header><h3>Task board</h3><p>Track work in this workspace. Board items do not run tasks.</p></header>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh board</button></div>}
    {pending && <div className="workspace-board-notice" role="status"><p>The write may have succeeded. Retry the same operation to confirm its result before making another change.</p><button type="button" disabled={busy} onClick={() => send(pending)}>Retry uncertain write</button></div>}
    {conflict && <div className="workspace-board-notice"><p>The board changed. Your draft is preserved. Review the latest item before applying your draft.</p>{!editing && <button type="button" onClick={() => { setConflict(false); setError(''); }}>Dismiss</button>}{latest && <button type="button" onClick={() => { setEditing({ id: latest.id, revision: latest.revision }); setConflict(false); setError(''); }}>Use latest revision for draft</button>}</div>}
    <form onSubmit={submit}>
      <h4>{editing ? 'Edit task' : 'New task'}</h4><fieldset disabled={busy || !!pending}>
      <label>Title<input required maxLength={512} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Description<textarea maxLength={16384} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      {editing && <><label>Status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Blocked reason<textarea maxLength={4096} value={draft.blockedReason} onChange={e => setDraft({ ...draft, blockedReason: e.target.value })} /></label></>}
      </fieldset><div className="workspace-board-actions"><button type="submit" disabled={busy || !!pending || conflict || !draft.title.trim()}>{editing ? 'Save task' : 'Add task'}</button>{editing && <button type="button" disabled={busy || !!pending} onClick={() => { setEditing(null); setDraft(emptyDraft()); setConflict(false); setError(''); }}>Cancel edit</button>}</div>
    </form>
    {!items && !error && <p role="status">Loading task board…</p>}
    {items?.length === 0 && <p>No tasks yet.</p>}
    {items?.map(item => <article className="workspace-board-item" key={item.id}>
      <h4>{item.title}</h4><p>{statuses.find(([value]) => value === item.status)?.[1] || item.status}</p>
      {item.description && <p className="workspace-board-text">{item.description}</p>}{item.blockedReason && <p className="workspace-board-text">Blocked: {item.blockedReason}</p>}
      <div className="workspace-board-actions"><button type="button" disabled={busy || !!pending} aria-label={'Edit ' + item.title} onClick={() => edit(item)}>Edit</button><details><summary>Delete</summary><p>Delete this task?</p><button type="button" disabled={busy || !!pending} aria-label={'Confirm delete ' + item.title} onClick={() => remove(item)}>Confirm delete</button></details></div>
    </article>)}
  </section>;
}

export function WorkspaceBoardPanel({ workspacePath }) {
  const [, update] = useReducer(value => value + 1, 0);
  useEffect(() => { const a = subscribeAuth(update); const b = subscribeEnvironment(update); return () => { a(); b(); }; }, []);
  if (!workspacePath) return <p>Select a workspace to view its task board.</p>;
  const authScope = captureAuthScope();
  const environmentSignal = getEnvironmentSignal();
  const scopeKey = JSON.stringify([authScope.home, authScope.userId, authScope.session, authScope.generation, getActiveEnvironment()?.id || '', workspacePath]);
  return <BoardContent key={scopeKey} workspacePath={workspacePath} scopeKey={scopeKey} authScope={authScope} environmentSignal={environmentSignal} />;
}
