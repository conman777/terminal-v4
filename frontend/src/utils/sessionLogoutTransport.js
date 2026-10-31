// Unwired groundwork. The caller must independently establish trustedHome and
// provide a trusted fetch; neither browser storage nor a supplied receipt proves it.
const MAX_RESPONSE_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY = /^[0-9a-f]{64}$/;
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && new TextEncoder().encode(value).byteLength <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

function trustedBase(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.href !== value
      || !url.pathname.endsWith('/') || /%2f|%5c/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function copyScope(input, home) {
  try {
    const scope = {
      home: input.home, owner: input.owner, session: input.session,
      operation: input.operation, incarnation: input.incarnation,
      logoutCapability: input.logoutCapability, signal: input.signal,
    };
    if (scope.home !== home || !validOwner(scope.owner)
      || typeof scope.session !== 'string' || !UUID.test(scope.session)
      || typeof scope.operation !== 'string' || !UUID.test(scope.operation)
      || typeof scope.incarnation !== 'string' || !UUID.test(scope.incarnation)
      || typeof scope.logoutCapability !== 'string' || !CAPABILITY.test(scope.logoutCapability)
      || (scope.signal && (typeof scope.signal.addEventListener !== 'function'
        || typeof scope.signal.removeEventListener !== 'function'
        || typeof scope.signal.aborted !== 'boolean'))) return null;
    return scope;
  } catch { return null; }
}

async function readBoundedJson(response) {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json' || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1) return null;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch { return null; }
  finally { try { await reader.cancel(); } catch { /* Ignore cancellation failure. */ } }
}

function matchesReceipt(value, scope) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'incarnation,operation,owner,session,status'
    && value.status === 'revoked' && value.owner === scope.owner && value.session === scope.session
    && value.operation === scope.operation && value.incarnation === scope.incarnation;
}

export function createSessionLogoutTransport({ trustedHome, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const home = trustedBase(trustedHome);
  if (!home || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('Trusted logout transport is unavailable');
  }
  async function request(input, suffix) {
    const scope = copyScope(input, home);
    if (!scope) return false;
    let timer;
    let onAbort;
    try {
      if (scope.signal?.aborted) return false;
      const url = new URL(`api/auth/session-logout${suffix}`, home).href;
      const controller = new AbortController();
      let resolveAbort;
      const aborted = new Promise(resolve => { resolveAbort = resolve; });
      onAbort = () => { controller.abort(); resolveAbort(false); };
      scope.signal?.addEventListener('abort', onAbort, { once: true });
      if (scope.signal?.aborted) return false;
      timer = setTimeout(onAbort, timeoutMs);
      const work = (async () => {
        const body = JSON.stringify({ owner: scope.owner, session: scope.session, operation: scope.operation, incarnation: scope.incarnation, logoutCapability: scope.logoutCapability });
        const response = await fetchImpl(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
          credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        });
        if (controller.signal.aborted || response.status !== 200 || response.redirected || response.url !== url) return false;
        const receipt = await readBoundedJson(response);
        return !controller.signal.aborted && matchesReceipt(receipt, scope);
      })();
      return await Promise.race([work, aborted]);
    } catch { return false; }
    finally {
      clearTimeout(timer);
      try { if (onAbort) scope.signal?.removeEventListener('abort', onAbort); } catch { /* Ignore cleanup failure. */ }
    }
  }

  return {
    async logout(scope) {
      if (!await request(scope, '')) throw new Error('Logout outcome unconfirmed');
      return { status: 'submitted' };
    },
    // A caller-provided receipt is never proof; always query the pinned server.
    verifyLogoutReceipt: scope => request(scope, '/receipt'),
  };
}
