import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getAccessToken, getRefreshToken, getUser, setTokens, setUser, clearTokens, setAuthInitializing, refreshTokens } from '../utils/auth';

const API_BASE = import.meta.env.VITE_API_URL || '';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Validate session with backend on mount
  useEffect(() => {
    const validateSession = async () => {
      // Mark auth as initializing to prevent race conditions with apiFetch
      setAuthInitializing(true);

      try {
        const accessToken = getAccessToken();
        const storedRefreshToken = getRefreshToken();

        // No tokens stored - not authenticated
        if (!accessToken && !storedRefreshToken) {
          setLoading(false);
          return;
        }

        // Try to validate the access token with the backend
        if (accessToken) {
          try {
            const response = await fetch(`${API_BASE}/api/auth/me`, {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (response.ok) {
              const userData = await response.json();
              setUser(userData);
              setUserState(userData);
              setLoading(false);
              return;
            }
          } catch {
            // Access token invalid, will try refresh below
          }
        }

        // Access token invalid/expired - try to refresh using centralized function
        if (storedRefreshToken) {
          try {
            const result = await refreshTokens();
            if (result.user) {
              setUserState(result.user);
            } else {
              // Fetch user data if not returned from refresh
              const meResponse = await fetch(`${API_BASE}/api/auth/me`, {
                headers: { 'Authorization': `Bearer ${result.accessToken}` }
              });
              if (meResponse.ok) {
                const userData = await meResponse.json();
                setUser(userData);
                setUserState(userData);
              }
            }
            setLoading(false);
            return;
          } catch {
            // Refresh failed
          }
        }

        // Both access and refresh failed - clear tokens and show login
        clearTokens(true); // Force clear since we're done initializing
        setUserState(null);
        setLoading(false);
      } finally {
        // Always mark auth as done initializing
        setAuthInitializing(false);
      }
    };

    validateSession();
  }, []);

  const login = useCallback(async (username, password) => {
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      setUser(data.user);
      setUserState(data.user);
      return data.user;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, []);

  const register = useCallback(async (username, password) => {
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed');
      }

      setTokens(data.tokens.accessToken, data.tokens.refreshToken);
      setUser(data.user);
      setUserState(data.user);
      return data.user;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      const token = getAccessToken();
      if (token) {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      }
    } catch {
      // Ignore logout errors
    } finally {
      clearTokens();
      setUserState(null);
    }
  }, []);

  const value = {
    user,
    loading,
    error,
    isAuthenticated: !!user,
    login,
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
