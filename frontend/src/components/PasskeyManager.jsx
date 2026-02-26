import { useState, useEffect } from 'react';
import { registerPasskey, listPasskeys, deletePasskey } from '../utils/passkey';

export default function PasskeyManager() {
  const [passkeys, setPasskeys] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadPasskeys();
  }, []);

  async function loadPasskeys() {
    setIsLoading(true);
    try {
      const keys = await listPasskeys();
      setPasskeys(keys);
    } catch (err) {
      // silently fail — section just shows empty
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRegister() {
    if (isRegistering) return;
    setError(null);
    setSuccess(null);
    setIsRegistering(true);
    try {
      await registerPasskey(newKeyName.trim() || undefined);
      setNewKeyName('');
      setSuccess('Passkey registered successfully');
      await loadPasskeys();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        setError('Registration was cancelled or timed out');
      } else {
        setError(err.message || 'Registration failed');
      }
    } finally {
      setIsRegistering(false);
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Remove passkey "${name || 'Unnamed'}"?`)) return;
    setError(null);
    setSuccess(null);
    try {
      await deletePasskey(id);
      setSuccess('Passkey removed');
      await loadPasskeys();
    } catch (err) {
      setError(err.message || 'Failed to remove passkey');
    }
  }

  function formatDate(iso) {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className="form-group">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <label style={{ margin: 0 }}>Security Keys (Passkeys)</label>
      </div>
      <p className="form-help">
        Sign in with Face ID, Touch ID, or a hardware key instead of your password.
      </p>

      {isLoading ? (
        <p className="form-help" style={{ fontStyle: 'italic' }}>Loading...</p>
      ) : (
        <>
          {passkeys.length === 0 && (
            <p className="form-help" style={{ fontStyle: 'italic' }}>No passkeys registered yet.</p>
          )}

          {passkeys.map((key) => (
            <div
              key={key.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                background: 'var(--bg-secondary, #1a1a1a)',
                borderRadius: '4px',
                marginBottom: '4px',
                fontSize: '13px'
              }}
            >
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <strong style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {key.name || 'Unnamed passkey'}
                </strong>
                <span style={{ color: 'var(--text-secondary, #888)', fontSize: '11px' }}>
                  Added {formatDate(key.createdAt)}
                  {key.lastUsedAt ? ` · Last used ${formatDate(key.lastUsedAt)}` : ''}
                </span>
              </div>
              <button
                className="btn-danger"
                style={{ fontSize: '11px', padding: '2px 8px', flexShrink: 0, marginLeft: '8px' }}
                onClick={() => handleDelete(key.id, key.name)}
              >
                Remove
              </button>
            </div>
          ))}
        </>
      )}

      <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
        <input
          type="text"
          placeholder='Name (e.g. "iPhone Face ID")'
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          style={{ flex: 1 }}
          autoComplete="off"
          disabled={isRegistering}
        />
        <button
          className="btn-primary"
          style={{ fontSize: '12px', padding: '4px 12px', whiteSpace: 'nowrap' }}
          onClick={handleRegister}
          disabled={isRegistering}
        >
          {isRegistering ? 'Follow prompt...' : '+ Add Passkey'}
        </button>
      </div>

      {error && <div className="form-error" style={{ marginTop: '6px' }}>{error}</div>}
      {success && <div className="form-success" style={{ marginTop: '6px' }}>{success}</div>}
    </div>
  );
}
