import { createUuid } from '../utils/createUuid';
import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { resolveHomeApiUrl } from '../utils/apiBase';
import { getActiveEnvironment, getEnvironmentSignal, getEnvironmentStorage, subscribeEnvironment } from '../utils/remoteEnvironments';
import { environmentAllows } from '../utils/runtimePermissions';
import './FollowupQueuePanel.css';

import { MAX_BYTES, UUID, applyOptimistic, integer, validateSnapshot } from '../utils/followupQueueSnapshot';
const bytes = value => new TextEncoder().encode(value).length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kinds = new Set(['enqueue', 'edit', 'remove', 'reorder', 'promote', 'pause', 'resume', 'wake']);
const knownRejection = status => [400, 401, 403, 404, 409, 413, 422].includes(status);
function validReceipt(receipt, mutation) {
  return receipt && receipt.operationId === mutation.operationId && integer(receipt.queueRevision) && receipt.queueRevision > 0
    && (mutation.operation.itemId ? receipt.itemId === mutation.operation.itemId && integer(receipt.itemRevision) && receipt.itemRevision > 0 : receipt.itemId == null && receipt.itemRevision == null);
}
function emptyLocal(home, sessionId) { return { version: 1, home, sessionId, draftText: '', draftRevision: 0, editor: null, pending: null, wakeRecovery: null }; }
function validateLocal(value, home, sessionId) {
  if (!value || value.version !== 1 || value.home !== home || value.sessionId !== sessionId || typeof value.draftText !== 'string' || !integer(value.draftRevision ?? 0)
    || (value.editor && (!UUID.test(value.editor.itemId) || !integer(value.editor.revision) || typeof value.editor.text !== 'string'))
    || (value.pending && (!UUID.test(value.pending.mutation?.operationId) || !integer(value.pending.mutation?.expectedQueueRevision) || !kinds.has(value.pending.mutation?.operation?.kind)))
    || (value.wakeRecovery && !UUID.test(value.wakeRecovery.operationId))) throw new Error('Saved queue work could not be read. Review the host queue before clearing the saved draft.');
  return { ...value, draftRevision: value.draftRevision ?? 0, wakeRecovery: value.wakeRecovery ?? null };
}
function textError(text) {
  if (!text.trim() || text.includes('\0')) return 'Write a queued message without NUL characters.';
  if ([...text].length > 50_000 || bytes(text) > MAX_BYTES) return 'A queued message must be at most 50,000 characters and 100,000 UTF-8 bytes.';
  return null;
}

export function FollowupQueuePanel({ sessionId, active = true, pollIntervalMs = 1500, onClose }) {
  const prefix = useId(); const [scopeVersion, setScopeVersion] = useState(0);
  const [snapshot, setSnapshot] = useState(null); const [local, setLocal] = useState(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [remoteChange, setRemoteChange] = useState(false); const [dragId, setDragId] = useState(null); const [message, setMessage] = useState(''); const [corruptLocal, setCorruptLocal] = useState(false);
  const scope = useRef(null); const localRef = useRef(null); const snapshotRef = useRef(null); const action = useRef(null);
  const current = context => scope.current === context && !context.controller.signal.aborted && !context.environmentSignal.aborted;
  const endpoint = context => `/api/structured/sessions/${encodeURIComponent(context.sessionId)}/queue`;
  const signal = context => AbortSignal.any([context.controller.signal, context.environmentSignal]);

  function saveLocal(context, next, required = false) {
    if (!current(context)) return false;
    let persisted = true;
    try { context.storage.setItem(context.key, JSON.stringify(next)); }
    catch {
      persisted = false;
      setError('This action could not be saved on this device. Your draft was kept. Free local storage and retry.');
      if (required) return false;
    }
    localRef.current = next; setLocal(next); return persisted;
  }
  function updateLocal(patch) {
    const context = scope.current;
    if (context && current(context) && localRef.current) {
      const next = { ...localRef.current, ...patch };
      if (Object.hasOwn(patch, 'draftText')) next.draftRevision = localRef.current.draftRevision + 1;
      saveLocal(context, next);
    }
  }
  async function load(context, clearError = false, force = false) {
    if (!current(context)) return null;
    try {
      const response = await apiFetch(endpoint(context), { signal: signal(context) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Could not load the queue (${response.status}).`);
      const next = validateSnapshot(data);
      if (!current(context)) return next;
      const previous = snapshotRef.current;
      if (!force && previous && next.revision < previous.revision) return previous;
      if (previous && next.revision > previous.revision && !action.current && !localRef.current?.pending) setRemoteChange(true);
      snapshotRef.current = next; setSnapshot(next); if (clearError) setError('');
      return next;
    } catch (failure) { if (current(context)) { setError(failure.message || 'Could not load the queue.'); if (!snapshotRef.current) setSnapshot(null); } return null; }
    finally { if (current(context)) setLoading(false); }
  }
  async function confirm(context, pending, receipt, recovered = false) {
    if (!current(context) || !validReceipt(receipt, pending.mutation)) throw new Error('The queue action receipt is invalid. Its result could not be confirmed.');
    if (localRef.current?.pending?.mutation.operationId !== pending.mutation.operationId) return;
    setError('');
    const fresh = await load(context, false, true);
    if (!current(context)) return;
    if (localRef.current?.pending?.mutation.operationId !== pending.mutation.operationId) return;
    const next = { ...localRef.current, pending: null };
    if (pending.mutation.operation.kind === 'enqueue' && next.draftText === pending.draftAtSubmit && next.draftRevision === pending.draftRevisionAtSubmit) { next.draftText = ''; next.draftRevision += 1; }
    if (pending.mutation.operation.kind === 'edit' && same(next.editor, pending.editorAtSubmit)) next.editor = null;
    if (recovered && pending.mutation.operation.kind !== 'pause') next.wakeRecovery = { operationId: pending.mutation.operationId };
    else if (!recovered && ['wake', 'resume'].includes(pending.mutation.operation.kind)) next.wakeRecovery = null;
    setRemoteChange(false); saveLocal(context, next);
    if (recovered) setMessage(pending.mutation.operation.kind === 'pause' ? 'Queue action saved. Review the queue state.' : 'Queue action saved. Review its state and use Wake queue if it stays idle.');
    else if (pending.mutation.operation.kind === 'wake') {
      setMessage(fresh?.mode === 'held' ? 'Queue was held for review. Check the conversation before manually sending unsent work.'
        : fresh ? 'Queue processing requested.' : 'Queue wake saved. Reload the queue to check its status.');
    } else setMessage('Queue action confirmed.');
  }
  async function lookup(context, pending) {
    const response = await apiFetch(`${endpoint(context)}/operations/${pending.mutation.operationId}`, { signal: signal(context) });
    if (response.status === 404) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'The queue action could not be confirmed.');
    if (!validReceipt(data, pending.mutation)) throw new Error('The queue action receipt is invalid.');
    return data;
  }
  async function perform(context, pending, lookupFirst = false, allowPost = true) {
    if (!current(context) || action.current) return;
    const request = {}; action.current = request; setBusy(true); setError(''); setMessage('');
    try {
      if (lookupFirst) {
        const found = await lookup(context, pending);
        if (!current(context)) return;
        if (found) { await confirm(context, pending, found, true); return; }
        if (!allowPost) throw new Error('The queue action could not be confirmed. Its exact identity was kept. Retry the same action to check again.');
      }
      const response = await apiFetch(endpoint(context), { method: 'POST', body: pending.mutation, signal: signal(context) });
      if (!current(context)) return;
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        // A retry rejection cannot settle an earlier request still able to commit.
        // Only its exact durable receipt can release an already uncertain identity.
        if (knownRejection(response.status) && !lookupFirst) {
          saveLocal(context, { ...localRef.current, pending: null });
          const message = pending.mutation.operation.kind === 'wake' && [400, 422].includes(response.status)
            ? 'Wake queue is unavailable on this host. Check the conversation before manually sending unsent work.'
            : data?.error || `Queue action rejected (${response.status}). Your draft was kept.`;
          await load(context); throw Object.assign(new Error(message), { rejected: true });
        }
        throw new Error(data?.error || 'Queue action response was uncertain.');
      }
      await confirm(context, pending, data);
    } catch (failure) {
      if (!current(context)) return;
      if (!failure.rejected && allowPost) {
        try {
          const found = await lookup(context, pending);
          if (current(context) && found) { await confirm(context, pending, found, true); return; }
        } catch { /* The frozen operation remains durable until a later explicit lookup/retry. */ }
      }
      if (current(context)) setError(failure.rejected ? failure.message : 'The queue action could not be confirmed. Its exact identity and draft were kept. Retry the same queue action.');
    } finally { if (action.current === request) { action.current = null; if (current(context)) setBusy(false); } }
  }
  function mutate(operation) {
    const context = scope.current; const saved = localRef.current; const host = snapshotRef.current;
    if (!context || !current(context) || !saved || saved.pending || action.current || !host || corruptLocal || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return;
    const text = operation.text;
    if (typeof text === 'string') { const invalid = textError(text); if (invalid) { setError(invalid); return; } }
    const pending = { mutation: { operationId: createUuid(), expectedQueueRevision: host.revision, operation },
      draftAtSubmit: operation.kind === 'enqueue' ? saved.draftText : null, draftRevisionAtSubmit: saved.draftRevision, editorAtSubmit: operation.kind === 'edit' ? saved.editor : null };
    if (!saveLocal(context, { ...saved, pending }, true)) return;
    void perform(context, pending);
  }
  useEffect(() => subscribeEnvironment(() => { scope.current?.controller.abort(); setScopeVersion(value => value + 1); }), []);
  useEffect(() => {
    if (!active || !sessionId) return undefined;
    const home = new URL(resolveHomeApiUrl('') || window.location.origin, window.location.origin).href.replace(/\/$/, '');
    const context = { sessionId, version: scopeVersion, home, storage: getEnvironmentStorage(), key: `followupQueuePanel:${encodeURIComponent(home)}:${sessionId}`, controller: new AbortController(), environmentSignal: getEnvironmentSignal() };
    scope.current = context; action.current = null; snapshotRef.current = null;
    setSnapshot(null); setLoading(true); setBusy(false); setError(''); setMessage(''); setCorruptLocal(false); setRemoteChange(false); setDragId(null);
    let restored = emptyLocal(home, sessionId);
    try { const raw = context.storage.getItem(context.key); if (raw) restored = validateLocal(JSON.parse(raw), home, sessionId); }
    catch (failure) { setCorruptLocal(true); setError(failure.message || 'Saved queue work could not be read.'); }
    localRef.current = restored; setLocal(restored);
    void (async () => { await load(context); if (current(context) && restored.pending) await perform(context, restored.pending, true, false); })();
    let timer;
    const poll = async () => { if (!current(context)) return; if (!action.current) await load(context); if (current(context)) timer = setTimeout(poll, Math.max(500, pollIntervalMs)); };
    if (pollIntervalMs > 0) timer = setTimeout(poll, Math.max(500, pollIntervalMs));
    return () => { context.controller.abort(); clearTimeout(timer); if (scope.current === context) scope.current = null; };
  }, [sessionId, active, scopeVersion, pollIntervalMs]);

  if (!active || !sessionId) return null;
  const visible = scope.current?.sessionId === sessionId && scope.current?.version === scopeVersion;
  const host = visible ? snapshot : null; const draft = visible ? local : null;
  const allowed = environmentAllows(getActiveEnvironment(), 'agentExecute');
  const blocked = busy || Boolean(draft?.pending) || corruptLocal || !allowed;
  const overlay = host && draft?.pending ? applyOptimistic(host, draft.pending.mutation.operation) : null;
  const shownItems = overlay ? overlay.items : host?.items || [];
  const pendingItems = host ? (overlay ? overlay.order : host.order).map(id => shownItems.find(item => item.itemId === id)).filter(Boolean) : [];
  const saving = overlay?.saving || new Set();
  const dispatching = host?.items.filter(item => item.state === 'dispatching') || [];
  const count = host?.items.filter(item => item.state === 'accepted').length || 0;
  const editing = draft?.editor;
  const editedElsewhere = Boolean(editing && host && !draft.pending && (() => { const live = host.items.find(item => item.itemId === editing.itemId); return !live || live.state !== 'pending' || live.revision !== editing.revision; })());
  const move = (index, delta) => { const order = [...host.order]; [order[index], order[index + delta]] = [order[index + delta], order[index]]; mutate({ kind: 'reorder', itemIds: order }); };
  const dropOn = index => {
    const from = host.order.indexOf(dragId); setDragId(null);
    if (blocked || from < 0 || from === index) return;
    const order = [...host.order]; const [moved] = order.splice(from, 1); order.splice(index, 0, moved); mutate({ kind: 'reorder', itemIds: order });
  };
  const arrow = (event, index) => {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    if (!blocked && index + delta >= 0 && index + delta < pendingItems.length) move(index, delta);
  };
  return <section className="followup-queue" aria-label="Follow-up queue">
    <header className="followup-queue-heading"><div><h3>Follow-up queue</h3><p>Messages wait for their next turn. Restarted queues need your permission to resume.</p></div>{onClose && <button type="button" className="btn-secondary" onClick={onClose}>Close queue</button>}</header>
    {visible && error && <p role="alert" className="followup-queue-error">{error}</p>}
    {visible && message && <p role="status">{message}</p>}
    {visible && remoteChange && <p role="status">Updated from another device.</p>}
    {(!visible || loading) && <p role="status">Loading queue…</p>}
    <div className="followup-queue-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => void load(scope.current, true, true)}>Reload queue</button>
      {host && <button type="button" className="btn-secondary" disabled={blocked} onClick={() => mutate({ kind: host.mode === 'held' ? 'resume' : 'pause' })}>{host.mode === 'held' ? 'Resume queue' : 'Pause queue'}</button>}
      {host && (draft?.wakeRecovery || (host.mode === 'running' && host.order.length > 0)) && <button type="button" className="btn-secondary" disabled={blocked || host.mode !== 'running'} onClick={() => mutate({ kind: 'wake' })}>Wake queue</button>}
    </div>
    {host && draft && <>
      <p role="status">{host.mode === 'running' ? 'Queue runs at the next available turn.' : host.holdReason === 'restart' ? 'Queue held after a server restart. Review the messages, then resume.' : host.holdReason === 'dispatch_error' ? 'Queue held. Check the conversation first: an interrupted action may already have been sent. To send an unsent message manually, copy it, remove it from the queue, then send it in the conversation.' : host.holdReason === 'manual' ? 'Queue paused. Adding messages keeps it held.' : 'Queue has not started yet.'}</p>
      {!allowed && <p>This host does not allow agent execution.</p>}
      {draft.wakeRecovery && <div className="followup-queue-pending"><p>{host.mode === 'running' ? 'A recovered queue action was saved, but processing may not have started. Wake the running queue if it stays idle.' : 'The queue is held. Check the conversation before manually sending unsent work; a wake will not release the hold.'}</p><div className="followup-queue-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => updateLocal({ wakeRecovery: null })}>Dismiss wake reminder</button></div></div>}
      {draft.pending && <div className="followup-queue-pending"><p>This queue action is awaiting confirmation. A new action will not replace its identity.</p><code>{draft.pending.mutation.operationId}</code><button type="button" className="btn-secondary" disabled={busy || !allowed} onClick={() => void perform(scope.current, localRef.current.pending, true, true)}>Retry same queue action</button></div>}
      {corruptLocal && <button type="button" className="btn-secondary" onClick={() => { const next = emptyLocal(scope.current.home, sessionId); if (saveLocal(scope.current, next, true)) { setCorruptLocal(false); setError(''); } }}>Clear saved queue draft</button>}
      <form aria-label="New queued message" onSubmit={event => { event.preventDefault(); mutate({ kind: 'enqueue', itemId: createUuid(), text: draft.draftText, runWhenIdle: true }); }}>
        <label htmlFor={`${prefix}-new`}>Queued message</label><textarea id={`${prefix}-new`} value={draft.draftText} maxLength={100_000} rows={3} onChange={event => updateLocal({ draftText: event.target.value })} />
        <button type="submit" className="btn-primary" disabled={blocked}>Queue message</button>
      </form>
      {editing && <form aria-label="Edit queue item" onSubmit={event => { event.preventDefault(); mutate({ kind: 'edit', itemId: editing.itemId, expectedItemRevision: editing.revision, text: editing.text }); }}>
        {editedElsewhere && <p role="alert">This message changed on another device. Saving will be rejected; copy your edit, cancel, and reopen the message.</p>}<label htmlFor={`${prefix}-edit`}>Edit queued message</label><textarea id={`${prefix}-edit`} value={editing.text} maxLength={100_000} rows={3} onChange={event => updateLocal({ editor: { ...editing, text: event.target.value, localRevision: (editing.localRevision || 0) + 1 } })} />
        <div className="followup-queue-actions"><button type="submit" className="btn-primary" disabled={blocked}>Save queued edit</button><button type="button" className="btn-secondary" onClick={() => updateLocal({ editor: null })}>Cancel queued edit</button></div>
      </form>}
      {pendingItems.length > 0 && <p className="followup-queue-note">Send now and steering are unavailable: this host runs queued messages one at a time after the current turn. Run next moves a message to the front of the queue.</p>}
      <ol className="followup-queue-items">{pendingItems.map((item, index) => <li key={item.itemId} draggable={!blocked} onDragStart={() => setDragId(item.itemId)} onDragEnd={() => setDragId(null)} onDragOver={event => { if (dragId) event.preventDefault(); }} onDrop={event => { event.preventDefault(); dropOn(index); }}>
        <p className="followup-queue-text">{item.text}</p>{saving.has(item.itemId) && <span className="followup-queue-saving">Saving…</span>}<div className="followup-queue-actions">
          <button type="button" className="btn-secondary followup-queue-handle" aria-label={`Reorder message ${index + 1}`} title="Drag, or use the arrow keys, to reorder" disabled={blocked} onKeyDown={event => arrow(event, index)}>⠿</button>
          <button type="button" className="btn-secondary" aria-label={`Edit message ${index + 1}`} disabled={blocked} onClick={() => updateLocal({ editor: { itemId: item.itemId, revision: item.revision, text: item.text, localRevision: 0 } })}>Edit</button>
          <button type="button" className="btn-secondary" aria-label={`Promote message ${index + 1}`} disabled={blocked} onClick={() => mutate({ kind: 'promote', itemId: item.itemId, expectedItemRevision: item.revision })}>Run next</button>
          <button type="button" className="btn-secondary" aria-label={`Move message ${index + 1} up`} disabled={blocked || index === 0} onClick={() => move(index, -1)}>Move up</button>
          <button type="button" className="btn-secondary" aria-label={`Move message ${index + 1} down`} disabled={blocked || index === pendingItems.length - 1} onClick={() => move(index, 1)}>Move down</button>
          <button type="button" className="btn-secondary" aria-label={`Remove message ${index + 1}`} disabled={blocked} onClick={() => mutate({ kind: 'remove', itemId: item.itemId, expectedItemRevision: item.revision })}>Remove</button>
        </div></li>)}</ol>
      {!pendingItems.length && !dispatching.length && <p>No messages waiting.</p>}
      {dispatching.map(item => <div key={item.itemId} className="followup-queue-pending"><p className="followup-queue-text">{item.text}</p><p>Checking message acceptance. Editing and removal wait until this action is confirmed.</p></div>)}
      {count > 0 && <p>{count} {count === 1 ? 'message has' : 'messages have'} been accepted by V4.</p>}
    </>}
  </section>;
}
