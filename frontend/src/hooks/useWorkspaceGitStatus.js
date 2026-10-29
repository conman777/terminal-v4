import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

const REFRESH_MS = 15000;
const UNAVAILABLE = { available: false };

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
  const [summary, setSummary] = useState(UNAVAILABLE);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !cwd) { setSummary(UNAVAILABLE); return undefined; }
    let cancelled = false;
    let notRepository = false;
    let timer;
    const load = async () => {
      try {
        const response = await apiFetch(`/api/workspace/git/status?path=${encodeURIComponent(cwd)}&mode=unstaged`);
        // A folder outside Git stays that way until the thread moves, so it is not polled again.
        notRepository = response.status === 400;
        const data = response.ok ? await response.json() : null;
        if (!cancelled) setSummary(data ? summarizeGitStatus(data) : UNAVAILABLE);
      } catch {
        if (!cancelled) setSummary(UNAVAILABLE);
      }
      if (!cancelled && !notRepository) timer = setTimeout(() => { if (isWindowActive()) load(); }, REFRESH_MS);
    };
    load();
    const unsubscribe = subscribeWindowActivity(active => { if (active && !cancelled && !notRepository) { clearTimeout(timer); load(); } });
    return () => { cancelled = true; clearTimeout(timer); unsubscribe(); };
  }, [cwd, enabled, revision]);

  return { ...summary, refresh };
}
