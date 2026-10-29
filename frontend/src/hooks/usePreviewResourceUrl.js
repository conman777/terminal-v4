import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { resolveApiUrl } from '../utils/apiBase';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { getPreviewNavigationTarget } from '../utils/previewUrl';

const MAX_TIMER_MS = 2147483647;
const EXPIRED_MESSAGE = 'Preview connection expired. The loaded page is preserved; later resource loads and app controls need reconnecting.';

async function preparePreviewResource(target, { signal } = {}) {
  const navigation = getPreviewNavigationTarget(target);
  if (!navigation) {
    const direct = new URL(target, window.location.origin);
    const home = new URL(resolveApiUrl('/api/auth/me'), window.location.origin);
    if (!['http:', 'https:'].includes(direct.protocol) || direct.origin === window.location.origin || direct.origin === home.origin) {
      throw new Error('Preview navigation must use an authorized preview or an external HTTP(S) address.');
    }
    return { url: direct.toString(), expiresAtMs: null };
  }
  const authScope = captureAuthScope();
  const environment = getActiveEnvironment();
  const response = await apiFetch('/api/preview/resource-auth', {
    home: true,
    method: 'POST',
    body: { targetPath: navigation.targetPath },
    signal,
  });
  const data = await response.json();
  signal?.throwIfAborted();
  if (!isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId || getActiveEnvironment() !== environment) {
    throw new Error('Preview authentication changed. Try again.');
  }
  if (!response.ok || typeof data.previewToken !== 'string' || !data.previewToken || typeof data.targetPath !== 'string') {
    throw new Error(data.error || 'Could not authorize the preview. Try again.');
  }
  let expiresAtMs = null;
  if (data.expiresAt !== undefined) {
    if (typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt * 1000)) {
      throw new Error('Preview authorization has an invalid expiry. Retry preview.');
    }
    expiresAtMs = data.expiresAt * 1000;
    if (expiresAtMs <= Date.now() + 1000) {
      throw new Error('Preview authorization expired or expires too soon. Retry preview.');
    }
  }
  const authorized = new URL(navigation.url);
  const authorizedPath = new URL(data.targetPath, authorized.origin);
  if (authorizedPath.origin !== authorized.origin || authorizedPath.pathname !== new URL(navigation.targetPath, authorized.origin).pathname) {
    throw new Error('Preview authorization returned a different target.');
  }
  authorized.search = authorizedPath.search;
  authorized.searchParams.set('previewToken', data.previewToken);
  return { url: authorized.toString(), expiresAtMs };
}

export async function preparePreviewResourceUrl(target, options = {}) {
  return (await preparePreviewResource(target, options)).url;
}

export function usePreviewResourceUrl(target) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ target: null, revision: -1, url: null, error: '', expired: false });
  const jobs = useRef(new Set());
  const generation = useRef(0);
  const scope = useMemo(() => ({}), [target, revision]);
  const activeScope = useRef(null);
  const resourceRef = useRef(null);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    const invalidate = () => {
      generation.current += 1;
      resourceRef.current = null;
      for (const job of jobs.current) { job.controller.abort(); clearTimeout(job.timer); job.popup?.close(); }
      jobs.current.clear();
      retry();
    };
    let authority = captureAuthScope();
    const stopAuth = subscribeAuth(() => {
      const next = captureAuthScope();
      if (isAuthScopeCurrent(authority) && authority.userId === next.userId) return;
      authority = next;
      invalidate();
    });
    const stopEnvironment = subscribeEnvironment(invalidate);
    return () => {
      stopAuth(); stopEnvironment(); generation.current += 1;
      for (const job of jobs.current) { job.controller.abort(); clearTimeout(job.timer); job.popup?.close(); }
      jobs.current.clear();
    };
  }, [retry]);

  useEffect(() => {
    const current = ++generation.current;
    activeScope.current = scope;
    const controller = new AbortController();
    const job = { controller, timer: null };
    jobs.current.add(job);
    const authority = captureAuthScope();
    const environment = getActiveEnvironment();
    const isCurrent = () => !controller.signal.aborted && current === generation.current
      && isAuthScopeCurrent(authority) && captureAuthScope().userId === authority.userId && getActiveEnvironment() === environment;
    resourceRef.current = null;
    setState({ target, revision, url: null, error: '', expired: false });

    const expire = () => {
      if (!isCurrent()) return;
      setState(previous => previous.expired ? previous : { ...previous, expired: true, error: EXPIRED_MESSAGE });
    };
    const checkExpiry = () => {
      clearTimeout(job.timer);
      job.timer = null;
      const resource = resourceRef.current;
      if (!isCurrent() || resource?.scope !== scope || resource.expiresAtMs === null) return;
      const remaining = resource.expiresAtMs - Date.now();
      if (remaining > 0) job.timer = setTimeout(checkExpiry, Math.min(MAX_TIMER_MS, Math.ceil(remaining)));
      else expire();
    };
    const checkVisibleExpiry = () => { if (document.visibilityState !== 'hidden') checkExpiry(); };
    window.addEventListener('focus', checkVisibleExpiry);
    document.addEventListener('visibilitychange', checkVisibleExpiry);
    if (target) {
      preparePreviewResource(target, { signal: controller.signal }).then(resource => {
        if (!isCurrent()) return;
        resourceRef.current = { ...resource, scope, isCurrent, expire };
        setState({ target, revision, url: resource.url, error: '', expired: false });
        checkExpiry();
      }).catch(error => {
        if (isCurrent()) setState({ target, revision, url: null, error: error.message, expired: false });
      });
    }
    return () => {
      controller.abort();
      window.removeEventListener('focus', checkVisibleExpiry);
      document.removeEventListener('visibilitychange', checkVisibleExpiry);
      if (activeScope.current === scope) activeScope.current = null;
      if (resourceRef.current?.scope === scope) resourceRef.current = null;
      generation.current += 1;
      for (const job of jobs.current) { job.controller.abort(); clearTimeout(job.timer); job.popup?.close(); }
      jobs.current.clear();
    };
  }, [target, revision, scope]);

  const assertActive = useCallback(() => {
    const resource = resourceRef.current;
    if (!resource || resource.scope !== scope || activeScope.current !== scope || !resource.isCurrent()) {
      throw new Error('Preview changed or is not ready. Load the current preview before using its controls.');
    }
    if (resource.expiresAtMs !== null && Date.now() >= resource.expiresAtMs) {
      resource.expire();
      throw new Error(EXPIRED_MESSAGE);
    }
    return true;
  }, [scope]);

  const openInNewTab = useCallback(() => {
    if (!target || activeScope.current !== scope) return;
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      setState(previous => ({ ...previous, error: 'The browser blocked the new tab. Allow popups and try again.' }));
      return;
    }
    popup.opener = null;
    const controller = new AbortController();
    const job = { controller, popup };
    const current = generation.current;
    jobs.current.add(job);
    preparePreviewResourceUrl(target, { signal: controller.signal }).then(url => {
      if (controller.signal.aborted || current !== generation.current) { popup.close(); return; }
      popup.location.replace(url);
    }).catch(error => {
      popup.close();
      if (!controller.signal.aborted && current === generation.current) setState(previous => ({ ...previous, error: error.message }));
    }).finally(() => jobs.current.delete(job));
  }, [target, scope]);

  const current = state.target === target && state.revision === revision;
  return { url: current ? state.url : null, error: current ? state.error : '', expired: current && state.expired, assertActive, retry, openInNewTab };
}
