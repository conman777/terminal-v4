import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiGet } from '../utils/api';
import { captureAuthScope, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';

const FRESH_MS = 60000;
let cache = new WeakMap();
const NONE = Object.freeze([]);

export const resetPullRequestMentionCache = () => { cache = new WeakMap(); };
const authSnapshot = () => JSON.stringify(captureAuthScope());

const toMention = pullRequest => (Number.isInteger(pullRequest?.number)
  ? [{ id: String(pullRequest.number), title: `#${pullRequest.number} ${pullRequest.title || ''}`.trim(), url: pullRequest.url }]
  : NONE);

const keyOf = (auth, cwd, branch) => JSON.stringify([auth, cwd, branch || '']);
const fresh = (signal, key) => { const hit = cache.get(signal)?.get(key); return hit && Date.now() - hit.at < FRESH_MS ? hit.value : null; };

export function useCurrentPullRequest(cwd, branch, { enabled = true } = {}) {
  const signal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const auth = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  const key = keyOf(auth, cwd, branch);
  const [loaded, setLoaded] = useState({ key: '', value: NONE });

  useEffect(() => {
    if (!enabled || !cwd || signal.aborted || fresh(signal, key)) return undefined;
    const controller = new AbortController();
    Promise.resolve().then(() => apiGet(`/api/workspace/git/pull-request?${new URLSearchParams({ path: cwd })}`, { signal: controller.signal }))
      .then(data => (data?.availability === 'error' ? NONE : toMention(data?.pullRequest)))
      .catch(() => NONE)
      .then(value => {
        if (controller.signal.aborted || signal.aborted || getEnvironmentSignal() !== signal || authSnapshot() !== auth) return;
        let scoped = cache.get(signal);
        if (!scoped) { scoped = new Map(); cache.set(signal, scoped); }
        scoped.set(key, { at: Date.now(), value });
        setLoaded({ signal, key, value });
      });
    return () => controller.abort();
  }, [cwd, enabled, key, signal, auth]);

  if (!enabled || !cwd || signal.aborted) return NONE;
  return fresh(signal, key) || (loaded.signal === signal && loaded.key === key ? loaded.value : NONE);
}
