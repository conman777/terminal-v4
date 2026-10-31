import { useState, useEffect, useRef, useId } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authenticateWithPasskey } from '../utils/passkey';
import { beginAuthChange, isAuthScopeCurrent } from '../utils/auth';
import { resolveHomeApiUrl } from '../utils/apiBase';
import './LoginPage.css';

export default function LoginPage() {
  const { login, loginWithPasskeyResult, error: authError, cleanupNotice, strictStatus } = useAuth();
  const authUnavailable = strictStatus === 'unavailable';
  const errorId = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);
  const [authMode, setAuthMode] = useState('password');
  const localTesting = authMode === 'local-testing';
  useEffect(() => {
    if (authUnavailable) return undefined;
    const controller = new AbortController();
    fetch(resolveHomeApiUrl('/api/auth/mode'), { signal:controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (!controller.signal.aborted && value?.mode === 'local-testing') setAuthMode('local-testing'); })
      .catch(() => {});
    return () => controller.abort();
  }, [authUnavailable]);
  const liveRef = useRef(true);
  useEffect(() => { liveRef.current = true; return () => { liveRef.current = false; }; }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim() || !localTesting && !password) {
      setLocalError(localTesting ? 'Enter a username' : 'Username and password are required');
      return;
    }

    setIsSubmitting(true);
    try {
      if (localTesting) await login(username.trim(), undefined, 'local-testing');
      else await login(username.trim(), password);
    } catch (err) {
      // Error is set in auth context
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (!username.trim()) {
      setLocalError('Enter your username first to use Passkey');
      return;
    }
    const scope = beginAuthChange();
    const current = () => liveRef.current && isAuthScopeCurrent(scope);
    setLocalError('');
    setIsPasskeySubmitting(true);
    try {
      const data = await authenticateWithPasskey(username.trim());
      if (current()) loginWithPasskeyResult(data, scope);
    } catch (err) {
      if (!current()) return;
      if (err.name === 'NotAllowedError') {
        setLocalError('Passkey sign-in was cancelled');
      } else {
        setLocalError(err.message || 'Passkey sign-in failed');
      }
    } finally {
      if (liveRef.current) setIsPasskeySubmitting(false);
    }
  };

  // Security: only set in a gitignored local env file for a local-only test account.
  const testLoginUsername = import.meta.env.VITE_TEST_LOGIN_USERNAME;
  const testLoginPassword = import.meta.env.VITE_TEST_LOGIN_PASSWORD;
  const hasTestLogin = Boolean(testLoginUsername && testLoginPassword);

  const handleTestLogin = async () => {
    setLocalError('');
    setIsSubmitting(true);
    try {
      await login(testLoginUsername, testLoginPassword);
    } catch (err) {
      // Error is set in auth context
    } finally {
      setIsSubmitting(false);
    }
  };

  const error = localError || authError;

  if (authUnavailable) {
    return (
      <main className="pro-login-wrapper">
        <section className="pro-login-container" role="alert">
          <div className="pro-login-form-wrapper">
            <h1 className="pro-form-title">Sign-in is unavailable</h1>
            <p className="pro-form-subtitle">Check that browser session storage is enabled, then reload this page. If the problem continues, contact your administrator. Your saved sign-in has not been changed.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="pro-login-wrapper">
      <div className="pro-login-container">
        
        {/* Left Panel: Brand / Marketing */}
        <section className="pro-login-brand" aria-label="V4 introduction">
          <div className="pro-brand-header">
            <div className="pro-logo-container">
              <svg aria-hidden="true" className="pro-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M6 8l4 4-4 4" />
                <line x1="12" y1="16" x2="18" y2="16" />
              </svg>
              <span className="pro-logo-text">V4 Terminal</span>
            </div>
            <h1 className="pro-brand-title">Terminal orchestration evolved.</h1>
            <p className="pro-brand-subtitle">
              Live preview, threaded memory, and agent-native workflows fused into a single unified workspace.
            </p>
          </div>

          <div className="pro-features" aria-hidden="true">
            <div className="pro-feature-item">
              <span className="pro-feature-title">Live Terminals</span>
              <span className="pro-feature-desc">Command, review, and preview without changing surface.</span>
            </div>
            <div className="pro-feature-item">
              <span className="pro-feature-title">Project Memory</span>
              <span className="pro-feature-desc">Threads stay attached to repos instead of getting buried in tabs.</span>
            </div>
            <div className="pro-feature-item">
              <span className="pro-feature-title">Mobile Ready</span>
              <span className="pro-feature-desc">Keyboard-safe composer and preview flow built for touch devices.</span>
            </div>
          </div>
        </section>

        {/* Right Panel: Auth Form */}
        <section className="pro-login-form-wrapper">
          <div className="pro-form-header">
            <p className="pro-login-mode">{localTesting ? 'Local testing' : 'Workspace sign-in'}</p>
            <h2 className="pro-form-title">{localTesting ? 'Choose your username' : 'Access Workspace'}</h2>
            <p className="pro-form-subtitle">{localTesting ? 'Your username opens your testing account. Use the same name to return to your work.' : 'Authenticate via credentials or secure passkey.'}</p>
          </div>

          {cleanupNotice && <p className="pro-cleanup-notice" role="status">{cleanupNotice}</p>}
          {error && (
            <div className="pro-error" id={errorId} role="alert">
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="pro-form">
            <div className="pro-input-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                type="text"
                className="pro-input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={localTesting ? 'e.g. developer' : 'Your username'}
                autoComplete="username"
                disabled={isSubmitting}
                aria-describedby={error ? errorId : undefined}
                spellCheck="false"
              />
            </div>

            {!localTesting && <div className="pro-input-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                className="pro-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                autoComplete="current-password"
                disabled={isSubmitting}
                aria-describedby={error ? errorId : undefined}
              />
            </div>}

            <button type="submit" className="pro-submit-btn" disabled={isSubmitting || isPasskeySubmitting}>
              {isSubmitting ? 'Opening...' : localTesting ? 'Open workspace' : 'Initialize Session'}
            </button>

            {!localTesting && <><div className="pro-divider"><span>or</span></div>

            <button
              type="button"
              className="pro-passkey-btn"
              onClick={handlePasskeyLogin}
              disabled={isPasskeySubmitting || isSubmitting}
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              {isPasskeySubmitting ? 'Awaiting Device...' : 'Authenticate with Passkey'}
            </button></>}

            {!localTesting && hasTestLogin && (
              <button
                type="button"
                className="pro-passkey-btn"
                onClick={handleTestLogin}
                disabled={isSubmitting || isPasskeySubmitting}
              >
                Log in as test user
              </button>
            )}
          </form>
        </section>

      </div>
    </main>
  );
}
