import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authenticateWithPasskey } from '../utils/passkey';
import './LoginPage.css';

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
      setLocalError('Enter your username first to use Passkey');
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
    <div className="pro-login-wrapper">
      <div className="pro-login-container">
        
        {/* Left Panel: Brand / Marketing */}
        <section className="pro-login-brand" aria-label="V4 introduction">
          <div className="pro-brand-header">
            <div className="pro-logo-container">
              <svg className="pro-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <div className="pro-status-dot" />
              <span style={{ fontSize: '0.8125rem', color: 'var(--pro-accent)', letterSpacing: '0.05em', textTransform: 'uppercase', fontWeight: 600 }}>System Secure</span>
            </div>
            <h2 className="pro-form-title">Access Workspace</h2>
            <p className="pro-form-subtitle">Authenticate via credentials or secure passkey.</p>
          </div>

          {error && (
            <div className="pro-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                placeholder="developer@v4.local"
                autoComplete="username"
                disabled={isSubmitting}
                spellCheck="false"
              />
            </div>

            <div className="pro-input-group">
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
              />
            </div>

            <button type="submit" className="pro-submit-btn" disabled={isSubmitting || isPasskeySubmitting}>
              {isSubmitting ? 'Authenticating...' : 'Initialize Session'}
            </button>

            <div className="pro-divider"><span>or</span></div>

            <button
              type="button"
              className="pro-passkey-btn"
              onClick={handlePasskeyLogin}
              disabled={isPasskeySubmitting || isSubmitting}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              {isPasskeySubmitting ? 'Awaiting Device...' : 'Authenticate with Passkey'}
            </button>
          </form>
        </section>

      </div>
    </div>
  );
}
