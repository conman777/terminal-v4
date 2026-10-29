import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../utils/api';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

const REFRESH_MS = 30000;

export function useProjectBranches(paths) {
  const key = useMemo(() => JSON.stringify([...new Set((paths || []).filter(path => typeof path === 'string' && path))].sort()), [paths]);
  const [branches, setBranches] = useState({});

  useEffect(() => {
    const unique = JSON.parse(key);
    if (unique.length === 0) return undefined;
    let cancelled = false;
    let timer;
    const scheduleRefresh = () => { timer = setTimeout(() => (isWindowActive() ? load() : scheduleRefresh()), REFRESH_MS); };
    const load = async () => {
      try {
        const response = await apiFetch('/api/workspace/git/branches', { method: 'POST', body: { paths: unique } });
        const data = response.ok ? await response.json() : null;
        if (!cancelled && data?.branches && typeof data.branches === 'object') setBranches(data.branches);
      } catch { /* Branch labels are optional decoration. */ }
      if (!cancelled) scheduleRefresh();
    };
    load();
    const unsubscribe = subscribeWindowActivity(active => { if (active && !cancelled) { clearTimeout(timer); load(); } });
    return () => { cancelled = true; clearTimeout(timer); unsubscribe(); };
  }, [key]);

  return branches;
}
