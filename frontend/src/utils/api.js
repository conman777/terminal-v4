import { getAccessToken, clearTokens, refreshTokens, getAuthInitializing } from './auth';
import { resolveApiBase, resolveApiUrl, resolveHomeApiUrl } from './apiBase';
import { getEnvironmentSignal, routeEnvironmentPath } from './remoteEnvironments';

export async function apiFetch(url, options = {}) {
  const { home: homeRequest = false, ...fetchOptions } = options;
  const fullUrl = homeRequest ? resolveHomeApiUrl(url) : resolveApiUrl(url);
  const target = new URL(fullUrl, window.location.origin);
  const home = new URL(resolveApiBase() || window.location.origin, window.location.origin);
  if (target.origin !== home.origin) throw new Error('API requests must use the home server');
  const environmentSignal = !homeRequest && routeEnvironmentPath(url) !== url ? getEnvironmentSignal() : null;
  const accessToken = getAccessToken();
  const requestOptions = {
    ...fetchOptions,
    headers: {
      ...options.headers,
    }
  };

  if (environmentSignal) {
    requestOptions.signal = options.signal
      ? AbortSignal.any([options.signal, environmentSignal]) : environmentSignal;
  }
  const headers = requestOptions.headers;

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  if (requestOptions.body && typeof requestOptions.body === 'object' && !(requestOptions.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  let response = await fetch(fullUrl, requestOptions);

  // Handle 401 - try to refresh token
  if (response.status === 401 && accessToken) {
    // If auth is still initializing, don't try to refresh - let AuthContext handle it
    if (getAuthInitializing()) {
      throw new Error('Auth initializing');
    }

    try {
      // Use centralized refresh to avoid race conditions
      const result = await refreshTokens();
      environmentSignal?.throwIfAborted();
      headers['Authorization'] = `Bearer ${result.accessToken}`;
      response = await fetch(fullUrl, requestOptions);
    } catch (err) {
      // Only clear tokens if it's actually an auth failure, not a network error
      // Network errors should not log out the user
      if (err.message === 'Token refresh failed' || err.message === 'No refresh token' || err.message === 'Invalid token response') {
        clearTokens(true);
        throw new Error('Session expired');
      }
      // For network errors, just rethrow without clearing tokens
      throw err;
    }
  }

  return response;
}

export async function apiGet(url, options) {
  const response = await apiFetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

export async function apiPost(url, body) {
  const response = await apiFetch(url, {
    method: 'POST',
    body
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

export async function apiDelete(url) {
  const response = await apiFetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.status === 204 ? null : response.json();
}

export async function apiPut(url, body) {
  const response = await apiFetch(url, { method: 'PUT', body });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
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
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

/**
 * Upload a screenshot/image and return the path
 * @param {File|Blob} file - The image file or blob to upload
 * @returns {Promise<string>} The path to the uploaded screenshot (e.g., ~/screenshots/screenshot-xxx.png)
 */
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
