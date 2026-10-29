import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { getActiveEnvironment } from '../utils/remoteEnvironments';
import { ConversationSharePanel } from './ConversationSharePanel';
import './CollaborationPanel.css';
async function request(path, options = {}) {
  const response = await apiFetch('/api/collaboration/invitations' + path, { ...options, home: true });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Invitation request failed');
  return data;
}
export function CollaborationPanel({ workspacePath, sessionId, onInsertPrompt }) {
  const [items, setItems] = useState([]);
  const [role, setRole] = useState('observer');
  const [expiresInSeconds, setExpiry] = useState(3600);
  const [maxUses, setMaxUses] = useState(1);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const remote = Boolean(getActiveEnvironment());
  const structured = isStructuredSessionId(sessionId) || sessionId?.startsWith('structured:');
  const canShare = !!sessionId && !structured;
  const reload = useCallback(async (signal) => {
    setLoading(true);
    try {
      const data = await request('?workspacePath=' + encodeURIComponent(workspacePath || ''), { signal });
      if (!signal?.aborted) { setItems(data.invitations || []); setLoaded(true); }
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [workspacePath]);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setLoaded(false); setLoading(false); setError('');
    if (!remote && !structured) reload(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [reload, remote, structured]);
  useEffect(() => { setLink(''); }, [workspacePath, sessionId]);
  if (structured) return <ConversationSharePanel sessionId={sessionId.replace(/^structured:/, '')} onInsertPrompt={onInsertPrompt} />;
  async function act(action) {
    setBusy(true); setError('');
    try { await action(); await reload(); } catch (error) { setError(error.message); } finally { setBusy(false); }
  }
  return <section className="collaboration-panel" aria-label="Workspace collaboration">
    <header><h3>Invite a collaborator</h3>
    <p>Share only this existing terminal and its output. Controller access lets the guest type commands in this terminal. To share a conversation instead, select it: guests then get a read-only link.</p></header>
    {remote && <p role="status">Open Terminal v4 directly on the owning server to issue invitations.</p>}
    {!sessionId && <p>Select an existing terminal to share.</p>}
    <form onSubmit={event => { event.preventDefault(); if (!canShare || busy || remote || !workspacePath) return; act(async () => {
      const issued = await request('', { method: 'POST', body: { workspacePath, sessionId, role, expiresInSeconds, maxUses } });
      setLink(window.location.origin + '/#invite=' + encodeURIComponent(issued.id) + '.' + encodeURIComponent(issued.secret));
    }); }}>
      <label>Guest permissions<select value={role} onChange={event => setRole(event.target.value)}><option value="observer">Observer: view output</option><option value="controller">Controller: type terminal input</option></select></label>
      <label>Expires after<select value={expiresInSeconds} onChange={event => setExpiry(Number(event.target.value))}><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={86400}>24 hours</option></select></label>
      <label>Guest limit<select value={maxUses} onChange={event => setMaxUses(Number(event.target.value))}>{[1,2,4,8].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button disabled={busy || remote || !workspacePath || !canShare}>Create invitation</button>
    </form>
    {link && <div><label>Invitation link<input readOnly value={link} onFocus={event => event.target.select()} /></label><p>Copy this link now. Its secret is shown once. Existing terminal output may contain private information.</p></div>}
    {error && <p role="alert">{error}</p>}
    <h3>Invitations and participants</h3><button type="button" disabled={busy || remote} onClick={() => act(async () => {})}>Refresh invitations</button>
    {loading && <p role="status">Loading invitations…</p>}
    {loaded && !loading && !error && items.length === 0 && <p>No invitations for this workspace.</p>}
    {items.map(item => <article key={item.id}>
      <strong>{item.role === 'controller' ? 'Controller' : 'Observer'}</strong> <span>{item.sessionId}</span>
      <p>Expires {new Date(item.expiresAt * 1000).toLocaleString()} · {item.uses}/{item.maxUses} guests · {item.revokedAt ? 'Revoked' : 'Issued'}</p>
      {(item.participants || []).map(person => <p key={person.id}><span>{person.displayName}</span> · last seen {new Date(person.lastSeenAt * 1000).toLocaleString()}</p>)}
      {!item.revokedAt && <button type="button" disabled={busy} aria-label={'Revoke ' + item.id} onClick={() => act(() => request('/' + item.id, { method: 'DELETE' }))}>Revoke access</button>}
    </article>)}
  </section>;
}
