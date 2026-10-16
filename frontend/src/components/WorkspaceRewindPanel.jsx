import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './WorkspaceRewindPanel.css';

export function WorkspaceRewindPanel({ workspacePath = '', onSelectSession }) {
  const [data, setData] = useState(null);
  const [sourceId, setSourceId] = useState('');
  const [targetTurnId, setTargetTurnId] = useState('');
  const [checkpointId, setCheckpointId] = useState('');
  const [operation, setOperation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef(null);

  const request = useCallback(async (suffix = '', body) => {
    const response = await apiFetch('/api/workspace/rewind' + suffix + (body ? '' : '?' + new URLSearchParams({ path: workspacePath })), {
      ...(body ? { method: 'POST', body: { path: workspacePath, ...body } } : {}),
      signal: controller.current?.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to update conversation rewind');
    return result;
  }, [workspacePath]);
  const load = useCallback(async () => {
    const version = generation.current;
    const result = await request();
    if (version === generation.current && !controller.current?.signal.aborted) setData(result);
  }, [request]);
  useEffect(() => {
    generation.current += 1;
    const version = generation.current;
    controller.current = new AbortController();
    setData(null); setOperation(null); setSourceId(''); setTargetTurnId(''); setCheckpointId(''); setError(''); setBusy(false);
    if (workspacePath) load().catch(failure => { if (version === generation.current && !controller.current.signal.aborted) setError(failure.message); });
    return () => { generation.current += 1; controller.current?.abort(); };
  }, [load, workspacePath]);
  async function perform(action) {
    const version = generation.current;
    setBusy(true); setError('');
    try { await action(version); }
    catch (failure) { if (version === generation.current) setError(failure.message || 'Rewind failed'); }
    finally { if (version === generation.current) setBusy(false); }
  }
  function choose(setter, value) { setter(value); setOperation(null); }
  const conversation = data?.conversations?.find(item => item.sourceId === sourceId);
  const targetTurn = conversation?.turns?.find(item => item.id === targetTurnId);
  const checkpoint = data?.checkpoints?.find(item => item.id === checkpointId);
  const operations = [...(operation ? [operation] : []), ...(data?.operations || []).filter(item => item.id !== operation?.id)];
  async function updateOperation(id, action, version) {
    const result = await request('/' + encodeURIComponent(id) + '/' + action, {});
    if (version !== generation.current) return;
    setOperation(result.operation || result);
    await load();
    if (action === 'resume' && result.session?.id) await onSelectSession?.(result.session.id);
  }
  return <div className="workspace-rewind-panel">
    <h3>Conversation rewind</h3>
    <p>Choose a native conversation turn and a files checkpoint. Rewind forks the provider conversation before that user turn and restores the selected files in this isolated worktree.</p>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading native conversations and checkpoints…</p>}
    {data && !data.managed && <p role="note">Create an isolated worktree in Git &amp; worktrees first. Coordinated rewind requires a managed checkout and a saved files checkpoint.</p>}
    <div className="workspace-rewind-fields">
      <label>Native conversation<select value={sourceId} disabled={busy || !data} onChange={event => { choose(setSourceId, event.target.value); setTargetTurnId(''); }}>
        <option value="">Select conversation</option>
        {data?.conversations?.map(item => <option key={item.sourceId} value={item.sourceId}>{item.title} ({item.provider})</option>)}
      </select></label>
      <label>Rewind before user turn<select value={targetTurnId} disabled={busy || !conversation} onChange={event => choose(setTargetTurnId, event.target.value)}>
        <option value="">Select user turn</option>
        {conversation?.turns?.map(turn => <option key={turn.id} value={turn.id} disabled={turn.supported === false} title={turn.reason || ''}>{Number(turn.ordinal) + 1}. {turn.prompt}{turn.supported === false ? ' — ' + turn.reason : ''}</option>)}
      </select></label>
      <label>Files checkpoint<select value={checkpointId} disabled={busy || !data} onChange={event => choose(setCheckpointId, event.target.value)}>
        <option value="">Select checkpoint</option>
        {data?.checkpoints?.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
      </select></label>
    </div>
    {data?.conversations?.length === 0 && <p>No native conversations with supported turn boundaries were found in this workspace.</p>}
    {data?.checkpoints?.length === 0 && <p>Create a files checkpoint from Git &amp; worktrees before planning a rewind.</p>}
    <button type="button" disabled={busy || !data?.managed || !sourceId || !targetTurnId || targetTurn?.supported === false || !checkpointId} onClick={() => perform(async version => {
      const result = await request('/plan', { sourceId, targetTurnId, checkpointId });
      if (version === generation.current) setOperation(result.operation || result);
    })}>Review rewind plan</button>
    {operation?.status === 'planned' && <section className="workspace-rewind-confirm" aria-label="Rewind plan">
      <h4>Review this rewind</h4>
      <p>Conversation: <strong>{conversation?.title || operation.sourceId}</strong>. Rewind before turn {targetTurn ? Number(targetTurn.ordinal) + 1 : operation.targetTurnId}:</p>
      {targetTurn && <blockquote>{targetTurn.prompt}</blockquote>}
      <p>Restore files checkpoint: <strong>{checkpoint?.label || operation.checkpointId}</strong>.</p>
      <p>A recovery checkpoint saves your current files before restoration. Original conversation stays available. The resumed conversation uses a new native session.</p>
      <p>Suspend live terminals below and interrupt any streaming structured agent before applying so they cannot keep changing these files.</p>
      <button type="button" disabled={busy} onClick={() => perform(version => updateOperation(operation.id, 'apply', version))}>Apply rewind</button>
    </section>}
    {data?.activeSessions?.length > 0 && <section aria-label="Live workspace sessions"><h4>Live sessions</h4><p>Suspending stops the current process and preserves its saved conversation.</p>
      {data.activeSessions.map(session => <div className="workspace-rewind-row" key={session.id}><span>{session.title || session.id}</span><button type="button" disabled={busy} aria-label={'Suspend ' + (session.title || session.id)} onClick={() => perform(async () => { await request('/suspend', { sessionId: session.id }); await load(); })}>Suspend</button></div>)}
    </section>}
    {operations.length > 0 && <section aria-label="Rewind operations"><h4>Rewind operations</h4>
      {operations.map(item => <div className="workspace-rewind-operation" key={item.id}><div><strong>{item.status}</strong><small>{item.id}</small></div>
        {item.error && <p>{item.error}</p>}
        {item.recoveryCheckpointId && <small>Recovery checkpoint: {item.recoveryCheckpointId}</small>}
        {['applied', 'resumed'].includes(item.status) && <button type="button" disabled={busy || !onSelectSession} onClick={() => perform(version => updateOperation(item.id, 'resume', version))}>Open resumed conversation</button>}
        {item.recoveryCheckpointId && !['planned', 'recovered'].includes(item.status) && <><p>Recovery restores the files saved immediately before this rewind.</p><button type="button" disabled={busy} aria-label={'Recover files for ' + item.id} onClick={() => perform(version => updateOperation(item.id, 'recover', version))}>Recover previous files</button></>}
      </div>)}
    </section>}
  </div>;
}
