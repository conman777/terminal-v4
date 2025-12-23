import { useState, useEffect } from 'react';
import { apiGet, apiPatch } from '../utils/api';

export default function ApiSettingsModal({ isOpen, onClose }) {
  const [groqApiKey, setGroqApiKey] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await apiGet('/api/settings');
      setHasExistingKey(data.hasGroqApiKey);
      setMaskedKey(data.groqApiKey || '');
      setGroqApiKey('');
    } catch (err) {
      setError('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch('/api/settings', { groqApiKey: groqApiKey || null });
      setSuccess('API key saved successfully');
      setGroqApiKey('');
      await loadSettings();
    } catch (err) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiPatch('/api/settings', { groqApiKey: null });
      setSuccess('API key removed');
      setGroqApiKey('');
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
                {hasExistingKey && (
                  <div className="existing-key">
                    Current key: <code>{maskedKey}</code>
                  </div>
                )}
                <input
                  id="groq-api-key"
                  type="password"
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder={hasExistingKey ? 'Enter new key to replace' : 'gsk_...'}
                  autoComplete="off"
                />
              </div>

              {error && <div className="form-error">{error}</div>}
              {success && <div className="form-success">{success}</div>}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={isSaving}>
            Close
          </button>
          {hasExistingKey && (
            <button
              className="btn-danger"
              onClick={handleClear}
              disabled={isSaving}
            >
              Remove Key
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={isSaving || !groqApiKey.trim()}
          >
            {isSaving ? 'Saving...' : 'Save Key'}
          </button>
        </div>
      </div>
    </div>
  );
}
