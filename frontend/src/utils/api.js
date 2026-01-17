import { getAccessToken, clearTokens, refreshTokens, getAuthInitializing } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || '';

export async function apiFetch(url, options = {}) {
  const accessToken = getAccessToken();

  const headers = {
    ...options.headers,
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  let response = await fetch(fullUrl, { ...options, headers });

  // Handle 401 - try to refresh token
  if (response.status === 401 && accessToken) {
    // If auth is still initializing, don't try to refresh - let AuthContext handle it
    if (getAuthInitializing()) {
      throw new Error('Auth initializing');
    }

    try {
      // Use centralized refresh to avoid race conditions
      const result = await refreshTokens();
      headers['Authorization'] = `Bearer ${result.accessToken}`;
      response = await fetch(fullUrl, { ...options, headers });
    } catch (err) {
      // Only clear tokens if it's actually an auth failure, not a network error
      // Network errors should not log out the user
      if (err.message === 'Token refresh failed' || err.message === 'No refresh token' || err.message === 'Invalid token response') {
        clearTokens();
        throw new Error('Session expired');
      }
      // For network errors, just rethrow without clearing tokens
      throw err;
    }
  }

  return response;
}

export async function apiGet(url) {
  const response = await apiFetch(url);
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

export async function apiPatch(url, body) {
  const response = await apiFetch(url, {
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
    throw new Error(error.error || error.message || 'Screenshot upload failed');
  }

  const data = await response.json();
  return data.path;
}
