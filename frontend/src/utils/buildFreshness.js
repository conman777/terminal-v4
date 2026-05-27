const BUILD_ENDPOINT = '/api/client-build';
const DEFAULT_INTERVAL_MS = 60_000;
const RELOAD_DEDUPE_MS = 15_000;

export function normalizeAssetPath(src, baseHref = window.location.href) {
  if (typeof src !== 'string' || !src.trim()) return '';
  try {
    return new URL(src, baseHref).pathname;
  } catch {
    return src.trim();
  }
}

export function getCurrentMainScriptPath(documentRef = document, baseHref = window.location.href) {
  const scripts = Array.from(documentRef?.scripts || []);
  const mainScript = scripts
    .map((script) => script.getAttribute('src') || '')
    .reverse()
    .find((src) => /\/assets\/index-[^/]+\.js(?:$|\?)/.test(src));

  return normalizeAssetPath(mainScript, baseHref);
}

export function shouldReloadForBuild(currentMainScript, remoteBuildInfo) {
  const remoteMainScript = normalizeAssetPath(remoteBuildInfo?.mainScript || '');
  if (!remoteMainScript || !currentMainScript) return false;
  return remoteMainScript !== currentMainScript;
}

export function isEditingElement(element) {
  if (!element) return false;
  const tagName = element.tagName?.toLowerCase();
  return tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || element.isContentEditable === true;
}

export async function fetchClientBuildInfo(fetcher = fetch) {
  const response = await fetcher(`${BUILD_ENDPOINT}?t=${Date.now()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  if (!response.ok) return null;
  return response.json();
}

export function buildFreshReloadUrl(locationRef = window.location, remoteMainScript = '') {
  const url = new URL(locationRef.href);
  const normalized = normalizeAssetPath(remoteMainScript, locationRef.href)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-80);
  url.searchParams.set('_v4_build', `${normalized || 'latest'}_${Date.now()}`);
  return url.toString();
}

function reloadToFreshBuild(windowRef, remoteMainScript) {
  const storageKey = `terminal-v4-build-reload:${remoteMainScript}`;
  const now = Date.now();
  try {
    const lastReloadAt = Number(windowRef.sessionStorage?.getItem(storageKey) || '0');
    if (Number.isFinite(lastReloadAt) && now - lastReloadAt < RELOAD_DEDUPE_MS) {
      return false;
    }
    windowRef.sessionStorage?.setItem(storageKey, String(now));
  } catch {
    // Session storage can be unavailable in private browsing or strict modes.
  }

  windowRef.location.replace(buildFreshReloadUrl(windowRef.location, remoteMainScript));
  return true;
}

export function installBuildFreshnessReloader({
  windowRef = window,
  documentRef = document,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetcher = fetch,
} = {}) {
  if (!windowRef || !documentRef || typeof fetcher !== 'function') {
    return () => {};
  }

  let disposed = false;
  let checking = false;
  let pendingRemoteScript = '';
  const currentMainScript = getCurrentMainScriptPath(documentRef, windowRef.location.href);

  const maybeReload = (remoteScript) => {
    if (!remoteScript) return false;
    if (isEditingElement(documentRef.activeElement)) {
      pendingRemoteScript = remoteScript;
      return false;
    }
    pendingRemoteScript = '';
    return reloadToFreshBuild(windowRef, remoteScript);
  };

  const check = async () => {
    if (disposed || checking || documentRef.visibilityState === 'hidden') return;
    checking = true;
    try {
      const info = await fetchClientBuildInfo(fetcher);
      if (!disposed && shouldReloadForBuild(currentMainScript, info)) {
        maybeReload(info.mainScript);
      }
    } catch {
      // Freshness checks should never interrupt the app if the network blips.
    } finally {
      checking = false;
    }
  };

  const handleActive = () => {
    if (disposed || documentRef.visibilityState === 'hidden') return;
    if (pendingRemoteScript) {
      maybeReload(pendingRemoteScript);
      return;
    }
    check();
  };

  const interval = windowRef.setInterval(check, intervalMs);
  const timeout = windowRef.setTimeout(check, 2_000);
  windowRef.addEventListener('focus', handleActive);
  windowRef.addEventListener('online', handleActive);
  windowRef.addEventListener('pageshow', handleActive);
  documentRef.addEventListener('visibilitychange', handleActive);
  documentRef.addEventListener('focusout', handleActive, true);

  return () => {
    disposed = true;
    windowRef.clearInterval(interval);
    windowRef.clearTimeout(timeout);
    windowRef.removeEventListener('focus', handleActive);
    windowRef.removeEventListener('online', handleActive);
    windowRef.removeEventListener('pageshow', handleActive);
    documentRef.removeEventListener('visibilitychange', handleActive);
    documentRef.removeEventListener('focusout', handleActive, true);
  };
}
