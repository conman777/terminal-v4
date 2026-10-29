import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

export function useBrowserApprovals(enabled = true, interval = 900, idleInterval = interval) {
  const [requests, setRequests] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let timer;
    async function poll() {
      let pending = false;
      try {
        if (document.visibilityState !== 'hidden') {
          const response = await apiFetch('/api/workspace-browser/approvals', { home: true, cache: 'no-store', signal: controller.signal });
          if (response.ok) {
            const value = await response.json();
            const next = Array.isArray(value.requests) ? value.requests : [];
            pending = next.length > 0;
            if (!controller.signal.aborted) setRequests(next);
          }
        }
      } catch { /* The workspace's connection UI handles network/auth recovery. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, pending ? interval : idleInterval);
    }
    poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, interval, idleInterval]);
  return requests;
}
