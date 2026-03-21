import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authenticateWithPasskey } from '../utils/passkey';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);

  const { login, loginWithPasskeyResult, error: authError } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim() || !password.trim()) {
      setLocalError('Username and password are required');
      return;
    }

    setIsSubmitting(true);
    try {
      await login(username.trim(), password.trim());
    } catch (err) {
      // Error is set in auth context
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (!username.trim()) {
      setLocalError('Enter your username first');
      return;
    }
    setLocalError('');
    setIsPasskeySubmitting(true);
    try {
      const data = await authenticateWithPasskey(username.trim());
      loginWithPasskeyResult(data);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setLocalError('Passkey sign-in was cancelled');
      } else {
        setLocalError(err.message || 'Passkey sign-in failed');
      }
    } finally {
      setIsPasskeySubmitting(false);
    }
  };

  const error = localError || authError;

  return (
    <div className="login-page">
      <div className="login-container">
        <section className="login-brand-panel" aria-label="V4 introduction">
          <div className="login-brand-chip">
            <span className="login-brand-chip-dot" aria-hidden="true" />
            V4 Terminal
          </div>
          <div className="login-header">
            <svg className="login-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8l4 4-4 4" />
              <line x1="12" y1="16" x2="18" y2="16" />
            </svg>
            <h1>V4</h1>
            <p className="login-brand-subtitle">Terminal orchestration with live preview, threads, and agent-native flow in one surface.</p>
          </div>

          <div className="login-brand-grid" aria-hidden="true">
            <div className="login-brand-metric">
              <strong>Live terminals</strong>
              <span>Command, review, and preview without changing surface.</span>
            </div>
            <div className="login-brand-metric">
              <strong>Project memory</strong>
              <span>Threads stay attached to repos instead of getting buried in tabs.</span>
            </div>
            <div className="login-brand-metric">
              <strong>Mobile ready</strong>
              <span>Keyboard-safe composer and preview flow built for touch devices.</span>
            </div>
          </div>
        </section>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-form-head">
            <span className="login-form-kicker">Secure access</span>
            <h2>Sign in to continue</h2>
            <p>Use your account or passkey to enter the workspace.</p>
          </div>

          {error && <div className="login-error">{error}</div>}

          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              autoComplete="username"
              disabled={isSubmitting}
            />
          </div>

          <div className="login-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              disabled={isSubmitting}
            />
          </div>

          <button type="submit" className="login-submit" disabled={isSubmitting || isPasskeySubmitting}>
            {isSubmitting ? 'Please wait...' : 'Sign In'}
          </button>

          <div className="login-divider"><span>or</span></div>

          <button
            type="button"
            className="login-passkey-btn"
            onClick={handlePasskeyLogin}
            disabled={isPasskeySubmitting || isSubmitting}
          >
            {isPasskeySubmitting ? 'Waiting for passkey...' : 'Sign in with Passkey'}
          </button>
        </form>
      </div>
    </div>
  );
}
