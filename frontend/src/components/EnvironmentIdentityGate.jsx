import { useEffect, useState } from 'react';
import './EnvironmentIdentityGate.css';
import { apiFetch } from '../utils/api';
import { resolveApiBase } from '../utils/apiBase';
import { setEnvironmentIdentity, restoreActiveEnvironment } from '../utils/remoteEnvironments';

export function EnvironmentIdentityGate({ userId, children }) {
  const [readyFor, setReadyFor] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const origin = new URL(resolveApiBase() || window.location.origin, window.location.origin).origin;
    setEnvironmentIdentity(userId, origin);
    setError('');
    apiFetch('/api/environments', { home: true, signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unable to verify saved devices');
      const result = await response.json();
      if (!Array.isArray(result.environments)) throw new Error('Invalid device directory response');
      if (!controller.signal.aborted) restoreActiveEnvironment(result.environments);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message || 'Device directory unavailable');
    }).finally(() => { if (!controller.signal.aborted) setReadyFor(userId); });
    return () => controller.abort();
  }, [userId]);
  if (readyFor !== userId) return <p className="environment-identity-status" role="status">Restoring your workspace connection…</p>;
  return <>{error && <p className="environment-identity-status" role="alert">{error}. Your home workspace is available.</p>}{children}</>;
}
