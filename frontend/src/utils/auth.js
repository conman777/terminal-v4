const ACCESS_TOKEN_KEY = 'terminal_access_token';
const REFRESH_TOKEN_KEY = 'terminal_refresh_token';
const USER_KEY = 'terminal_user';
const API_BASE = import.meta.env.VITE_API_URL || '';

// Centralized auth state to prevent race conditions
// Start as true - AuthContext will set to false when validation completes
let isAuthInitializing = true;
let refreshPromise = null;

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken, refreshToken) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(force = false) {
  // Don't clear tokens during initial auth validation unless forced
  if (isAuthInitializing && !force) {
    console.log('[Auth] Skipping clearTokens - auth is initializing');
    return;
  }
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getUser() {
  const userJson = localStorage.getItem(USER_KEY);
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function isAuthenticated() {
  return !!getAccessToken();
}

// Mark auth as initializing (called by AuthContext on mount)
export function setAuthInitializing(value) {
  isAuthInitializing = value;
}

export function getAuthInitializing() {
  return isAuthInitializing;
}

function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, '=');
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function isAccessTokenExpired(token, skewSeconds = 30) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return true;
  }
  return Date.now() >= (payload.exp - skewSeconds) * 1000;
}

// Centralized token refresh - ensures only one refresh happens at a time
export async function refreshTokens() {
  // If already refreshing, wait for that to complete
  if (refreshPromise) {
    return refreshPromise;
  }

  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token');
  }

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });

      if (!response.ok) {
        throw new Error('Token refresh failed');
      }

      const data = await response.json();
      const tokens = data?.tokens || data;
      if (!tokens?.accessToken || !tokens?.refreshToken) {
        throw new Error('Invalid token response');
      }

      setTokens(tokens.accessToken, tokens.refreshToken);
      if (data.user) {
        setUser(data.user);
      }
      return { accessToken: tokens.accessToken, user: data.user };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}
