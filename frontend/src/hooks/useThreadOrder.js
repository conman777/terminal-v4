import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';

const STALE = 'Thread order changed on another device. Showing the latest order.';
const FAILED = 'Could not save the thread order. Try again.';

export function useThreadOrder({ enabled = true } = {}) {
  const [state, setState] = useState({ orders: {}, ready: false, error: '' });
  const revisionRef = useRef(null);
  const ordersRef = useRef({});
  const queueRef = useRef(Promise.resolve());
  const loadedRef = useRef(Promise.resolve());
  const mountedRef = useRef(true);

  const adopt = useCallback((snapshot, error = '') => {
    revisionRef.current = snapshot.revision;
    ordersRef.current = snapshot.projects || {};
    if (mountedRef.current) setState({ orders: ordersRef.current, ready: true, error });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) return () => { mountedRef.current = false; };
    const controller = new AbortController();
    const scope = captureAuthScope();
    loadedRef.current = (async () => {
      try {
        const response = await apiFetch('/api/thread-order', { signal: controller.signal });
        const data = response.ok ? await response.json() : null;
        if (data && Number.isInteger(data.revision) && data.projects && isAuthScopeCurrent(scope) && !controller.signal.aborted) adopt(data);
      } catch { /* default ordering stays in effect */ }
    })();
    return () => { mountedRef.current = false; controller.abort(); };
  }, [adopt, enabled]);

  const reorder = useCallback((projectPath, order) => {
    const run = async () => {
      await loadedRef.current;
      if (revisionRef.current === null) return { ok: false };
      const previous = ordersRef.current;
      ordersRef.current = { ...previous, [projectPath]: order };
      if (mountedRef.current) setState(current => ({ ...current, orders: ordersRef.current, error: '' }));
      try {
        const response = await apiFetch('/api/thread-order', { method: 'PUT', body: { projectPath, order, expectedRevision: revisionRef.current } });
        const data = await response.json().catch(() => null);
        if (response.ok && data) { adopt(data); return { ok: true }; }
        if (response.status === 409 && data?.current) { adopt(data.current, STALE); return { ok: false, stale: true }; }
      } catch { /* handled below */ }
      ordersRef.current = previous;
      if (mountedRef.current) setState(current => ({ ...current, orders: previous, error: FAILED }));
      return { ok: false };
    };
    const result = queueRef.current.then(run, run);
    queueRef.current = result.catch(() => {});
    return result;
  }, [adopt]);

  const clearError = useCallback(() => setState(current => ({ ...current, error: '' })), []);
  return { orders: state.orders, ready: state.ready, error: state.error, reorder, clearError };
}
