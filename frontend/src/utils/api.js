import { getAccessToken, clearTokens, refreshTokens, getAuthInitializing, captureAuthScope, isAuthScopeCurrent } from './auth';
import { resolveApiBase, resolveApiUrl, resolveHomeApiUrl } from './apiBase';
import { getEnvironmentSignal, routeEnvironmentPath } from './remoteEnvironments';
import { prepareTerminalInput } from './terminalCommandDelivery';
import { readStrictResponseMetadata, strictAuthenticatedFetch, validateStrictResponse } from './strictAuthenticatedFetch';
import { assertLegacyAuthAllowed, legacyAuthSignal } from './strictAuthBoundary';

const legacyBodyMethods = new Set(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);

function assertLegacyRequestAllowed(uncertain = false, scope = null) {
  try {
    assertLegacyAuthAllowed();
    if (scope && !isAuthScopeCurrent(scope)) {
      throw new Error(uncertain ? 'Authentication changed; request outcome may be unconfirmed' : 'Authentication changed');
    }
  }
  catch (error) { if (uncertain) error.outcomeUncertain = true; throw error; }
}

function guardLegacyResponse(response, uncertain, scope) {
  let body;
  return new Proxy(response, {
    get(target, property) {
      assertLegacyRequestAllowed(uncertain, scope);
      const value = Reflect.get(target, property, target);
      if (property === 'body' && value && typeof value.getReader === 'function') {
        if (!body) {
          let reader;
          body = new ReadableStream({
            type: 'bytes',
            async pull(controller) {
              try {
                assertLegacyRequestAllowed(uncertain, scope);
                reader ||= value.getReader();
                const part = await reader.read();
                assertLegacyRequestAllowed(uncertain, scope);
                if (part.done) {
                  reader.releaseLock(); reader = null;
                  const pendingRead = controller.byobRequest;
                  controller.close();
                  pendingRead?.respond(0);
                }
                else controller.enqueue(part.value);
              } catch (error) {
                if (reader) {
                  const closing = reader;
                  reader = null;
                  void closing.cancel().catch(() => {}).finally(() => closing.releaseLock());
                }
                controller.error(error);
              }
            },
            async cancel(reason) {
              if (!reader) return value.cancel(reason);
              try { await reader.cancel(reason); } finally { reader.releaseLock(); reader = null; }
            },
          }, { highWaterMark: 0 });
        }
        return body;
      }
      if (property === 'clone' && typeof value === 'function') return () => {
        assertLegacyRequestAllowed(uncertain, scope);
        return guardLegacyResponse(value.call(target), uncertain, scope);
      };
      if (legacyBodyMethods.has(property) && typeof value === 'function') return async (...args) => {
        assertLegacyRequestAllowed(uncertain, scope);
        try {
          const decoded = await value.apply(target, args);
          assertLegacyRequestAllowed(uncertain, scope);
          return decoded;
        } catch (error) {
          assertLegacyRequestAllowed(uncertain, scope);
          throw error;
        }
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function readApiError(response) {
  try { return await response.json(); }
  catch (error) {
    if (error?.outcomeUncertain || error?.message === 'Authentication changed' || error?.message === 'Authentication is unavailable') throw error;
    return { error: 'Request failed' };
  }
}

export async function apiFetch(url, options = {}) {
  const strict = Object.hasOwn(options, 'authLifecycle');
  if (!strict) assertLegacyAuthAllowed();
  const { home: homeRequest = false, terminalDelivery, authLifecycle, ...fetchOptions } = options;
  if (strict && (typeof authLifecycle?.read !== 'function' || typeof authLifecycle?.refresh !== 'function')) throw new Error('Authentication is unavailable');
  const fullUrl = homeRequest ? resolveHomeApiUrl(url) : resolveApiUrl(url);
  const target = new URL(fullUrl, window.location.origin);
  const home = new URL(resolveApiBase() || window.location.origin, window.location.origin);
  if (target.origin !== home.origin) throw new Error('API requests must use the home server');
  const environmentSignal = !homeRequest && (strict || routeEnvironmentPath(url) !== url) ? getEnvironmentSignal() : null;
  const requestOptions = {
    ...fetchOptions,
    headers: strict ? new Headers(options.headers) : { ...options.headers }
  };

  const signals = [options.signal, environmentSignal, strict ? null : legacyAuthSignal()].filter(Boolean);
  if (signals.length) requestOptions.signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const headers = requestOptions.headers;

  if (requestOptions.body && typeof requestOptions.body === 'object' && !(requestOptions.body instanceof FormData)) {
    if (strict) headers.set('Content-Type', 'application/json');
    else headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  const terminalInput = new URL(url, window.location.origin).pathname.match(/^\/api\/terminal\/([^/]+)\/input\/?$/);
  const prepareInput = () => {
    if (terminalInput && String(requestOptions.method || 'GET').toUpperCase() === 'POST') {
      prepareTerminalInput(decodeURIComponent(terminalInput[1]), terminalDelivery);
    }
  };
  if (strict) {
    return strictAuthenticatedFetch({ lifecycle: authLifecycle, url: fullUrl, home: resolveHomeApiUrl('/'), options: requestOptions, prepareInput });
  }
  const authScope = captureAuthScope();
  const accessToken = getAccessToken();
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD';
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  assertLegacyAuthAllowed();
  prepareInput();
  const legacyFetch = async () => {
    assertLegacyRequestAllowed(false, authScope);
    try {
      const response = await fetch(fullUrl, requestOptions);
      assertLegacyRequestAllowed(isMutation, authScope);
      return response;
    } catch (error) {
      assertLegacyRequestAllowed(isMutation, authScope);
      throw error;
    }
  };
  let response = await legacyFetch();

  // Handle 401 - try to refresh token
  if (response.status === 401 && accessToken) {
    if (!isAuthScopeCurrent(authScope)) throw new Error('Authentication changed');
    // If auth is still initializing, don't try to refresh - let AuthContext handle it
    if (getAuthInitializing()) {
      throw new Error('Auth initializing');
    }

    try {
      // Use centralized refresh to avoid race conditions
      requestOptions.signal?.throwIfAborted();
      const result = await refreshTokens();
      requestOptions.signal?.throwIfAborted();
      if (!isAuthScopeCurrent(authScope)) throw new Error('Authentication changed');
      headers['Authorization'] = `Bearer ${result.accessToken}`;
      prepareInput();
      response = await legacyFetch();
    } catch (err) {
      // Only clear tokens if it's actually an auth failure, not a network error
      // Network errors should not log out the user
      if (err.message === 'Token refresh failed' || err.message === 'No refresh token' || err.message === 'Invalid token response') {
        if (isAuthScopeCurrent(authScope)) clearTokens(true);
        throw new Error('Session expired');
      }
      // For network errors, just rethrow without clearing tokens
      throw err;
    }
  }

  assertLegacyRequestAllowed(isMutation, authScope);
  return guardLegacyResponse(response, isMutation, authScope);
}

export async function apiGet(url, options) {
  const response = await apiFetch(url, options);
  const strict = Object.hasOwn(options || {}, 'authLifecycle');
  const ok = strict ? (await readStrictResponseMetadata(response)).ok : response.ok;
  if (!ok) {
    const error = await readApiError(response);
    await validateStrictResponse(response, { required: strict });
    throw new Error(error.error || 'Request failed');
  }
  const result = await response.json();
  await validateStrictResponse(response, { required: strict });
  return result;
}

export async function apiPost(url, body) {
  const response = await apiFetch(url, {
    method: 'POST',
    body
  });
  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

export async function apiDelete(url) {
  const response = await apiFetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) {
    const error = await readApiError(response);
    throw new Error(error.error || 'Request failed');
  }
  return response.status === 204 ? null : response.json();
}

export async function apiPut(url, body) {
  const response = await apiFetch(url, { method: 'PUT', body });
  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

export async function apiPatch(url, body, options) {
  const response = await apiFetch(url, {
    ...options,
    method: 'PATCH',
    body
  });
  if (!response.ok) {
    const error = await readApiError(response);
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

/**
 * Upload a screenshot/image and return the path
 * @param {File|Blob} file - The image file or blob to upload
 * @returns {Promise<string>} The path to the uploaded screenshot (e.g., ~/screenshots/screenshot-xxx.png)
 */
// Any file for an agent conversation; resolves to the saved file's absolute path.
export async function uploadAttachment(file) {
  const formData = new FormData();
  formData.append('file', file, file.name || 'attachment');
  const response = await apiFetch('/api/files/attachment', { method: 'POST', body: formData });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.message || error.error || 'Attachment upload failed');
  }
  return (await response.json()).path;
}

export async function uploadScreenshot(file) {
  const formData = new FormData();
  formData.append('image', file, file.name || 'screenshot.png');

  const response = await apiFetch('/api/files/screenshot', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.message || error.error || 'Screenshot upload failed');
  }

  const data = await response.json();
  return data.path;
}
