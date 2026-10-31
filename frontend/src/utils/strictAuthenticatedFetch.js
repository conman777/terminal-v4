const responseChecks = new WeakMap();
const responseMetadata = new WeakMap();
const bodyMethods = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
const metadataProperties = new Set(['headers', 'url', 'statusText', 'status', 'ok', 'redirected', 'type']);

function guardResponse(response, check) {
  const guarded = new Proxy(response, {
    get(target, property) {
      if (property === 'body') throw new Error('Streaming requires session-aware handling');
      if (metadataProperties.has(property)) throw new Error('Response metadata requires session-aware handling');
      if (property === 'clone') return () => guardResponse(target.clone(), check);
      const value = Reflect.get(target, property, target);
      if (bodyMethods.has(property) && typeof value === 'function') {
        return async (...args) => {
          let decoded;
          try { decoded = await value.apply(target, args); }
          catch (error) { await check(); throw error; }
          await check();
          return decoded;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  responseChecks.set(guarded, check);
  responseMetadata.set(guarded, async () => {
    await check();
    const metadata = { headers: new Headers(response.headers), url: response.url, statusText: response.statusText, status: response.status, ok: response.ok, redirected: response.redirected, type: response.type };
    await check();
    return metadata;
  });
  return guarded;
}

function readScope(snapshot, home) {
  const pair = snapshot?.pair;
  if (snapshot?.status !== 'active' || snapshot.refreshReserved
    || typeof snapshot.incarnation !== 'string' || !snapshot.incarnation
    || typeof pair?.owner !== 'string' || !pair.owner
    || typeof pair.session !== 'string' || !pair.session
    || typeof pair.accessToken !== 'string' || !pair.accessToken || snapshot.user?.id !== pair.owner) {
    throw new Error('Authentication is unavailable');
  }
  let actualHome;
  try { actualHome = new URL(pair.home).href; }
  catch { throw new Error('Authentication is unavailable'); }
  if (actualHome !== new URL(home, window.location.origin).href) throw new Error('Authentication is unavailable');
  return { incarnation: snapshot.incarnation, owner: pair.owner, session: pair.session, home: actualHome, accessToken: pair.accessToken };
}

function sameSession(first, second) {
  return first.incarnation === second.incarnation && first.owner === second.owner
    && first.session === second.session && first.home === second.home;
}

export async function strictAuthenticatedFetch({ lifecycle, url, home, options, prepareInput }) {
  const initial = readScope(await lifecycle.read(), home);
  const method = String(options.method || 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const send = async scope => {
    options.signal?.throwIfAborted();
    prepareInput();
    let response;
    try {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${scope.accessToken}`);
      response = await fetch(url, { ...options, headers });
    } catch (cause) {
      if (isRead) throw cause;
      const error = new Error('Request outcome may be unconfirmed');
      error.outcomeUncertain = true;
      throw error;
    }
    const checkResponse = async () => {
      let current;
      try { current = readScope(await lifecycle.read(), home); }
      catch { current = null; }
      if (options.signal?.aborted || !current || !sameSession(initial, current)) {
        const error = new Error(isRead ? 'Authentication changed' : 'Authentication changed; request outcome may be unconfirmed');
        if (!isRead) error.outcomeUncertain = true;
        throw error;
      }
    };
    await checkResponse();
    return guardResponse(response, checkResponse);
  };
  const response = await send(initial);
  if ((await readStrictResponseMetadata(response)).status !== 401 || !isRead) return response;
  options.signal?.throwIfAborted();
  const { incarnation, owner, session, home: sessionHome } = initial;
  const refreshed = await lifecycle.refresh({ incarnation, owner, session, home: sessionHome }, { signal: options.signal });
  options.signal?.throwIfAborted();
  if (refreshed?.status !== 'active') throw new Error('Authentication refresh could not be confirmed');
  const next = readScope(await lifecycle.read(), home);
  if (!sameSession(initial, next)) throw new Error('Authentication changed');
  return send(next);
}

// Call after decoding a strict response and before applying it to the UI.
export async function validateStrictResponse(response, { required = false } = {}) {
  const check = responseChecks.get(response);
  if (!check && required) throw new Error('Strict response scope is unavailable');
  await check?.();
}

export async function readStrictResponseMetadata(response) {
  const read = responseMetadata.get(response);
  if (!read) throw new Error('Strict response scope is unavailable');
  return read();
}
