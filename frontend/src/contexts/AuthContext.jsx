import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getAccessToken, getRefreshToken, getUser, setTokens, setUser, clearTokens, setAuthInitializing, refreshTokens, beginAuthChange, captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { resolveHomeApiUrl } from '../utils/apiBase';

const AuthContext = createContext(null);

function normalizeAuthError(err) {
  if (err instanceof TypeError) {
    const origin = new URL(resolveHomeApiUrl('/api/auth/login'), window.location.origin).origin;
    return new Error(`Cannot connect to the app at ${origin}. Restart the local app and try again.`);
  }

  if (err instanceof Error) {
    return err;
  }

  return new Error('Authentication failed');
}

async function syncPreviewSession(accessToken) {
  if (!accessToken) return;

  await fetch(resolveHomeApiUrl('/api/preview/session'), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
}

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(() => getUser());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cleanupNotice, setCleanupNotice] = useState('');

  const liveRef = useRef(true);

  // Validate session with backend on mount, without granting late responses auth authority.
  useEffect(() => {
    let mounted = true;
    liveRef.current = true;
    let validationScope = captureAuthScope();
    const current = () => mounted && isAuthScopeCurrent(validationScope);
    const unsubscribe = subscribeAuth(reason => {
      if (!mounted) return;
      const authenticatedUser = getAccessToken() || getRefreshToken() ? getUser() : null;
      setUserState(authenticatedUser);
      if (authenticatedUser) setCleanupNotice('');
      if (reason !== 'rotation') { setLoading(false); setAuthInitializing(false); }
    });
    setAuthInitializing(true);
    const validateSession = async () => {
      try {
        const accessToken = getAccessToken();
        const storedRefreshToken = getRefreshToken();
        if (!accessToken && !storedRefreshToken) {
          if (current()) { setUserState(null); setLoading(false); }
          return;
        }
        if (accessToken) {
          try {
            const response = await fetch(resolveHomeApiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${accessToken}` } });
            if (!current()) return;
            if (response.ok) {
              const userData = await response.json();
              if (!current()) return;
              setUser(userData);
              validationScope = captureAuthScope();
              setUserState(userData);
              await syncPreviewSession(accessToken).catch(() => {});
              if (current()) setLoading(false);
              return;
            }
            if (response.status !== 401 && response.status !== 403) { setLoading(false); return; }
          } catch {
            if (current()) setLoading(false);
            return;
          }
        }
        if (storedRefreshToken) {
          try {
            const result = await refreshTokens();
            if (!current()) return;
            if (result.user) {
              setUser(result.user);
              validationScope = captureAuthScope();
              setUserState(result.user);
            } else {
              const meResponse = await fetch(resolveHomeApiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${result.accessToken}` } });
              if (!current()) return;
              if (meResponse.status === 401 || meResponse.status === 403) { clearTokens(true); return; }
              if (meResponse.ok) {
                const userData = await meResponse.json();
                if (!current()) return;
                setUser(userData);
                validationScope = captureAuthScope();
                setUserState(userData);
              }
            }
            await syncPreviewSession(result.accessToken).catch(() => {});
            if (current()) setLoading(false);
            return;
          } catch (err) {
            if (!current()) return;
            if (!['Token refresh failed', 'No refresh token', 'Invalid token response'].includes(err?.message)) {
              setLoading(false);
              return;
            }
          }
        }
        if (current()) { clearTokens(true); setUserState(null); setLoading(false); }
      } finally {
        if (current()) setAuthInitializing(false);
      }
    };
    void validateSession();
    return () => { mounted = false; liveRef.current = false; unsubscribe(); };
  }, []);

  const login = useCallback(async (username, password, mode = 'password') => {
    let scope = beginAuthChange();
    const current = () => liveRef.current && isAuthScopeCurrent(scope);
    setError(null);
    try {
      const response = await fetch(resolveHomeApiUrl(mode === 'local-testing' ? '/api/auth/local-testing' : '/api/auth/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'local-testing' ? {username} : { username, password })
      });
      const data = await response.json();
      if (!current()) throw new Error('Authentication changed');
      if (!response.ok) throw new Error(data.error || 'Login failed');
      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      setUser(data.user);
      scope = captureAuthScope();
      setUserState(data.user);
      setCleanupNotice('');
      setLoading(false);
      setAuthInitializing(false);
      await syncPreviewSession(data.tokens.accessToken).catch(() => {});
      if (!current()) throw new Error('Authentication changed');
      return data.user;
    } catch (err) {
      const normalized = normalizeAuthError(err);
      if (current()) setError(normalized.message);
      throw normalized;
    }
  }, []);

  const register = useCallback(async (username, password) => {
    let scope = beginAuthChange();
    const current = () => liveRef.current && isAuthScopeCurrent(scope);
    setError(null);
    try {
      const response = await fetch(resolveHomeApiUrl('/api/auth/register'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!current()) throw new Error('Authentication changed');
      if (!response.ok) throw new Error(data.error || 'Registration failed');
      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      setUser(data.user);
      scope = captureAuthScope();
      setUserState(data.user);
      setCleanupNotice('');
      setLoading(false);
      setAuthInitializing(false);
      await syncPreviewSession(data.tokens.accessToken).catch(() => {});
      if (!current()) throw new Error('Authentication changed');
      return data.user;
    } catch (err) {
      const normalized = normalizeAuthError(err);
      if (current()) setError(normalized.message);
      throw normalized;
    }
  }, []);

  const loginWithPasskeyResult = useCallback((data, scope) => {
    if (!liveRef.current || !scope || !isAuthScopeCurrent(scope)) return false;
    setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    setUser(data.user);
    setUserState(data.user);
    setCleanupNotice('');
    setLoading(false);
    setAuthInitializing(false);
    void syncPreviewSession(data.tokens.accessToken).catch(() => {});
    return true;
  }, []);

  const logout = useCallback(async () => {
    const scope = beginAuthChange();
    let notice = '';
    try {
      const token = getAccessToken();
      if (token) {
        const response = await fetch(resolveHomeApiUrl('/api/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        const result = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
        if (!response.ok || (result?.cleanup && (result.success !== true || !['complete', 'pending'].includes(result.cleanup.state))) || (response.status === 202 && result?.cleanup?.state !== 'pending')) {
          notice = 'Signed out on this device, but server cleanup could not be confirmed. Sign back in to check.';
        } else if (result?.cleanup?.state === 'pending') {
          notice = 'Signed out. Server cleanup is still pending; sign back in to check its status.';
        }
      }
    } catch {
      notice = 'Signed out on this device, but server cleanup could not be confirmed. Sign back in to check.';
    } finally {
      if (isAuthScopeCurrent(scope)) {
        clearTokens(true);
        if (liveRef.current) { setUserState(null); setLoading(false); setCleanupNotice(notice); }
        setAuthInitializing(false);
      }
    }
  }, []);

  const value = {
    user,
    loading,
    error,
    cleanupNotice,
    isAuthenticated: !!user,
    login,
    loginWithPasskeyResult,
    register,
    logout
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
