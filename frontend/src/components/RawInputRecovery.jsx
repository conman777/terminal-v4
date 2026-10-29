import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentCacheScope, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { listSupervisedRawInputSessions } from '../utils/supervisedRawInputStore';
import { supervisedInputAvailability } from '../utils/supervisedRawInputApi';
import { listUnsettledSupervisedInputs, supervisedInputScope, SUPERVISED_INPUT_CHANGED } from '../utils/supervisedRawInputController';
import './RawInputRecovery.css';

export function RawInputRecovery({ sessions = [] }) {
  const [entries, setEntries] = useState([]);
  const [failure, setFailure] = useState('');
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState('');
  const [expanded, setExpanded] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const attempt = ++generation.current;
    const auth = captureAuthScope(), signal = getEnvironmentSignal();
    const current = () => attempt === generation.current && !signal.aborted && isAuthScopeCurrent(auth);
    try {
      const localSessions = listSupervisedRawInputSessions(getEnvironmentCacheScope(), getActiveEnvironment());
      if (getActiveEnvironment()) {
        if (!localSessions.length) { setEntries([]); setFailure(''); return; }
        throw new Error('Return to the original server to review pending input.');
      }
      const availability = await supervisedInputAvailability(apiFetch, signal);
      if (!current()) return;
      if (availability === 'legacy' && !localSessions.length) { setEntries([]); setFailure(''); return; }
      if (availability === 'legacy') throw new Error('Return to the original server to review pending input.');
      const remote = await listUnsettledSupervisedInputs(signal);
      const collected = new Map(remote.map(item => [`${item.sessionId}:${item.requestId}`, item]));
      for (const sessionId of localSessions) {
        const scope = supervisedInputScope(sessionId);
        for (const pending of scope.store.readAll()) {
          const key = `${sessionId}:${pending.requestId}`;
          if (!collected.has(key)) {
            let status = 'unknown';
            try { status = (await scope.api.lookup(pending.requestId)).status; } catch { /* Missing is not proof that input was not sent. */ }
            collected.set(key, { sessionId, requestId: pending.requestId, status });
          }
        }
      }
      if (!current()) return;
      setEntries([...collected.values()]); setFailure('');
    } catch (error) {
      if (current()) setFailure(error.message || 'Input recovery could not be checked.');
    }
  }, []);

  useEffect(() => {
    refresh();
    const retry = () => refresh();
    const storageChanged = event => {
      if (!event.key?.includes('supervisedRawInput:v2:')) return;
      try {
        const oldStage = event.oldValue && JSON.parse(event.oldValue).stage;
        const newStage = event.newValue && JSON.parse(event.newValue).stage;
        if ((oldStage === 'settled' || !event.oldValue) && (newStage === 'settled' || !event.newValue)) return;
      } catch { /* Malformed changes still require a recovery check. */ }
      refresh();
    };
    const reset = () => { generation.current += 1; setEntries([]); setFailure(''); setChecked({}); setBusy(''); refresh(); };
    window.addEventListener(SUPERVISED_INPUT_CHANGED, retry);
    window.addEventListener('focus', retry);
    window.addEventListener('storage', storageChanged);
    const unsubscribeAuth = subscribeAuth(reset), unsubscribeEnvironment = subscribeEnvironment(reset);
    return () => { generation.current += 1; window.removeEventListener(SUPERVISED_INPUT_CHANGED, retry); window.removeEventListener('focus', retry); window.removeEventListener('storage', storageChanged); unsubscribeAuth(); unsubscribeEnvironment(); };
  }, [refresh]);

  async function resolve(item) {
    const key = `${item.sessionId}:${item.requestId}`;
    if (busy || !checked[key]) return;
    setBusy(key); setFailure('');
    let scope;
    try {
      scope = supervisedInputScope(item.sessionId);
      await scope.withLock(async () => {
        if (!scope.isCurrent()) throw new Error('The account or environment changed.');
        const receipt = await scope.api.lookup(item.requestId);
        if (!scope.isCurrent()) throw new Error('The account or environment changed.');
        if (['issued', 'uncertain', 'delivered'].includes(receipt.status)) {
          const result = await scope.api.review(item.requestId);
          if (result.status !== (receipt.status === 'delivered' ? 'acknowledged' : 'reviewed')) throw new Error('Input review could not be confirmed.');
        } else if (!['acknowledged', 'reviewed'].includes(receipt.status)) throw new Error('The input outcome is still unknown.');
        if (!scope.isCurrent()) throw new Error('The account or environment changed.');
        if (scope.store.readAll().some(pending => pending.requestId === item.requestId)) await scope.store.clear(item.requestId);
      });
      if (scope.isCurrent()) { setChecked(current => ({ ...current, [key]: false })); await refresh(); }
    } catch (error) { if (!scope || scope.isCurrent()) setFailure(error.message || 'Input review could not be confirmed.'); }
    finally { if (!scope || scope.isCurrent()) setBusy(''); }
  }

  if (!entries.length && !failure) return null;
  if (!expanded) return <button type="button" className="raw-input-recovery-minimized" onClick={() => setExpanded(true)}>Review pending input ({entries.length})</button>;
  return <section className="raw-input-recovery" aria-label="Input delivery review">
    <button type="button" onClick={() => setExpanded(false)}>Minimize review</button>
    <p>Some terminal input may have been delivered. Inspect the terminal before continuing; input will not be resent automatically.</p>
    {entries.map(item => {
      const key = `${item.sessionId}:${item.requestId}`;
      const name = sessions.find(session => session.id === item.sessionId)?.title || item.sessionId;
      return <div key={key}>
        <p>{name}: {item.status === 'delivered' ? 'Delivery confirmed' : item.status === 'issued' ? 'Delivery not confirmed' : item.status === 'reviewed' ? 'Previously reviewed' : 'Delivery uncertain'}</p>
        <label><input type="checkbox" checked={Boolean(checked[key])} disabled={Boolean(busy)} onChange={event => setChecked(current => ({ ...current, [key]: event.target.checked }))} /> I checked the terminal and understand this input may have been delivered.</label>
        <button type="button" disabled={!checked[key] || Boolean(busy)} onClick={() => resolve(item)}>Continue after review</button>
      </div>;
    })}
    {failure && <p role="alert">{failure}</p>}
    <button type="button" disabled={Boolean(busy)} onClick={refresh}>Check input status</button>
  </section>;
}
