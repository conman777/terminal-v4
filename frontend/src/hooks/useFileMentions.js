import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';

const NONE = [];
const authSnapshot = () => JSON.stringify(captureAuthScope());

// The `@word` being typed at the end of the composer, or null.
export function mentionQuery(value) {
  const match = typeof value === 'string' ? /(?:^|\s)@([^\s@]*)$/.exec(value) : null;
  return match ? match[1] : null;
}

export function insertMention(value, file) {
  return value.replace(/@[^\s@]*$/, `@${file} `);
}

// Project files matching an `@` mention, fetched shortly after typing pauses.
export function useFileMentions(root, query) {
  const [loaded, setLoaded] = useState(null);
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const authKey = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  useEffect(() => {
    if (!root || query == null) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => apiFetch(`/api/workspace/files?${new URLSearchParams({ path: root, query })}`, { signal: controller.signal }))
        .then(response => (response?.ok ? response.json() : null))
        .then(payload => { if (!controller.signal.aborted) setLoaded({ root, query, signal, authKey, files: Array.isArray(payload?.files) ? payload.files : NONE }); })
        .catch(() => { if (!controller.signal.aborted) setLoaded({ root, query, signal, authKey, files: NONE }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [authKey, signal, root, query]);
  return loaded?.root === root && loaded.query === query && loaded.signal === signal && loaded.authKey === authKey ? loaded.files : NONE;
}
