import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiGet } from '../utils/api';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, getEnvironmentStorage, subscribeEnvironment } from '../utils/remoteEnvironments';
import './SetupChecklist.css';

const DISMISSED_KEY = 'tv4SetupChecklistDismissed';
const authSnapshot = () => JSON.stringify(captureAuthScope());
function dismissed(scope) { try { return scope.storage.getItem(scope.storageKey) === '1'; } catch { return false; } }
function initialState(scope, welcome) {
  return { scope, hidden: welcome && dismissed(scope), report: null, error: '', checking: false, expanded: false };
}

export function SetupChecklist({ welcome = false }) {
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const auth = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  const scope = useMemo(() => {
    const identity = JSON.parse(auth);
    return { signal, auth, storage: getEnvironmentStorage(), storageKey: `${DISMISSED_KEY}:${encodeURIComponent(identity.home)}:${encodeURIComponent(identity.userId || '')}` };
  }, [signal, auth]);
  const [stored, setStored] = useState(() => initialState(scope, welcome));
  const state = stored.scope === scope ? stored : initialState(scope, welcome);
  const pending = useRef(null);
  const detailsId = useId();
  const check = useCallback(async () => {
    if (scope.signal.aborted || getEnvironmentSignal() !== scope.signal || authSnapshot() !== scope.auth) return;
    pending.current?.controller.abort();
    const controller = new AbortController();
    const request = { scope, controller };
    pending.current = request;
    const current = () => pending.current === request && !controller.signal.aborted && !scope.signal.aborted
      && getEnvironmentSignal() === scope.signal && authSnapshot() === scope.auth;
    setStored(previous => ({ ...(previous.scope === scope ? previous : initialState(scope, welcome)), checking: true, error: '' }));
    try {
      const report = await apiGet('/api/system/doctor', { signal: controller.signal });
      if (!report || typeof report.ready !== 'boolean' || !Array.isArray(report.checks)) throw new Error('The setup check returned an invalid response.');
      if (current()) setStored(previous => previous.scope === scope ? { ...previous, report, error: '' } : previous);
    } catch (failure) {
      if (current()) setStored(previous => previous.scope === scope ? { ...previous, error: failure?.message || 'The setup check could not run.' } : previous);
    } finally {
      if (current()) { pending.current = null; setStored(previous => previous.scope === scope ? { ...previous, checking: false } : previous); }
    }
  }, [scope, welcome]);
  useEffect(() => {
    if (!initialState(scope, welcome).hidden) void check();
    return () => { if (pending.current?.scope === scope) pending.current.controller.abort(); };
  }, [check, scope, welcome]);

  const { hidden, report, error, checking, expanded } = state;
  if (hidden || (welcome && !error && (!report || report.ready))) return null;
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const missingRequired = checks.some(item => item.required && !item.ok);
  const noNativeAgent = report?.agentReady === false;
  const summary = missingRequired ? 'Required setup checks need attention.'
    : noNativeAgent ? 'Codex and Claude were not detected. Other configured agents may still work.'
      : 'Some setup checks need attention.';
  const dismiss = () => {
    if (scope.signal.aborted || getEnvironmentSignal() !== scope.signal || authSnapshot() !== scope.auth) return;
    try { scope.storage.setItem(scope.storageKey, '1'); } catch { /* dismissal remains active in this view */ }
    if (pending.current?.scope === scope) pending.current.controller.abort();
    setStored(previous => ({ ...(previous.scope === scope ? previous : initialState(scope, welcome)), hidden: true, checking: false }));
  };
  return (
    <section className={`setup-checklist${welcome ? ' setup-checklist-welcome' : ''}`} aria-label="Setup check">
      <header>
        <div>
          <h3>Setup check</h3>
          <p>{welcome ? (report ? summary : 'The setup check could not run.') : report?.ready ? 'Required checks and a native agent are available.' : report ? 'Review the checks and try again.' : checking ? 'Checking setup…' : 'The setup check could not run.'}</p>
        </div>
        <div className="setup-checklist-actions">
          {welcome && report && <button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setStored(previous => ({ ...previous, expanded: !previous.expanded }))}>Setup details</button>}
          {!welcome && <button type="button" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>}
          {welcome && <button type="button" onClick={dismiss}>Dismiss</button>}
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {error && !report && welcome && <button type="button" className="setup-checklist-retry" onClick={check} disabled={checking}>Try setup check again</button>}
      {report && <div id={detailsId} hidden={welcome && !expanded}>
        {welcome && <button type="button" className="setup-checklist-retry" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>}
        <ul>
          {checks.map(item => <li key={item.id} className={item.ok ? 'ok' : item.required ? 'missing required' : 'missing'}>
            <span className="setup-checklist-mark" aria-hidden="true">{item.ok ? '✓' : '!'}</span>
            <div><strong>{item.label}</strong>{!item.required && !item.ok && <span className="setup-checklist-optional"> optional</span>}
              <small>{item.detail}</small>{!item.ok && <p>{item.fix}</p>}
            </div>
          </li>)}
        </ul>
      </div>}
    </section>
  );
}
