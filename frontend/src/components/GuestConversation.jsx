import { useEffect, useRef, useState } from 'react';
import { resolveHomeApiUrl } from '../utils/apiBase';
import './GuestWorkspace.css';

export function hasGuestShare() { return window.location.hash.startsWith('#share='); }
function shareLink() {
  const value = window.location.hash.slice('#share='.length);
  const separator = value.indexOf('.');
  if (separator < 1) return null;
  try { return { id: decodeURIComponent(value.slice(0, separator)), secret: decodeURIComponent(value.slice(separator + 1)) }; } catch { return null; }
}
const ROLES = { user: 'Owner', assistant: 'Agent' };

export function GuestConversation({ pollMs = 3000 }) {
  const [link] = useState(shareLink);
  const [name, setName] = useState('Guest');
  const [access, setAccess] = useState(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [ended, setEnded] = useState(false);
  const [busy, setBusy] = useState(false);
  const controller = useRef(null);
  const timer = useRef(null);
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer'; meta.content = 'no-referrer';
    document.head.appendChild(meta);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return () => { meta.remove(); controller.current?.abort(); clearTimeout(timer.current); };
  }, []);

  async function call(path, options = {}, credential = access?.credential) {
    const response = await fetch(resolveHomeApiUrl(path), {
      ...options, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.current?.signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  function stop(text) { clearTimeout(timer.current); setEnded(true); setStatus(text); }

  function follow(grant) {
    let cursor = 0; let generation;
    const base = `/api/structured-share/guest/${encodeURIComponent(grant.sessionId)}/messages`;
    const tick = async () => {
      let delay = pollMs;
      try {
        const query = new URLSearchParams({ after: String(cursor), ...(generation ? { generation } : {}) });
        const { response, data } = await call(`${base}?${query}`, {}, grant.credential);
        if (controller.current.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) { stop('Sharing has ended. The owner stopped it or the link expired.'); return; }
        if (response.status === 409) { cursor = 0; generation = undefined; setMessages([]); delay = 500; }
        else if (response.status === 429) { delay = pollMs * 4; setStatus('Slowing down; too many requests.'); }
        else if (response.ok) {
          generation = data.generation; cursor = data.cursor;
          setTitle(data.title || ''); setProposals(data.proposals || []);
          if (data.messages.length) setMessages(current => [...current, ...data.messages]);
          setStatus('');
          if (!data.caughtUp) delay = 100;
        } else setStatus('Could not refresh. Retrying…');
      } catch { if (!controller.current.signal.aborted) setStatus('Connection interrupted. Retrying…'); }
      if (!controller.current.signal.aborted) timer.current = setTimeout(tick, delay);
    };
    void tick();
  }

  async function join(event) {
    event.preventDefault();
    if (!link || busy) return;
    setBusy(true); setStatus('Opening…');
    controller.current = new AbortController();
    try {
      const { response, data } = await call('/api/structured-share/exchange', { method: 'POST', body: JSON.stringify({ ...link, displayName: name }) }, null);
      if (!response.ok) throw new Error(response.status === 401 ? 'This link is invalid, was already used, or has expired. Ask the owner for a new one.' : data?.error || 'This link is unavailable.');
      setAccess(data); setStatus(''); follow(data);
    } catch (failure) { if (!controller.current.signal.aborted) setStatus(failure.message); } finally { setBusy(false); }
  }

  async function suggest(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || ended) return;
    setBusy(true);
    try {
      const { response, data } = await call(`/api/structured-share/guest/${encodeURIComponent(access.sessionId)}/proposals`, { method: 'POST', body: JSON.stringify({ text }) });
      if (!response.ok) throw new Error(data?.error || 'The owner could not receive this message.');
      setDraft(''); setNotice('Sent to the owner. It reaches the agent only if they approve it.');
    } catch (failure) { setNotice(failure.message); } finally { setBusy(false); }
  }

  return <main className="guest-workspace">
    <header><h1>{title || 'Shared conversation'}</h1><p>You can read this conversation's messages. Tool output, approvals, files and other conversations are not shared, and the owner can stop sharing at any time.</p></header>
    {!access && !ended && <form onSubmit={join}><label>Your name<input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button disabled={!link || busy}>Open conversation</button>{!link && <p role="alert">Share link is incomplete.</p>}</form>}
    {status && <p className="guest-connection-status" role={ended ? 'alert' : 'status'}>{status}</p>}
    {access && <section aria-label="Conversation messages">
      <p className="guest-access-summary">Read-only · access ends {new Date(access.expiresAt * 1000).toLocaleString()}</p>
      {messages.length === 0 && !ended && <p>No messages yet.</p>}
      {messages.map(message => <article key={message.seq}><strong>{ROLES[message.role] || message.role}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p></article>)}
      {access.allowGuestMessages && !ended && <form onSubmit={suggest}><label>Suggest a message to the owner<input maxLength={4000} value={draft} onChange={event => setDraft(event.target.value)} /></label><button disabled={busy || !draft.trim()}>Send suggestion</button></form>}
      {notice && <p role="status">{notice}</p>}
      {proposals.length > 0 && <ul aria-label="Your suggestions">{proposals.map(proposal => <li key={proposal.id}>Suggestion {proposal.status === 'pending' ? 'waiting for the owner' : proposal.status}</li>)}</ul>}
    </section>}
  </main>;
}
