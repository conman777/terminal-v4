import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';

const authKey = () => JSON.stringify(captureAuthScope());
const requestKey = row => JSON.stringify([row.id, row.label, row.name, row.arguments, row.target]);

export function useSessionBrowserApprovals({ sessionId, enabled = false, canDecide = false }) {
  const authIdentity = useSyncExternalStore(subscribeAuth, authKey);
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const scope = useMemo(() => ({ sessionId, enabled, auth: captureAuthScope(), environmentSignal, active: false,
    rows: [], resolved: new Set(), operation: null, controller: null }), [sessionId, enabled, authIdentity, environmentSignal]);
  const actionToken = useMemo(() => ({}), [scope, canDecide]);
  const live = useRef(null);
  live.current = { scope, actionToken, canDecide };
  const [view, setView] = useState({ scope: null, requests: [], operation: null, error: '', errorKey: null, pollError: '' });

  const current = ctx => live.current?.scope === ctx && ctx.active && ctx.enabled && Boolean(ctx.sessionId)
    && !ctx.controller.signal.aborted && !ctx.environmentSignal.aborted && ctx.environmentSignal === getEnvironmentSignal()
    && isAuthScopeCurrent(ctx.auth) && ctx.auth.userId === captureAuthScope().userId;
  const update = (ctx, patch) => { if (current(ctx)) setView(previous => current(ctx) ? { ...previous, scope: ctx, ...patch } : previous); };
  const operationCurrent = operation => current(scope) && scope.operation === operation
    && live.current.actionToken === operation.actionToken && live.current.canDecide === true
    && scope.rows.some(row => requestKey(row) === operation.key);

  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    const controller = new AbortController();
    scope.controller = controller; scope.active = true; scope.rows = []; scope.resolved.clear();
    let timer;
    const pollCurrent = () => current(scope) && !controller.signal.aborted;
    setView({ scope, requests: [], operation: null, error: '', errorKey: null, pollError: '' });
    async function poll() {
      if (!pollCurrent()) return;
      try {
        if (document.visibilityState !== 'hidden') {
          const response = await apiFetch('/api/workspace-browser/approvals', { home: true, cache: 'no-store', signal: controller.signal });
          const body = await response.json();
          if (!pollCurrent()) return;
          if (!response.ok) throw new Error(body?.error || `Browser approvals could not be loaded (${response.status}).`);
          scope.rows = (Array.isArray(body?.requests) ? body.requests : []).filter(row => {
            if (typeof row?.id !== 'string' || !row.id || typeof row.label !== 'string') return false;
            const parts = row.label.split(':');
            return parts.length === 3 && ['codex', 'claude'].includes(parts[0]) && parts[1] === sessionId && Boolean(parts[2])
              && !scope.resolved.has(requestKey(row));
          });
          if (scope.operation && !scope.rows.some(row => requestKey(row) === scope.operation.key)) {
            scope.operation.controller.abort(); scope.operation = null;
          }
          setView(previous => pollCurrent() ? { ...previous, scope, requests: scope.rows, operation: scope.operation, pollError: '',
            error: previous.errorKey && !scope.rows.some(row => requestKey(row) === previous.errorKey) ? '' : previous.error } : previous);
        }
      } catch (failure) { if (pollCurrent()) update(scope, { pollError: failure.message || 'Browser approvals could not be loaded.' }); }
      if (pollCurrent()) timer = setTimeout(poll, 900);
    }
    void poll();
    return () => {
      controller.abort(); clearTimeout(timer); scope.active = false;
      scope.operation?.controller.abort(); scope.operation = null;
    };
  }, [scope]);

  useEffect(() => {
    if (scope.operation && scope.operation.actionToken !== actionToken) {
      scope.operation.controller.abort(); scope.operation = null;
      update(scope, { operation: null });
    }
  }, [scope, actionToken]);

  async function decide(id, approved) {
    if (!current(scope) || live.current.actionToken !== actionToken || live.current.canDecide !== true || scope.operation || typeof approved !== 'boolean') return false;
    const row = scope.rows.find(request => request.id === id);
    const displayed = view.scope === scope ? view.requests.find(request => request.id === id) : null;
    if (!row || !displayed || requestKey(row) !== requestKey(displayed)) return false;
    const operation = { key: requestKey(row), actionToken, controller: new AbortController() };
    scope.operation = operation;
    update(scope, { operation, error: '', errorKey: null });
    try {
      const response = await apiFetch(`/api/workspace-browser/approvals/${encodeURIComponent(id)}`, {
        home: true, method: 'POST', body: { approved }, signal: AbortSignal.any([scope.controller.signal, operation.controller.signal]),
      });
      if (!operationCurrent(operation)) return false;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Browser approval decision could not be confirmed (${response.status}).`);
      }
      scope.resolved.add(operation.key);
      if (scope.resolved.size > 64) scope.resolved.delete(scope.resolved.values().next().value);
      scope.rows = scope.rows.filter(request => requestKey(request) !== operation.key);
      update(scope, { requests: scope.rows, error: '', errorKey: null });
      return true;
    } catch (failure) {
      if (operationCurrent(operation)) update(scope, { error: failure.message || 'Browser approval decision could not be confirmed. Try again.', errorKey: operation.key });
      return false;
    } finally {
      if (scope.operation === operation) { scope.operation = null; update(scope, { operation: null }); }
    }
  }

  const visible = current(scope) && view.scope === scope;
  return { requests: visible ? view.requests : [], decide,
    isDeciding: Boolean(visible && view.operation && view.operation.actionToken === actionToken),
    error: visible ? view.error || view.pollError : '' };
}
