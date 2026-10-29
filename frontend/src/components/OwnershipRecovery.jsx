import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { sha256Bytes } from '../utils/sha256';
import './OwnershipRecovery.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function reviewOperation(scope, epoch) {
  if (!scope.userId || !scope.home || !UUID.test(epoch)) throw new Error('The review scope is unavailable.');
  const bytes = new TextEncoder().encode(JSON.stringify(['structured-ownership-review-v1', scope.home, scope.userId, epoch.toLowerCase()]));
  const hash = await sha256Bytes(bytes);
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = Array.from(hash.slice(0, 16), value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function OwnershipRecovery({ onResolved }) {
  const [view, setView] = useState({ state: 'checking' });
  const [acknowledged, setAcknowledged] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState('');
  const active = useRef(null);
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  useEffect(() => {
    const auth = captureAuthScope();
    const environmentSignal = getEnvironmentSignal();
    const controller = new AbortController();
    let mounted = true;
    const current = () => mounted && !controller.signal.aborted && !environmentSignal.aborted && isAuthScopeCurrent(auth);
    const invalidate = () => {
      controller.abort();
      if (mounted) { setView({ state: 'scope_changed' }); setAcknowledged(false); setFailure(''); setSubmitting(false); }
    };
    const unsubscribeAuth = subscribeAuth(() => { if (!isAuthScopeCurrent(auth)) invalidate(); });
    const unsubscribeEnvironment = subscribeEnvironment(invalidate);
    environmentSignal.addEventListener('abort', invalidate, { once: true });
    active.current = { auth, signal: controller.signal, current };
    setView({ state: 'checking' });
    setAcknowledged(false);
    setFailure('');
    if (getActiveEnvironment()) {
      setView({ state: 'remote' });
    } else {
      (async () => {
        try {
          const response = await apiFetch('/api/structured/ownership', { signal: controller.signal, cache: 'no-store' });
          if (!current()) return;
          if (response.status === 404) return setView({ state: 'unsupported' });
          if (!response.ok) throw new Error('Inspection failed');
          const value = await response.json();
          if (!current()) return;
          if (value?.state === 'unconfirmed' && UUID.test(value.epoch || '')) setView({ state: 'unconfirmed', epoch: value.epoch.toLowerCase() });
          else if (['busy', 'clean', 'notProvisioned', 'owned'].includes(value?.state)) setView({ state: value.state });
          else throw new Error('Invalid ownership state');
        } catch {
          if (current()) setView({ state: 'error' });
        }
      })();
    }
    return () => { mounted = false; controller.abort(); environmentSignal.removeEventListener('abort', invalidate); unsubscribeAuth(); unsubscribeEnvironment(); if (active.current?.current === current) active.current = null; };
  }, [attempt]);

  async function reconcile() {
    const task = active.current;
    if (!task?.current() || !acknowledged || submitting || view.state !== 'unconfirmed') return;
    const epoch = view.epoch;
    setSubmitting(true);
    setFailure('');
    try {
      const operationId = await reviewOperation(task.auth, epoch);
      if (!task.current()) return;
      const response = await apiFetch('/api/structured/ownership/reconcile', {
        method: 'POST', signal: task.signal, body: { epoch, operationId, acknowledged: true },
      });
      if (!task.current()) return;
      if (response.status === 409) { setAcknowledged(false); setFailure('The ownership state changed. Check it again before continuing.'); return; }
      if (!response.ok) throw new Error('Review not confirmed');
      resolved.current?.();
    } catch {
      if (task.current()) setFailure('Could not confirm the review. Retry the same review or check the ownership state again.');
    } finally {
      if (task.current()) setSubmitting(false);
    }
  }

  if (['checking', 'unsupported', 'clean', 'notProvisioned', 'owned', 'scope_changed'].includes(view.state)) return null;
  if (view.state === 'remote') return <div className="ownership-recovery"><p>Open the affected server directly to review session ownership.</p></div>;
  if (view.state === 'error') return <div className="ownership-recovery"><p>Session ownership could not be checked. Check the server before retrying.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Check ownership again</button></div>;
  if (view.state === 'busy') return <div className="ownership-recovery"><p>Another server is using your sessions. Stop it or wait for it to finish before retrying.</p><button type="button" onClick={() => setAttempt(value => value + 1)}>Check ownership again</button></div>;
  return <div className="ownership-recovery">
    <p>The previous server stopped without confirming cleanup. Check that its agent and terminal processes have stopped before continuing. Cleanup remains unverified, and interrupted work will not be replayed automatically.</p>
    <label><input type="checkbox" checked={acknowledged} disabled={submitting} onChange={event => setAcknowledged(event.target.checked)} /> I have checked that the previous processes have stopped.</label>
    {failure && <p role="alert">{failure}</p>}
    <div className="ownership-recovery-actions">
      <button type="button" disabled={!acknowledged || submitting} onClick={reconcile}>{failure && acknowledged ? 'Retry the same review' : 'Continue after review'}</button>
      <button type="button" disabled={submitting} onClick={() => setAttempt(value => value + 1)}>Check ownership again</button>
    </div>
  </div>;
}
