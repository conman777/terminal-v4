import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { login, register, error: authError } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim() || !password) {
      setLocalError('Username and password are required');
      return;
    }

    if (isRegister) {
      if (password !== confirmPassword) {
        setLocalError('Passwords do not match');
        return;
      }
      if (password.length < 8) {
        setLocalError('Password must be at least 8 characters');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      if (isRegister) {
        await register(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
    } catch (err) {
      // Error is set in auth context
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    setLocalError('');
    setConfirmPassword('');
  };

  const error = localError || authError;

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <svg className="login-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 8l4 4-4 4" />
            <line x1="12" y1="16" x2="18" y2="16" />
          </svg>
          <h1>Terminal</h1>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <h2>{isRegister ? 'Create Account' : 'Sign In'}</h2>

          {error && <div className="login-error">{error}</div>}

          <div className="login-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
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
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              disabled={isSubmitting}
            />
          </div>

          {isRegister && (
            <div className="login-field">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                autoComplete="new-password"
                disabled={isSubmitting}
              />
            </div>
          )}

          <button type="submit" className="login-submit" disabled={isSubmitting}>
            {isSubmitting ? 'Please wait...' : (isRegister ? 'Create Account' : 'Sign In')}
          </button>

          <div className="login-toggle">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}
            <button type="button" onClick={toggleMode} disabled={isSubmitting}>
              {isRegister ? 'Sign In' : 'Register'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
