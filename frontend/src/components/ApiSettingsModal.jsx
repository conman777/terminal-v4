import './UtilityDialogs.css';
import { getActiveEnvironment } from '../utils/remoteEnvironments';
import { useState, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { apiGet, apiPost, apiDelete, apiPatch } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import PasskeyManager from './PasskeyManager';

export default function ApiSettingsModal({ isOpen, onClose }) {
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  return isOpen ? <OpenApiSettingsModal onClose={onClose} writing={writing} pending={pending} onWritingChange={setPending} /> : null;
}

function OpenApiSettingsModal({ onClose, writing, pending, onWritingChange }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const mounted = useRef(false);
  const settingsRequest = useRef(null);
  const vaultRequest = useRef(null);
  const copyTimer = useRef(null);
  const inheritedWrite = useRef(pending);
  const { user } = useAuth();
  const [groqApiKey, setGroqApiKey] = useState('');
  const [hasExistingGroqKey, setHasExistingGroqKey] = useState(false);
  const [maskedGroqKey, setMaskedGroqKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Vault state
  const [vaultKeys, setVaultKeys] = useState([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [vaultSaving, setVaultSaving] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [vaultLoading, setVaultLoading] = useState(true);
  const [vaultError, setVaultError] = useState('');

  useLayoutEffect(() => {
    const opener = document.activeElement;
    closeRef.current.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (!pending && inheritedWrite.current) {
      inheritedWrite.current = false;
      void loadSettings(); void loadVaultKeys();
    }
  }, [pending]);

  function keyDown(event) {
    if (event.defaultPrevented || event.target.closest('[role="dialog"], dialog') !== dialogRef.current) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const fields = [...dialogRef.current.querySelectorAll('button, input, a[href]')].filter(element => !element.matches(':disabled'));
    const first = fields[0], last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  useEffect(() => {
    mounted.current = true;
    loadSettings();
    loadVaultKeys();
    return () => {
      mounted.current = false;
      settingsRequest.current?.abort();
      vaultRequest.current?.abort();
      clearTimeout(copyTimer.current);
    };
  }, []);

  const loadSettings = async () => {
    settingsRequest.current?.abort();
    const controller = new AbortController();
    settingsRequest.current = controller;
    if (dialogRef.current?.contains(document.activeElement) && document.activeElement !== closeRef.current) closeRef.current.focus({ preventScroll: true });
    setIsLoading(true);
    setSettingsError('');
    try {
      const data = await apiGet('/api/settings', { home: true, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setHasExistingGroqKey(data.hasGroqApiKey);
      setMaskedGroqKey(data.groqApiKey || '');
      setSettingsLoaded(true);
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) { setSettingsLoaded(false); setSettingsError(err.message || 'Failed to load settings'); }
    } finally {
      if (mounted.current && !controller.signal.aborted) setIsLoading(false);
    }
  };

  const loadVaultKeys = async (event) => {
    if (event?.currentTarget) closeRef.current?.focus({ preventScroll: true });
    vaultRequest.current?.abort();
    const controller = new AbortController();
    vaultRequest.current = controller;
    setVaultLoading(true); setVaultError('');
    try {
      const data = await apiGet('/api/vault', { home: true, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setVaultKeys(data.keys || []);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setVaultError(failure.message || 'Failed to load vault');
    } finally {
      if (mounted.current && !controller.signal.aborted) setVaultLoading(false);
    }
  };

  const handleAddVaultKey = async () => {
    if (writing.current || !newKeyName.trim() || !newKeyValue) return;
    writing.current = true;
    onWritingChange(true);
    setVaultSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPost('/api/vault', { keyName: newKeyName.trim(), keyValue: newKeyValue });
      if (!mounted.current) return;
      setNewKeyName('');
      setNewKeyValue('');
      setShowAddKey(false);
      setSuccess('Key added to vault');
      await loadVaultKeys();
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to add key');
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setVaultSaving(false);
    }
  };

  const handleCopyVaultKey = async (id) => {
    try {
      const data = await apiGet(`/api/vault/${id}/reveal`);
      if (!mounted.current) return;
      await navigator.clipboard.writeText(data.keyValue);
      if (!mounted.current) return;
      setCopiedId(id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      if (mounted.current) setError('Failed to copy key');
    }
  };

  const handleDeleteVaultKey = async (id, name) => {
    if (writing.current || !confirm(`Delete key "${name}"?`)) return;
    writing.current = true;
    onWritingChange(true);
    setVaultSaving(true); setError(null); setSuccess(null);
    try {
      await apiDelete(`/api/vault/${id}`);
      if (!mounted.current) return;
      setSuccess(`Key "${name}" deleted`);
      await loadVaultKeys();
    } catch {
      if (mounted.current) setError('Failed to delete key');
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setVaultSaving(false);
    }
  };

  const handleSave = async () => {
    if (writing.current || !settingsLoaded) return;
    writing.current = true;
    onWritingChange(true);
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = {};
      if (groqApiKey.trim()) {
        payload.groqApiKey = groqApiKey;
      }
      if (Object.keys(payload).length === 0) {
        setError('Enter at least one API key to save');
        return;
      }

      await apiPatch('/api/settings', payload, { home: true });
      if (!mounted.current) return;
      setSuccess('API key settings saved successfully');
      setGroqApiKey('');
      await loadSettings();
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to save settings');
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setIsSaving(false);
    }
  };

  const handleClearGroq = async () => {
    if (writing.current || !settingsLoaded) return;
    writing.current = true;
    onWritingChange(true);
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch('/api/settings', { groqApiKey: null }, { home: true });
      if (!mounted.current) return;
      setSuccess('Groq API key removed');
      setGroqApiKey('');
      await loadSettings();
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to remove API key');
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={dialogRef} className="modal-content api-settings-modal ui-utility-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keyDown} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id={titleId}>{getActiveEnvironment() ? 'Home server API settings' : 'API Settings'}</h2>
          <button ref={closeRef} className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {pending && !isSaving && !vaultSaving && <p role="status">An earlier settings update is still pending. Wait for it to finish before making another change.</p>}
          {isLoading ? (
            <div className="loading" role="status">Loading settings...</div>
          ) : (
            <>
              {settingsError && <div className="form-error"><p role="alert">{settingsError}</p><button type="button" className="btn-secondary" onClick={loadSettings}>Retry loading API settings</button></div>}
              <div className="form-group">
                <label htmlFor="groq-api-key">Groq API Key</label>
                <p id="groq-key-help" className="form-help">
                  Used for voice-to-text transcription. Get your key from{' '}
                  <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">
                    console.groq.com
                  </a>
                </p>
                <p className="form-help">
                  Stored per-user on the server. Current user:{' '}
                  <strong>{user?.username || 'Unknown'}</strong>
                  {user?.id ? ` (${user.id})` : ''}
                </p>
                {hasExistingGroqKey && (
                  <div className="existing-key">
                    Current key: <code>{maskedGroqKey}</code>
                  </div>
                )}
                <input
                  id="groq-api-key"
                  aria-describedby="groq-key-help"
                  type="password"
                  value={groqApiKey}
                  disabled={!settingsLoaded || isSaving || pending}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder={hasExistingGroqKey ? 'Enter new key to replace' : 'gsk_...'}
                  autoComplete="off"
                />
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '20px 0' }} />

              <div className="form-group">
                <div className="api-vault-header">
                  <h3>Key Vault</h3>
                  {!showAddKey && (
                    <button
                      className="btn-secondary"
                      onClick={() => setShowAddKey(true)}
                      disabled={vaultLoading || vaultSaving || isSaving || pending}
                    >
                      + Add Key
                    </button>
                  )}
                </div>
                <p className="form-help">Store API keys for safe reference. Keys are stored on the server and can be copied to clipboard.</p>
                <p className="form-help">To enable Tavily web search for V4 sessions on this Unix server, add a key named <code>terminal-v4:web:tavily</code>. Each search requires your approval.</p>
                {vaultLoading && <p role="status">Loading vault…</p>}
                {vaultError && <div className="form-error"><p role="alert">{vaultError}</p><button type="button" className="btn-secondary" onClick={loadVaultKeys} disabled={vaultLoading}>Retry loading vault</button></div>}

                {showAddKey && (
                  <div className="api-vault-editor">
                    <label htmlFor="vault-key-name">Key name</label>
                    <input
                      id="vault-key-name"
                      type="text"
                      placeholder="Key name (e.g. Anthropic)"
                      value={newKeyName}
                      disabled={vaultSaving || pending}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      autoComplete="off"
                    />
                    <label htmlFor="vault-key-value">Key value</label>
                    <input
                      id="vault-key-value"
                      type="password"
                      placeholder="Key value"
                      value={newKeyValue}
                      disabled={vaultSaving || pending}
                      onChange={(e) => setNewKeyValue(e.target.value)}
                      autoComplete="off"
                    />
                    <div className="api-vault-actions">
                      <button
                        className="btn-secondary"
                        onClick={() => { setShowAddKey(false); setNewKeyName(''); setNewKeyValue(''); }}
                        disabled={vaultSaving || pending}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleAddVaultKey}
                        disabled={vaultSaving || isSaving || pending || !newKeyName.trim() || !newKeyValue}
                      >
                        {vaultSaving ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  </div>
                )}

                {!vaultLoading && !vaultError && vaultKeys.length === 0 && !showAddKey && (
                  <p className="form-help">No keys stored yet.</p>
                )}

                {vaultKeys.map((k) => (
                  <div
                    key={k.id}
                    className="api-vault-entry"
                  >
                    <div className="api-vault-copy">
                      <strong>{k.keyName}</strong>
                      <code style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>{k.keyValue}</code>
                    </div>
                    <div className="api-vault-actions">
                      <button
                        className="btn-secondary"
                        onClick={() => handleCopyVaultKey(k.id)}
                        disabled={vaultSaving || pending}
                      >
                        {copiedId === k.id ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleDeleteVaultKey(k.id, k.keyName)}
                        disabled={vaultSaving || isSaving || pending}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-subtle)', margin: '20px 0' }} />

              <PasskeyManager />

              {error && <div role="alert" className="form-error">{error}</div>}
              {success && <div role="status" className="form-success">{success}</div>}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={isSaving}>
            Close
          </button>
          {hasExistingGroqKey && (
            <button
              className="btn-danger"
              onClick={handleClearGroq}
              disabled={isSaving || vaultSaving || pending || !settingsLoaded}
            >
              Remove Groq Key
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={isSaving || vaultSaving || pending || !settingsLoaded || !groqApiKey.trim()}
          >
            {isSaving ? 'Saving...' : 'Save Key'}
          </button>
        </div>
      </div>
    </div>
  );
}
