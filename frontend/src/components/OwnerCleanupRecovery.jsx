import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment } from '../utils/remoteEnvironments';
import { sha256Bytes } from '../utils/sha256';
import DelegationCleanupReview from './DelegationCleanupReview';
import OwnershipRecovery from './OwnershipRecovery';
import './OwnerCleanupRecovery.css';

const resourceStates = ['pending', 'confirmed', 'unconfirmed', 'unavailable'];
const labels = { structured: 'Agent sessions', delegation: 'Delegated tasks', background: 'Background processes' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function reviewOperation(auth, requestId) {
  if (!auth.userId || !auth.home || !UUID.test(requestId)) throw new Error('Review scope unavailable');
  const hash = await sha256Bytes(new TextEncoder().encode(JSON.stringify(['background-cleanup-review-v1', auth.home, auth.userId, requestId.toLowerCase()])));
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = Array.from(hash.slice(0, 16), value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseStatus(value) {
  if (!value || !['complete', 'pending', 'review_required', 'unavailable'].includes(value.state)
    || !(value.requestId === null || (typeof value.requestId === 'string' && value.requestId.length <= 256))
    || (value.backgroundReview !== undefined && !['none', 'user_attested'].includes(value.backgroundReview))
    || (value.delegationReview !== undefined && !['none', 'user_attested'].includes(value.delegationReview))
    || !value.resources || !resourceStates.includes(value.resources.structured) || !resourceStates.includes(value.resources.delegation)
    || ![...resourceStates, 'not_installed'].includes(value.resources.background)) throw new Error('Invalid cleanup status');
  if (value.state === 'complete' && (value.resources.structured !== 'confirmed' || value.resources.delegation !== 'confirmed'
    || !['confirmed', 'not_installed'].includes(value.resources.background))) throw new Error('Inconsistent cleanup status');
  return { state: value.state, requestId: value.requestId, backgroundReview: value.backgroundReview || 'none', delegationReview: value.delegationReview || 'none', resources: value.resources };
}

export default function OwnerCleanupRecovery({ onResolved }) {
  const [view, setView] = useState(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [reviewBlocked, setReviewBlocked] = useState(false);
  const active = useRef(null), busyRef = useRef(false), resolved = useRef(onResolved);
  resolved.current = onResolved;

  useEffect(() => {
    const auth = captureAuthScope(), controller = new AbortController();
    let mounted = true;
    const current = () => mounted && !controller.signal.aborted && isAuthScopeCurrent(auth);
    const invalidate = () => { if (!isAuthScopeCurrent(auth)) { controller.abort(); if (mounted) { setView(null); setBusy(false); setFailure(''); } } };
    const unsubscribe = subscribeAuth(invalidate);
    const task = { auth, current, signal: controller.signal };
    active.current = task; busyRef.current = false; setBusy(false); setView(null); setFailure(''); setReviewChecked(false); setReviewBlocked(false);
    (async () => {
      try {
        const response = await apiFetch('/api/structured/owner-cleanup', { home: true, signal: task.signal, cache: 'no-store' });
        if (!current()) return;
        if (response.status === 404) return;
        if (!response.ok) throw new Error('Status unavailable');
        const status = parseStatus(await response.json());
        if (current() && (status.state !== 'complete' || status.backgroundReview === 'user_attested' || status.delegationReview === 'user_attested')) setView(status);
      } catch { if (current()) setView({ state: 'error' }); }
    })();
    return () => { mounted = false; controller.abort(); unsubscribe(); if (active.current === task) active.current = null; };
  }, [attempt]);

  async function retry() {
    const task = active.current;
    if (!task?.current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFailure('');
    try {
      const response = await apiFetch('/api/structured/owner-cleanup/retry', { home: true, method: 'POST', signal: task.signal });
      if (!task.current()) return;
      if (!response.ok) throw new Error('Retry unavailable');
      const status = parseStatus(await response.json());
      if (!task.current()) return;
      if (status.requestId !== view?.requestId) setReviewChecked(false);
      setReviewBlocked(false);
      setView(status);
      if (status.state === 'complete') resolved.current?.();
    } catch { if (task.current()) setFailure('Cleanup retry could not be confirmed. Check the connection and try again.'); }
    finally { if (task.current()) { busyRef.current = false; setBusy(false); } }
  }

  async function checkStatus() {
    const task = active.current;
    if (!task?.current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setFailure('');
    try {
      const response = await apiFetch('/api/structured/owner-cleanup', { home: true, signal: task.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Status unavailable');
      const status = parseStatus(await response.json());
      if (!task.current()) return;
      if (status.requestId !== view?.requestId) setReviewChecked(false);
      setView(status); setReviewBlocked(false);
      if (status.state === 'complete') resolved.current?.();
    } catch { if (task.current()) setFailure('Cleanup status could not be confirmed. Check the connection and try again.'); }
    finally { if (task.current()) { busyRef.current = false; setBusy(false); } }
  }

  async function reviewBackground() {
    const task = active.current, requestId = view?.requestId;
    if (!task?.current() || busyRef.current || !reviewChecked || reviewBlocked || !UUID.test(requestId || '')
      || view.state !== 'review_required' || view.resources?.background !== 'unconfirmed') return;
    busyRef.current = true; setBusy(true); setFailure('');
    let receiptConfirmed = false;
    try {
      const operationId = await reviewOperation(task.auth, requestId);
      if (!task.current()) return;
      const response = await apiFetch('/api/structured/owner-cleanup/background-review', {
        home: true, method: 'POST', signal: task.signal, body: { requestId, operationId, acknowledged: true },
      });
      const receipt = await response.json().catch(() => null);
      if (!task.current()) return;
      if (!response.ok || receipt?.status !== 'reviewed' || receipt.requestId !== requestId || receipt.operationId !== operationId
        || !Number.isSafeInteger(receipt.reviewedCount) || receipt.reviewedCount < 0) throw new Error('Review not confirmed');
      receiptConfirmed = true;
      setReviewChecked(false); setReviewBlocked(true);
      const statusResponse = await apiFetch('/api/structured/owner-cleanup', { home: true, signal: task.signal, cache: 'no-store' });
      if (!statusResponse.ok) throw new Error('Status unavailable');
      const status = parseStatus(await statusResponse.json());
      if (!task.current()) return;
      if (status.requestId === requestId && status.resources.background === 'unconfirmed' && status.backgroundReview !== 'user_attested') throw new Error('Review not reflected');
      setView(status); setReviewBlocked(false);
      if (status.state === 'complete') resolved.current?.();
    } catch { if (task.current()) { setReviewBlocked(true); setFailure(receiptConfirmed ? 'Your confirmation was recorded, but cleanup status could not be checked. Check the status again.' : 'Background review could not be confirmed. Check cleanup status before retrying.'); } }
    finally { if (task.current()) { busyRef.current = false; setBusy(false); } }
  }

  if (!view) return null;
  const pending = view.state === 'pending', complete = view.state === 'complete';
  return <section className="owner-cleanup-recovery" aria-label="Sign-out cleanup" role="region">
    <p role={view.state === 'error' || view.state === 'unavailable' ? 'alert' : 'status'}>
      {complete ? (view.backgroundReview === 'user_attested' ? 'You confirmed background processes stopped during a previous cleanup review. The server did not verify the processes or their outcomes.' : 'Sign-out cleanup is complete.') : pending ? 'Sign-out cleanup is still pending. Work may still be stopping.' : 'Sign-out cleanup could not be confirmed. Check the server before continuing.'}
    </p>
    {view.resources && !complete && <ul>{Object.entries(labels).map(([key, label]) => {
      const state = view.resources[key];
      if (['confirmed', 'not_installed'].includes(state)) return null;
      return <li key={key}>{label}: {state === 'pending' ? 'still stopping' : 'could not be confirmed'}</li>;
    })}</ul>}
    {view.state === 'review_required' && view.resources?.structured === 'unconfirmed' && (getActiveEnvironment()
      ? <p>Switch to the home server to review session ownership.</p>
      : <OwnershipRecovery onResolved={() => setAttempt(value => value + 1)} />)}
    {view.backgroundReview === 'user_attested' && !complete && <p>Your background-process confirmation was recorded; the server did not verify the processes or their outcomes.</p>}
    {view.delegationReview === 'user_attested' && <p>You confirmed delegated-child processes stopped during {complete ? 'a previous cleanup review' : 'this cleanup review'}. The server did not verify the processes or their outcomes.</p>}
    {view.state === 'review_required' && view.resources?.delegation === 'unconfirmed' && UUID.test(view.requestId || '') && <DelegationCleanupReview key={view.requestId} requestId={view.requestId} onReviewed={checkStatus} />}
    {view.state === 'review_required' && view.resources?.background === 'unconfirmed' && UUID.test(view.requestId || '') && view.backgroundReview !== 'user_attested' && <div className="owner-cleanup-background-review">
      <p>Individual processes cannot be identified from the saved records. On the host, inspect and stop all Terminal V4 background processes. The server cannot verify that they have stopped. If you cannot verify this, leave cleanup pending.</p>
      <label><input type="checkbox" checked={reviewChecked} disabled={busy} onChange={event => setReviewChecked(event.target.checked)} /> I personally checked that all associated background processes have stopped.</label>
      <button type="button" disabled={!reviewChecked || reviewBlocked || busy} onClick={reviewBackground}>Confirm background review</button>
    </div>}
    {failure && <p role="alert">{failure}</p>}
    {reviewBlocked && <button type="button" disabled={busy} onClick={checkStatus}>Check cleanup status</button>}
    {!complete && <button type="button" disabled={busy} onClick={retry}>{busy ? 'Checking cleanup…' : 'Retry cleanup'}</button>}
    {complete && <button type="button" onClick={() => setView(null)}>Dismiss</button>}
  </section>;
}
