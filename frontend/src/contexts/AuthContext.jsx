import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getAccessToken, getRefreshToken, getUser, setTokens, setUser, clearTokens, setAuthInitializing, refreshTokens, beginAuthChange, captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { resolveHomeApiUrl } from '../utils/apiBase';
import { isStrictAuthSelected, selectStrictAuth } from '../utils/strictAuthBoundary';

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

function LegacyAuthProvider({ children }) {
  const [user, setUserState] = useState(() => getUser());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cleanupNotice, setCleanupNotice] = useState('');
  const [authNotice, setAuthNotice] = useState('');

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
      if (reason === 'damaged-history') {
        const message = 'Local sign-in history is damaged. Save any unsaved drafts and contact your administrator; signing in will not repair it.';
        setAuthNotice(message);
        if (!authenticatedUser) setError(message);
      } else if (reason === 'refresh-uncertain') {
        const message = 'Sign-in refresh could not be confirmed. Save unsaved drafts before signing out and signing in again. If the problem continues, contact your administrator.';
        setAuthNotice(message);
        if (!authenticatedUser) setError(message);
      } else if (authenticatedUser) {
        setCleanupNotice('');
        if (reason !== 'rotation') { setError(null); setAuthNotice(''); }
      }
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'local-testing' ? {username} : { username, password, pairBinding: true })
      });
      const data = await response.json();
      if (!current()) throw new Error('Authentication changed');
      if (response.status === 426) throw new Error('Upgrade required: this account needs a newer sign-in. Reload the app or contact your administrator, then sign in again.');
      if (!response.ok) throw new Error(data.error || 'Login failed');
      setTokens(data.tokens.accessToken, data.tokens.refreshToken, data.session?.pairSeq);
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
    authNotice,
    dismissAuthNotice: () => setAuthNotice(''),
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

function StrictAuthProvider({ children, strictAuth, strictBoundaryReady }) {
  const [user, setUserState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [strictReady, setStrictReady] = useState(false);
  const [strictStatus, setStrictStatus] = useState('initializing');
  const [error, setError] = useState(null);
  const [authNotice, setAuthNotice] = useState('');
  const mounted = useRef(false), sequence = useRef(0), readyScope = useRef(null), verifiedUser = useRef(null), subscribed = useRef(false);
  const { lifecycle, home, validateSession } = strictAuth || {};
  const subscribe = strictAuth?.subscribe || lifecycle?.subscribe;
  const configuredHome = new URL(resolveHomeApiUrl('/'), window.location.origin).href;
  const configured = Boolean(strictBoundaryReady && lifecycle && typeof lifecycle.read === 'function' && typeof lifecycle.login === 'function'
    && typeof lifecycle.refresh === 'function' && typeof lifecycle.logout === 'function'
    && typeof lifecycle.recoverLogin === 'function' && typeof lifecycle.resumeLogout === 'function'
    && typeof lifecycle.recoverRetirements === 'function' && typeof lifecycle.pendingLogins === 'function' && typeof validateSession === 'function'
    && typeof subscribe === 'function' && (lifecycle.notifications?.subscribe === subscribe || lifecycle.subscribe === subscribe)
    && typeof lifecycle.notifications?.publish === 'function' && home === configuredHome);

  const sync = useCallback(async ({ allowSignout = false, allowIdentityChange = false, expectedIncarnation, allowRefresh = true } = {}) => {
    const request = ++sequence.current;
    const current = () => mounted.current && request === sequence.current;
    const hold = (status, message) => {
      if (current()) { readyScope.current = null; setStrictReady(false); setStrictStatus(status); setAuthNotice(message); setLoading(false); }
      return null;
    };
    if (!configured || !subscribed.current) return hold('unavailable', 'Sign-in authority is unavailable. Save any unsaved drafts before recovery.');
    let snapshot;
    try { snapshot = await lifecycle.read(); }
    catch { return hold('unavailable', 'Sign-in authority is unavailable. Save any unsaved drafts before recovery.'); }
    if (!current()) return null;
    if (snapshot?.status === 'tombstone') {
      if (verifiedUser.current && !allowSignout) return hold('signed-out', 'This session signed out. Save any unsaved drafts before leaving this workspace.');
      readyScope.current = null; verifiedUser.current = null; setUserState(null); setStrictReady(false); setStrictStatus('signed-out'); setAuthNotice(''); setLoading(false);
      return snapshot;
    }
    if (snapshot?.status !== 'active' || snapshot.refreshReserved) return hold(snapshot?.status === 'active' ? 'refresh-pending' : snapshot?.status || 'unavailable', snapshot?.status === 'unavailable' ? 'Sign-in authority is unavailable. Save any unsaved drafts before recovery.' : 'Sign-in could not be confirmed. Save any unsaved drafts before recovery.');
    const pair = snapshot.pair;
    if (!pair || pair.home !== home || !pair.owner || snapshot.user?.id !== pair.owner || !pair.session || !pair.accessToken || !snapshot.incarnation) return hold('unavailable', 'Sign-in authority is unavailable. Save any unsaved drafts before recovery.');
    let validation;
    try { validation = await validateSession({ home, owner: pair.owner, session: pair.session, incarnation: snapshot.incarnation, accessToken: pair.accessToken }); }
    catch { return hold('unavailable', 'Sign-in could not be confirmed. Save any unsaved drafts before recovery.'); }
    if (!current()) return null;
    if (validation?.status === 'expired' && allowRefresh) {
      let refreshed;
      try { refreshed = await lifecycle.refresh({ home, owner: pair.owner, session: pair.session, incarnation: snapshot.incarnation }); }
      catch { return hold('unavailable', 'Sign-in could not be confirmed. Save any unsaved drafts before recovery.'); }
      if (!current()) return null;
      if (refreshed?.status === 'active') return sync({ allowSignout, allowIdentityChange, expectedIncarnation: snapshot.incarnation, allowRefresh: false });
      return hold(refreshed?.status || 'unavailable', 'Sign-in could not be confirmed. Save any unsaved drafts before recovery.');
    }
    if (validation?.status !== 'valid') return hold('unavailable', 'Sign-in could not be confirmed. Save any unsaved drafts before recovery.');
    let latest;
    try { latest = await lifecycle.read(); }
    catch { return hold('unavailable', 'Sign-in authority is unavailable. Save any unsaved drafts before recovery.'); }
    if (!current()) return null;
    if (latest?.status !== 'active' || latest.refreshReserved || latest.revision !== snapshot.revision || latest.controlRevision !== snapshot.controlRevision
      || latest.incarnation !== snapshot.incarnation || latest.pair?.owner !== pair.owner || latest.pair?.session !== pair.session
      || latest.pair?.home !== home || latest.pair?.accessToken !== pair.accessToken || latest.user?.id !== pair.owner) return sync({ allowSignout, allowIdentityChange, expectedIncarnation, allowRefresh });
    if (expectedIncarnation && latest.incarnation !== expectedIncarnation) return hold('account-changed', 'The account changed in another tab. Save any unsaved drafts before leaving this workspace.');
    if (verifiedUser.current && verifiedUser.current.id !== latest.user.id && !allowIdentityChange) return hold('account-changed', 'The account changed in another tab. Save any unsaved drafts before leaving this workspace.');
    readyScope.current = { incarnation: latest.incarnation, owner: pair.owner, session: pair.session, home };
    verifiedUser.current = latest.user;
    setUserState(latest.user); setStrictReady(true); setStrictStatus('active'); setAuthNotice(''); setError(null); setLoading(false);
    return latest;
  }, [configured, home, lifecycle, validateSession]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe;
    try {
      if (configured) {
        unsubscribe = subscribe(hint => { if (mounted.current) { if (hint?.status === 'unavailable') subscribed.current = false; readyScope.current = null; setStrictReady(false); void sync(); } });
        if (typeof unsubscribe !== 'function') throw new Error('Subscription unavailable');
        subscribed.current = true;
      }
    } catch { subscribed.current = false; }
    void sync();
    return () => { mounted.current = false; subscribed.current = false; sequence.current += 1; readyScope.current = null; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [configured, subscribe, sync]);

  const login = useCallback(async (username, password, mode = 'password') => {
    if (!configured || !subscribed.current || !['password', 'local-testing'].includes(mode)) throw new Error('Sign-in authority is unavailable.');
    setError(null);
    const result = await lifecycle.login(home, { kind: mode, username, ...(mode === 'password' ? { password } : {}) });
    const latest = await sync({ allowIdentityChange: result.status === 'active', ...(result.status === 'active' ? { expectedIncarnation: result.incarnation } : {}) });
    if (result.status === 'active' && latest?.status === 'active' && latest.incarnation === result.incarnation) return latest.user;
    const message = 'Sign-in could not be confirmed. Review its status before trying again.';
    if (mounted.current) setError(message);
    throw new Error(message);
  }, [configured, home, lifecycle, sync]);

  const register = useCallback(async (username, password) => {
    if (!configured || !subscribed.current) throw new Error('Sign-in authority is unavailable.');
    const result = await lifecycle.login(home, { kind: 'register', username, password });
    const latest = await sync({ allowIdentityChange: result.status === 'active', ...(result.status === 'active' ? { expectedIncarnation: result.incarnation } : {}) });
    if (result.status === 'active' && latest?.status === 'active' && latest.incarnation === result.incarnation) return latest.user;
    throw new Error('Registration could not be confirmed. Review its status before trying again.');
  }, [configured, home, lifecycle, sync]);

  const action = useCallback(async (name, ...args) => {
    if (!configured || !subscribed.current) return { status: 'unavailable' };
    const result = await lifecycle[name](...args);
    await sync({ allowSignout: ['logout', 'resumeLogout'].includes(name) && result.status === 'tombstone' });
    return result;
  }, [configured, lifecycle, sync]);
  const refreshAuth = useCallback(async () => {
    const scope = readyScope.current;
    if (!scope) return { status: 'unavailable' };
    return action('refresh', scope);
  }, [action]);

  const value = {
    user, loading, error, authNotice, cleanupNotice: '', isAuthenticated: !!user,
    authLifecycle: configured ? lifecycle : null, strictReady, strictStatus, refreshAuth,
    dismissAuthNotice: () => setAuthNotice(''), login, register,
    loginWithPasskeyResult: () => false,
    logout: () => action('logout'), recoverLogin: intent => action('recoverLogin', intent),
    resumeLogout: incarnation => action('resumeLogout', incarnation), recoverRetirements: () => action('recoverRetirements'),
    pendingLogins: () => action('pendingLogins'),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider(props) {
  if (Object.hasOwn(props, 'strictAuth')) {
    const strictBoundaryReady = selectStrictAuth();
    return <StrictAuthProvider {...props} strictBoundaryReady={strictBoundaryReady} />;
  }
  if (isStrictAuthSelected()) return <StrictAuthProvider strictAuth={null} strictBoundaryReady={false}>{props.children}</StrictAuthProvider>;
  return <LegacyAuthProvider {...props} />;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
