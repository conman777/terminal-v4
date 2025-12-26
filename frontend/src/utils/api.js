import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './auth';

const API_BASE = import.meta.env.VITE_API_URL || '';

let isRefreshing = false;
let refreshPromise = null;

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token');
  }

  const response = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  if (!response.ok) {
    clearTokens();
    throw new Error('Token refresh failed');
  }

  const data = await response.json();
  const tokens = data?.tokens || data;
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    clearTokens();
    throw new Error('Token refresh failed');
  }
  setTokens(tokens.accessToken, tokens.refreshToken);
  return tokens.accessToken;
}

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
    if (!isRefreshing) {
      isRefreshing = true;
      refreshPromise = refreshAccessToken()
        .finally(() => {
          isRefreshing = false;
          refreshPromise = null;
        });
    }

    try {
      const newToken = await refreshPromise;
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(fullUrl, { ...options, headers });
    } catch {
      // Refresh failed, clear tokens and let caller handle
      clearTokens();
      throw new Error('Session expired');
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
