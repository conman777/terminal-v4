import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiDelete, apiPatch } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import PasskeyManager from './PasskeyManager';

export default function ApiSettingsModal({ isOpen, onClose }) {
  const { user } = useAuth();
  const [groqApiKey, setGroqApiKey] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [hasExistingGroqKey, setHasExistingGroqKey] = useState(false);
  const [hasExistingOpenAIKey, setHasExistingOpenAIKey] = useState(false);
  const [maskedGroqKey, setMaskedGroqKey] = useState('');
  const [maskedOpenAIKey, setMaskedOpenAIKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Vault state
  const [vaultKeys, setVaultKeys] = useState([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [vaultSaving, setVaultSaving] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
      loadVaultKeys();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiGet('/api/settings');
      setHasExistingGroqKey(data.hasGroqApiKey);
      setHasExistingOpenAIKey(data.hasOpenAIApiKey);
      setMaskedGroqKey(data.groqApiKey || '');
      setMaskedOpenAIKey(data.openaiApiKey || '');
      setGroqApiKey('');
      setOpenaiApiKey('');
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  const loadVaultKeys = async () => {
    try {
      const data = await apiGet('/api/vault');
      setVaultKeys(data.keys || []);
    } catch {
      // silently fail - vault section just shows empty
    }
  };

  const handleAddVaultKey = async () => {
    if (!newKeyName.trim() || !newKeyValue) return;
    setVaultSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPost('/api/vault', { name: newKeyName.trim(), value: newKeyValue });
      setNewKeyName('');
      setNewKeyValue('');
      setShowAddKey(false);
      setSuccess('Key added to vault');
      await loadVaultKeys();
    } catch (err) {
      setError(err.message || 'Failed to add key');
    } finally {
      setVaultSaving(false);
    }
  };

  const handleCopyVaultKey = async (id) => {
    try {
      const data = await apiGet(`/api/vault/${id}/reveal`);
      await navigator.clipboard.writeText(data.value);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError('Failed to copy key');
    }
  };

  const handleDeleteVaultKey = async (id, name) => {
    if (!confirm(`Delete key "${name}"?`)) return;
    try {
      await apiDelete(`/api/vault/${id}`);
      setSuccess(`Key "${name}" deleted`);
      await loadVaultKeys();
    } catch {
      setError('Failed to delete key');
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = {};
      if (groqApiKey.trim()) {
        payload.groqApiKey = groqApiKey;
      }
      if (openaiApiKey.trim()) {
        payload.openaiApiKey = openaiApiKey;
      }
      if (Object.keys(payload).length === 0) {
        setError('Enter at least one API key to save');
        return;
      }

      await apiPatch('/api/settings', payload);
      setSuccess('API key settings saved successfully');
      setGroqApiKey('');
      setOpenaiApiKey('');
      await loadSettings();
    } catch (err) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearGroq = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch('/api/settings', { groqApiKey: null });
      setSuccess('Groq API key removed');
      setGroqApiKey('');
      await loadSettings();
    } catch (err) {
      setError(err.message || 'Failed to remove API key');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearOpenAI = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch('/api/settings', { openaiApiKey: null });
      setSuccess('OpenAI API key removed');
      setOpenaiApiKey('');
      await loadSettings();
    } catch (err) {
      setError(err.message || 'Failed to remove API key');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content api-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>API Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {isLoading ? (
            <div className="loading">Loading settings...</div>
          ) : (
            <>
              <div className="form-group">
                <label htmlFor="groq-api-key">Groq API Key</label>
                <p className="form-help">
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
                  type="password"
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder={hasExistingGroqKey ? 'Enter new key to replace' : 'gsk_...'}
                  autoComplete="off"
                />
              </div>

              <div className="form-group">
                <label htmlFor="openai-api-key">OpenAI API Key</label>
                <p className="form-help">
                  Used for OpenAI search and image generation routes. Get your key from{' '}
                  <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
                    platform.openai.com
                  </a>
                </p>
                {hasExistingOpenAIKey && (
                  <div className="existing-key">
                    Current key: <code>{maskedOpenAIKey}</code>
                  </div>
                )}
                <input
                  id="openai-api-key"
                  type="password"
                  value={openaiApiKey}
                  onChange={(e) => setOpenaiApiKey(e.target.value)}
                  placeholder={hasExistingOpenAIKey ? 'Enter new key to replace' : 'sk-...'}
                  autoComplete="off"
                />
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-color, #333)', margin: '16px 0' }} />

              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <label style={{ margin: 0 }}>Key Vault</label>
                  {!showAddKey && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: '12px', padding: '4px 10px' }}
                      onClick={() => setShowAddKey(true)}
                    >
                      + Add Key
                    </button>
                  )}
                </div>
                <p className="form-help">Store API keys for safe reference. Keys are stored on the server and can be copied to clipboard.</p>

                {showAddKey && (
                  <div style={{ background: 'var(--bg-secondary, #1a1a1a)', padding: '12px', borderRadius: '6px', marginBottom: '8px' }}>
                    <input
                      type="text"
                      placeholder="Key name (e.g. Anthropic)"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      style={{ marginBottom: '8px', width: '100%' }}
                      autoComplete="off"
                    />
                    <input
                      type="password"
                      placeholder="Key value"
                      value={newKeyValue}
                      onChange={(e) => setNewKeyValue(e.target.value)}
                      style={{ marginBottom: '8px', width: '100%' }}
                      autoComplete="off"
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="btn-primary"
                        style={{ fontSize: '12px', padding: '4px 10px' }}
                        onClick={handleAddVaultKey}
                        disabled={vaultSaving || !newKeyName.trim() || !newKeyValue}
                      >
                        {vaultSaving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '12px', padding: '4px 10px' }}
                        onClick={() => { setShowAddKey(false); setNewKeyName(''); setNewKeyValue(''); }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {vaultKeys.length === 0 && !showAddKey && (
                  <p className="form-help" style={{ fontStyle: 'italic' }}>No keys stored yet.</p>
                )}

                {vaultKeys.map((k) => (
                  <div
                    key={k.id}
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                      <strong style={{ whiteSpace: 'nowrap' }}>{k.name}</strong>
                      <code style={{ color: 'var(--text-secondary, #888)', fontSize: '12px' }}>{k.maskedValue}</code>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '11px', padding: '2px 8px' }}
                        onClick={() => handleCopyVaultKey(k.id)}
                      >
                        {copiedId === k.id ? 'Copied!' : 'Copy'}
                      </button>
                      <button
                        className="btn-danger"
                        style={{ fontSize: '11px', padding: '2px 8px' }}
                        onClick={() => handleDeleteVaultKey(k.id, k.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid var(--border-color, #333)', margin: '16px 0' }} />

              <PasskeyManager />

              {error && <div className="form-error">{error}</div>}
              {success && <div className="form-success">{success}</div>}
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
              disabled={isSaving}
            >
              Remove Groq Key
            </button>
          )}
          {hasExistingOpenAIKey && (
            <button
              className="btn-danger"
              onClick={handleClearOpenAI}
              disabled={isSaving}
            >
              Remove OpenAI Key
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={isSaving || (!groqApiKey.trim() && !openaiApiKey.trim())}
          >
            {isSaving ? 'Saving...' : 'Save Key'}
          </button>
        </div>
      </div>
    </div>
  );
}
