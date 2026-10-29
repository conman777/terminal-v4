import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import './OwnerCleanupRecovery.css';

const URL_PATH = '/api/structured/background-review';

function newOperationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 0x40;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function BackgroundCommandReview() {
  const [state, setState] = useState('loading');
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''), [done, setDone] = useState(false);
  const active = useRef(null), locked = useRef(false), operation = useRef(null);

  async function inspect(task) {
    const response = await apiFetch(URL_PATH, { home: true, signal: task.signal, cache: 'no-store' });
    if (!task.current()) return null;
    if (response.status === 404) return 'unavailable';
    if (!response.ok) throw new Error('Status unavailable');
    const body = await response.json();
    if (typeof body?.unknown !== 'boolean') throw new Error('Invalid status');
    return body.unknown ? 'unknown' : 'clear';
  }

  useEffect(() => {
    const auth = captureAuthScope(), controller = new AbortController();
    let mounted = true;
    const current = () => mounted && !controller.signal.aborted && isAuthScopeCurrent(auth);
    const task = { auth, signal: controller.signal, current };
    active.current = task; locked.current = false; operation.current = null;
    setState('loading'); setChecked(false); setBusy(false); setBlocked(false); setError(''); setDone(false);
    const unsubscribe = subscribeAuth(() => { if (!isAuthScopeCurrent(auth)) { controller.abort(); if (mounted) { setState('unavailable'); setError(''); setDone(false); } } });
    (async () => {
      try { const next = await inspect(task); if (next && current()) setState(next); }
      catch { if (current()) setState('error'); }
    })();
    return () => { mounted = false; controller.abort(); unsubscribe(); if (active.current === task) active.current = null; };
  }, []);

  async function checkStatus() {
    const task = active.current;
    if (!task?.current() || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const next = await inspect(task);
      if (!next || !task.current()) return;
      setState(next); setBlocked(false);
      if (next === 'clear') operation.current = null;
    } catch { if (task.current()) setError('Background command status could not be confirmed. Check the connection and try again.'); }
    finally { if (task.current()) { locked.current = false; setBusy(false); } }
  }

  async function confirm() {
    const task = active.current;
    if (!task?.current() || locked.current || !checked || blocked || state !== 'unknown') return;
    locked.current = true; setBusy(true); setError('');
    let recorded = false;
    try {
      operation.current = operation.current || newOperationId();
      const operationId = operation.current;
      const response = await apiFetch(URL_PATH, { home: true, method: 'POST', signal: task.signal, body: { operationId, acknowledged: true } });
      const receipt = await response.json().catch(() => null);
      if (!task.current()) return;
      if (!response.ok || receipt?.status !== 'reviewed' || receipt.operationId !== operationId
        || !Number.isSafeInteger(receipt.reviewedCount) || receipt.reviewedCount < 0) throw new Error('Review not confirmed');
      recorded = true;
      setChecked(false); setBlocked(true);
      const next = await inspect(task);
      if (!next || !task.current()) return;
      if (next === 'unknown') throw new Error('Review not reflected');
      operation.current = null;
      setState(next); setBlocked(false); setDone(true);
    } catch { if (task.current()) { setBlocked(true); setError(recorded ? 'Your confirmation was recorded, but the background command status could not be checked. Check the status again.' : 'The review could not be confirmed. Check the status before retrying.'); } }
    finally { if (task.current()) { locked.current = false; setBusy(false); } }
  }

  if (state === 'loading' || state === 'unavailable') return null;
  if (state === 'error') return <section className="owner-cleanup-recovery" aria-label="Background commands" role="region">
    <p role="alert">Background command status could not be loaded.</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={checkStatus}>Check status</button>
  </section>;
  if (state === 'clear' && !done) return null;
  return <section className="owner-cleanup-recovery" aria-label="Background commands" role="region">
    {state === 'unknown'
      ? <>
        <p>A background command was left in an unknown state after the server stopped unexpectedly. New background commands are blocked until you review it. It is not run again, and the server cannot verify whether it stopped.</p>
        <p>Unknown commands: at least 1</p>
        <label><input type="checkbox" checked={checked} disabled={busy || blocked} onChange={event => setChecked(event.target.checked)} /> I personally checked that all associated background processes have stopped.</label>
        <button type="button" disabled={!checked || blocked || busy} onClick={confirm}>Confirm background command review</button>
      </>
      : <p role="status">You confirmed the background commands stopped. The server did not verify the processes or their outcomes.</p>}
    {error && <p role="alert">{error}</p>}
    {blocked && state === 'unknown' && <button type="button" disabled={busy} onClick={checkStatus}>Check status</button>}
    {state === 'clear' && <button type="button" onClick={() => setDone(false)}>Dismiss</button>}
  </section>;
}
