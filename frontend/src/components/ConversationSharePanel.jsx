import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import './CollaborationPanel.css';

const EXPIRIES = [[3600, '1 hour'], [21600, '6 hours'], [86400, '24 hours']];
const AUDIT = {
  created: 'Link created', redeemed: 'Guest joined', exchange_denied: 'Link reuse or invalid attempt blocked', revoked: 'Sharing stopped',
  expired: 'Link expired', message_proposed: 'Guest suggested a message', approved: 'You approved a guest message',
  dismissed: 'You dismissed a guest message', session_unavailable: 'Conversation became unavailable; access ended',
  owner_signed_out: 'Sharing stopped because you signed out or changed your password',
};
const STATES = { unredeemed: 'Waiting for a guest to open the link', active: 'Guest joined', expired: 'Expired', revoked: 'Sharing stopped' };

async function request(sessionId, path, options = {}) {
  const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/shares${path}`, { ...options, home: true });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Share request failed (${response.status})`);
  return data;
}

const subscribeScope = listener => {
  const stopAuth = subscribeAuth(listener);
  const stopEnvironment = subscribeEnvironment(listener);
  return () => { stopAuth(); stopEnvironment(); };
};
const environmentEpochs = new WeakMap();
let nextEnvironmentEpoch = 0;
const environmentEpoch = value => {
  if (!value) return 0;
  if (!environmentEpochs.has(value)) environmentEpochs.set(value, ++nextEnvironmentEpoch);
  return environmentEpochs.get(value);
};
const scopeSnapshot = () => {
  const auth = captureAuthScope();
  const environment = getActiveEnvironment();
  return JSON.stringify([auth.generation, auth.session, auth.home, auth.userId, environmentEpoch(getEnvironmentSignal()), environmentEpoch(environment)]);
};

export function ConversationSharePanel({ sessionId, onInsertPrompt, pollMs = 5000 }) {
  const identity = useSyncExternalStore(subscribeScope, scopeSnapshot);
  return <ConversationShareScope key={JSON.stringify([identity, sessionId])} sessionId={sessionId} onInsertPrompt={onInsertPrompt} pollMs={pollMs} />;
}

function ConversationShareScope({ sessionId, onInsertPrompt, pollMs }) {
  const id = useId();
  const auth = useRef(captureAuthScope()).current;
  const environmentSignal = useRef(getEnvironmentSignal()).current;
  const environmentSnapshot = useRef(scopeSnapshot()).current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = useCallback(() => mounted.current && isAuthScopeCurrent(auth) && !environmentSignal.aborted && scopeSnapshot() === environmentSnapshot, [auth, environmentSignal, environmentSnapshot]);
  const [shares, setShares] = useState([]);
  const [audit, setAudit] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [expiresInSeconds, setExpires] = useState(86400);
  const [allowGuestMessages, setAllow] = useState(false);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const remote = Boolean(getActiveEnvironment());
  const scope = useRef(sessionId);

  const reload = useCallback(async signal => {
    const data = await request(sessionId, '', { signal });
    if (signal?.aborted || scope.current !== sessionId || !isCurrent()) return;
    setShares(data.shares || []); setAudit(data.audit || []); setLoaded(true);
  }, [sessionId, isCurrent]);

  useEffect(() => {
    scope.current = sessionId;
    setShares([]); setAudit([]); setLoaded(false); setLink(''); setError(''); setMessage('');
    if (remote || !sessionId) return undefined;
    const controller = new AbortController();
    let timer;
    const tick = async () => {
      try { await reload(controller.signal); } catch (failure) { if (!controller.signal.aborted && isCurrent()) setError(failure.message); }
      if (!controller.signal.aborted && pollMs > 0) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, remote, reload, pollMs, isCurrent]);

  async function act(work) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); if (isCurrent()) await reload(); } catch (failure) { if (isCurrent()) setError(failure.message); } finally { if (isCurrent()) setBusy(false); }
  }

  const create = event => {
    event.preventDefault();
    if (busy || remote) return;
    void act(async () => {
      const issued = await request(sessionId, '', { method: 'POST', body: { expiresInSeconds, allowGuestMessages } });
      if (isCurrent()) setLink(`${window.location.origin}/#share=${encodeURIComponent(issued.id)}.${encodeURIComponent(issued.secret)}`);
    });
  };
  const decide = (share, proposal, decision) => act(async () => {
    const result = await request(sessionId, `/${encodeURIComponent(share.id)}/proposals/${encodeURIComponent(proposal.id)}`, { method: 'POST', body: { decision } });
    if (scope.current !== sessionId || !isCurrent()) return;
    if (decision === 'approve') {
      if (onInsertPrompt) { onInsertPrompt(result.text); setMessage('Approved. The message is in your composer; review and send it yourself.'); }
      else setMessage(`Approved. Copy this message into the composer: ${result.text}`);
    }
  });

  return <section className="collaboration-panel conversation-share" aria-label="Conversation sharing">
    <header><h3>Share this conversation</h3></header>
    <p role="note">A guest can read this one conversation's messages and nothing else. They cannot see tool output, approvals, files, other conversations or terminals, and cannot make the agent do anything. The link works once and expires on its own; you can stop sharing at any time and access ends on the guest's next request.</p>
    {remote && <p role="status">Open Terminal v4 directly on the owning server to share a conversation.</p>}
    <form onSubmit={create}>
      <label>Link expires after<select value={expiresInSeconds} onChange={event => setExpires(Number(event.target.value))}>{EXPIRIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label htmlFor={`${id}-allow`}><span><input id={`${id}-allow`} type="checkbox" checked={allowGuestMessages} onChange={event => setAllow(event.target.checked)} /> Let the guest suggest messages</span></label>
      {allowGuestMessages && <p>Suggestions never reach the agent on their own: you approve each one and send it yourself.</p>}
      <button disabled={busy || remote || !sessionId}>Create read-only link</button>
    </form>
    {link && <div><label>Share link<input readOnly value={link} onFocus={event => event.target.select()} /></label><p>Copy this link now. It is shown once, works for one guest, and anyone who has it can read this conversation until it expires or you stop sharing.</p></div>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loaded && shares.length === 0 && <p>No share links for this conversation.</p>}
    {shares.map(share => <article key={share.id}>
      <strong>{STATES[share.state] || share.state}</strong>{share.guestName && <span>{share.guestName}</span>}
      <p>{share.allowGuestMessages ? 'Read-only; guest suggestions need your approval' : 'Read-only'} · expires {new Date(share.expiresAt * 1000).toLocaleString()}{share.lastSeenAt ? ` · last seen ${new Date(share.lastSeenAt * 1000).toLocaleString()}` : ''}</p>
      {(share.proposals || []).filter(proposal => proposal.status === 'pending').map(proposal => <div key={proposal.id}>
        <p><strong>{proposal.guestName} suggests:</strong></p><p>{proposal.text}</p>
        <button type="button" disabled={busy} aria-label={`Approve and add to composer: ${proposal.text}`} onClick={() => void decide(share, proposal, 'approve')}>Approve and add to composer</button>{' '}
        <button type="button" disabled={busy} aria-label={`Dismiss: ${proposal.text}`} onClick={() => void decide(share, proposal, 'dismiss')}>Dismiss</button>
      </div>)}
      {(share.proposals || []).filter(proposal => proposal.status === 'approved').map(proposal => <div key={proposal.id}>
        <p><strong>Approved suggestion from {proposal.guestName}:</strong></p><p>{proposal.text}</p>
        <p>Add it again only if it is missing from your draft.</p>
        {onInsertPrompt && <button type="button" disabled={busy || remote} aria-label={`Add approved suggestion to composer: ${proposal.text}`} onClick={() => { onInsertPrompt(proposal.text); setMessage('Added to your composer; review and send it yourself.'); }}>Add to composer</button>}
      </div>)}
      {(share.state === 'unredeemed' || share.state === 'active') && <button type="button" disabled={busy || remote} aria-label={`Stop sharing ${share.id}`} onClick={() => void act(() => request(sessionId, `/${encodeURIComponent(share.id)}`, { method: 'DELETE' }))}>Stop sharing</button>}
    </article>)}
    {audit.length > 0 && <details><summary>Activity</summary><ul>{audit.slice(0, 20).map((entry, index) => <li key={`${entry.at}-${index}`}>{AUDIT[entry.kind] || entry.kind}{entry.detail ? `: ${entry.detail}` : ''} <time>{new Date(entry.at * 1000).toLocaleString()}</time></li>)}</ul></details>}
  </section>;
}
