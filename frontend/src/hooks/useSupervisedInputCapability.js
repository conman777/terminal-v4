import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { supervisedInputAvailability, supervisedSessionInputCapability } from '../utils/supervisedRawInputApi';
import { SUPERVISED_CAPABILITY_CHANGED } from '../utils/supervisedRawInputController';

const authKey = () => JSON.stringify(captureAuthScope());

export function useSupervisedInputCapability(enabled, sessionId) {
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const account = useSyncExternalStore(subscribeAuth, authKey);
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const cycle = useRef({ enabled: false, version: 0 });
  if (cycle.current.enabled !== enabled) cycle.current = { enabled, version: cycle.current.version + 1 };
  const version = cycle.current.version;
  useEffect(() => {
    const changed = () => { setState(null); setRetry(value => value + 1); };
    window.addEventListener(SUPERVISED_CAPABILITY_CHANGED, changed);
    return () => window.removeEventListener(SUPERVISED_CAPABILITY_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    const auth = captureAuthScope();
    let alive = true;
    const current = () => alive && !signal.aborted && isAuthScopeCurrent(auth);
    if (getActiveEnvironment()) {
      setState({ signal, account, version, sessionId, mode: 'legacy' });
      return () => { alive = false; };
    }
    supervisedInputAvailability(apiFetch, signal).then(async availability => availability === 'supervised' && supervisedSessionInputCapability(apiFetch, signal, sessionId)).then(supported => {
      if (current()) setState({ signal, account, version, sessionId, mode: supported ? 'supervised' : 'legacy' });
    }).catch(() => { if (current()) setState({ signal, account, version, sessionId, mode: 'unavailable' }); });
    return () => { alive = false; };
  }, [enabled, signal, account, version, retry, sessionId]);
  if (!enabled) return 'legacy';
  return state?.signal === signal && state?.account === account && state?.version === version && state?.sessionId === sessionId ? state.mode : 'checking';
}
