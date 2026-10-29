import { useState, useEffect, useRef, useId } from 'react';
import './AccountAccess.css';
import { registerPasskey, listPasskeys, deletePasskey } from '../utils/passkey';

export default function PasskeyManager() {
  const nameId = useId();
  const helpId = useId();
  const [passkeys, setPasskeys] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const listRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    loadPasskeys();
    return () => {
      mounted.current = false;
      lifecycle.current += 1;
      listRequest.current += 1;
    };
  }, []);

  async function loadPasskeys() {
    if (!mounted.current) return;
    const request = ++listRequest.current;
    const current = () => mounted.current && request === listRequest.current;
    setIsLoading(true);
    setListError(null);
    try {
      const keys = await listPasskeys();
      if (current()) setPasskeys(keys);
    } catch (err) {
      if (current()) setListError(err?.message || 'Failed to load passkeys');
    } finally {
      if (current()) setIsLoading(false);
    }
  }

  async function handleRegister() {
    if (isRegistering) return;
    const scope = lifecycle.current;
    const current = () => mounted.current && scope === lifecycle.current;
    setError(null);
    setSuccess(null);
    setIsRegistering(true);
    try {
      await registerPasskey(newKeyName.trim() || undefined);
      if (!current()) return;
      setNewKeyName('');
      setSuccess('Passkey registered successfully');
      await loadPasskeys();
    } catch (err) {
      if (!current()) return;
      if (err.name === 'NotAllowedError') {
        setError('Registration was cancelled or timed out');
      } else {
        setError(err.message || 'Registration failed');
      }
    } finally {
      if (current()) setIsRegistering(false);
    }
  }

  async function handleDelete(id, name) {
    if (!confirm(`Remove passkey "${name || 'Unnamed'}"?`)) return;
    const scope = lifecycle.current;
    const current = () => mounted.current && scope === lifecycle.current;
    setError(null);
    setSuccess(null);
    try {
      await deletePasskey(id);
      if (!current()) return;
      setSuccess('Passkey removed');
      await loadPasskeys();
    } catch (err) {
      if (current()) setError(err.message || 'Failed to remove passkey');
    }
  }

  function formatDate(iso) {
    if (!iso) return 'Never';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <section className="form-group passkey-manager" aria-label="Security Keys (Passkeys)">
      <h3>Security Keys (Passkeys)</h3>
      <p className="form-help">
        Sign in with Face ID, Touch ID, or a hardware key instead of your password.
      </p>

      {isLoading && (
        <p className="form-help" role="status">Loading...</p>
      )}
      {listError && (
        <div className="form-error" role="alert">
          {listError}{' '}
          <button className="btn-secondary" onClick={loadPasskeys} disabled={isLoading}>Retry</button>
        </div>
      )}
      {!isLoading && !listError && passkeys.length === 0 && (
        <p className="form-help">No passkeys registered yet.</p>
      )}

      {passkeys.map((key) => (
        <div
          key={key.id}
          className="passkey-entry"
        >
          <div className="passkey-entry-details">
            <strong>
              {key.name || 'Unnamed passkey'}
            </strong>
            <span>
              Added {formatDate(key.createdAt)}
              {key.lastUsedAt ? ` · Last used ${formatDate(key.lastUsedAt)}` : ''}
            </span>
          </div>
          <button
            className="btn-danger"
            onClick={() => handleDelete(key.id, key.name)}
          >
            Remove
          </button>
        </div>
      ))}

      <label htmlFor={nameId}>Passkey name (optional)</label>
      <p className="form-help" id={helpId}>Choose a name to recognize this device later.</p>
      <div className="passkey-registration">
        <input
          id={nameId}
          aria-describedby={helpId}
          type="text"
          placeholder='Name (e.g. "iPhone Face ID")'
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          autoComplete="off"
          disabled={isRegistering}
        />
        <button
          className="btn-primary"
          onClick={handleRegister}
          disabled={isRegistering}
        >
          {isRegistering ? 'Follow prompt...' : '+ Add Passkey'}
        </button>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}
      {success && <div className="form-success" role="status">{success}</div>}
    </section>
  );
}
