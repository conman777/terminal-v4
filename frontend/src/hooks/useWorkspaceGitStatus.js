import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

const REFRESH_MS = 15000;
const UNAVAILABLE = { available: false };
const LOADING = { ...UNAVAILABLE, status: 'loading' };

export function summarizeGitStatus(status) {
  const files = Array.isArray(status?.files) ? status.files : [];
  return {
    branch: status?.branch || null,
    added: files.reduce((total, file) => total + (Number.isFinite(file?.added) ? file.added : 0), 0),
    removed: files.reduce((total, file) => total + (Number.isFinite(file?.removed) ? file.removed : 0), 0),
    files: files.length,
    available: true,
  };
}

export function useWorkspaceGitStatus(cwd, { enabled = true } = {}) {
  const [result, setResult] = useState(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !cwd) { setResult(null); return undefined; }
    setResult({ cwd, summary: LOADING });
    let cancelled = false;
    let notRepository = false;
    let timer;
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const response = await apiFetch(`/api/workspace/git/status?path=${encodeURIComponent(cwd)}&mode=unstaged`);
        // A folder outside Git stays that way until the thread moves, so it is not polled again.
        const isNotRepository = response.status === 400;
        const data = response.ok ? await response.json() : null;
        if (!cancelled && current === request) {
          notRepository = isNotRepository;
          setResult({ cwd, summary: data
            ? { ...summarizeGitStatus(data), status: 'success' }
            : { ...UNAVAILABLE, status: notRepository ? 'not-repository' : 'error' } });
        }
      } catch {
        if (!cancelled && current === request) setResult({ cwd, summary: { ...UNAVAILABLE, status: 'error' } });
      }
      if (!cancelled && current === request && !notRepository) timer = setTimeout(() => { if (isWindowActive()) load(); }, REFRESH_MS);
    };
    load();
    const unsubscribe = subscribeWindowActivity(active => { if (active && !cancelled && !notRepository) { clearTimeout(timer); load(); } });
    return () => { cancelled = true; clearTimeout(timer); unsubscribe(); };
  }, [cwd, enabled, revision]);

  const summary = !enabled || !cwd ? { ...UNAVAILABLE, status: 'idle' } : result?.cwd === cwd ? result.summary : LOADING;
  return { ...summary, refresh };
}
