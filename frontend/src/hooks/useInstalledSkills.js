import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';

const NONE = [];
const authSnapshot = () => JSON.stringify(captureAuthScope());

// Skills installed for a project folder, offered as slash commands in its composer.
export function useInstalledSkills(workspacePath) {
  const [loaded, setLoaded] = useState(null);
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const authKey = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  useEffect(() => {
    if (!workspacePath) return undefined;
    const controller = new AbortController();
    Promise.resolve()
      .then(() => apiFetch('/api/workspace/skills?path=' + encodeURIComponent(workspacePath), { signal: controller.signal }))
      .then(response => (response?.ok ? response.json() : null))
      .then(payload => { if (!controller.signal.aborted) setLoaded({ workspacePath, signal, authKey, skills: Array.isArray(payload?.skills) ? payload.skills : NONE }); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ workspacePath, signal, authKey, skills: NONE }); });
    return () => controller.abort();
  }, [authKey, signal, workspacePath]);
  return loaded?.workspacePath === workspacePath && loaded.signal === signal && loaded.authKey === authKey ? loaded.skills : NONE;
}
