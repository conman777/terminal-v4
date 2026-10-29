import { useEffect, useState } from 'react';
import { apiGet } from '../utils/api';

const FRESH_MS = 60000;
const cache = new Map();
const NONE = Object.freeze([]);

export const resetPullRequestMentionCache = () => cache.clear();

const toMention = pullRequest => (Number.isInteger(pullRequest?.number)
  ? [{ id: String(pullRequest.number), title: `#${pullRequest.number} ${pullRequest.title || ''}`.trim(), url: pullRequest.url }]
  : NONE);

const keyOf = (cwd, branch) => `${cwd}\u0000${branch || ''}`;
const fresh = key => { const hit = cache.get(key); return hit && Date.now() - hit.at < FRESH_MS ? hit.value : null; };

export function useCurrentPullRequest(cwd, branch, { enabled = true } = {}) {
  const key = keyOf(cwd, branch);
  const [loaded, setLoaded] = useState({ key: '', value: NONE });

  useEffect(() => {
    if (!enabled || !cwd || fresh(key)) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => apiGet(`/api/workspace/git/pull-request?${new URLSearchParams({ path: cwd })}`))
      .then(data => (data?.availability === 'error' ? NONE : toMention(data?.pullRequest)))
      .catch(() => NONE)
      .then(value => { cache.set(key, { at: Date.now(), value }); if (!cancelled) setLoaded({ key, value }); });
    return () => { cancelled = true; };
  }, [cwd, enabled, key]);

  if (!enabled || !cwd) return NONE;
  return fresh(key) || (loaded.key === key ? loaded.value : NONE);
}
