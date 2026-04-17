import React, { useState, useEffect } from 'react';

/**
 * BrowserSettings Component
 *
 * Allows users to configure browser session settings like timeouts, limits, and quality.
 * Styled via canonical tokens from styles.css — no Tailwind runtime in this project.
 */
export function BrowserSettings() {
  const [settings, setSettings] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [formValues, setFormValues] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings/browser');
      if (response.ok) {
        const data = await response.json();
        setSettings(data.settings);
        setDefaults(data.defaults);
        setFormValues(data.settings);
      }
    } catch (err) {
      console.error('Error fetching settings:', err);
      showMessage('error', 'Failed to load settings');
    }
  };

  const saveSettings = async () => {
    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/browser', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValues)
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data.settings);
        showMessage('success', 'Settings saved successfully');
      } else {
        const error = await response.json();
        showMessage('error', error.message || 'Failed to save settings');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
      showMessage('error', 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const resetToDefaults = async () => {
    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/browser', {
        method: 'DELETE'
      });

      if (response.ok) {
        const data = await response.json();
        setSettings(data.settings);
        setFormValues(data.settings);
        showMessage('success', 'Settings reset to defaults');
      } else {
        showMessage('error', 'Failed to reset settings');
      }
    } catch (err) {
      console.error('Error resetting settings:', err);
      showMessage('error', 'Failed to reset settings');
    } finally {
      setIsSaving(false);
    }
  };

  const showMessage = (type, text) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  };

  const handleChange = (field, value) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
  };

  const formatMs = (ms) => {
    if (ms >= 60 * 60 * 1000) {
      return `${ms / (60 * 60 * 1000)} hour(s)`;
    }
    if (ms >= 60 * 1000) {
      return `${ms / (60 * 1000)} minute(s)`;
    }
    return `${ms / 1000} second(s)`;
  };

  if (!settings || !defaults) {
    return <div className="browser-settings-loading">Loading...</div>;
  }

  return (
    <div className="browser-settings-root">
      <h2 className="browser-settings-title">Browser Settings</h2>

      {message && (
        <div className={`browser-settings-banner browser-settings-banner-${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="browser-settings-sections">
        <section className="browser-settings-card">
          <h3 className="browser-settings-card-title">Session Timeouts</h3>
          <div className="browser-settings-fields">
            <div className="browser-settings-field">
              <label className="browser-settings-label">
                Idle Timeout
                <span className="browser-settings-label-hint">(1 min – 1 hour)</span>
              </label>
              <input
                type="number"
                value={formValues.idleTimeoutMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('idleTimeoutMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="1"
                max="60"
                className="browser-settings-input"
              />
              <div className="browser-settings-meta">
                Current: {formatMs(formValues.idleTimeoutMs)} · Default:{' '}
                {formatMs(defaults.idleTimeoutMs)}
              </div>
            </div>

            <div className="browser-settings-field">
              <label className="browser-settings-label">
                Max Lifetime
                <span className="browser-settings-label-hint">(10 min – 4 hours)</span>
              </label>
              <input
                type="number"
                value={formValues.maxLifetimeMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('maxLifetimeMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="10"
                max="240"
                className="browser-settings-input"
              />
              <div className="browser-settings-meta">
                Current: {formatMs(formValues.maxLifetimeMs)} · Default:{' '}
                {formatMs(defaults.maxLifetimeMs)}
              </div>
            </div>
          </div>
        </section>

        <section className="browser-settings-card">
          <h3 className="browser-settings-card-title">Session Limits</h3>
          <div className="browser-settings-field">
            <label className="browser-settings-label">
              Max Concurrent Sessions
              <span className="browser-settings-label-hint">(1–20)</span>
            </label>
            <input
              type="number"
              value={formValues.maxSessions}
              onChange={(e) => handleChange('maxSessions', parseInt(e.target.value))}
              min="1"
              max="20"
              className="browser-settings-input"
            />
            <div className="browser-settings-meta">
              Default: {defaults.maxSessions}
            </div>
          </div>
        </section>

        <section className="browser-settings-card">
          <h3 className="browser-settings-card-title">Cleanup</h3>
          <div className="browser-settings-fields">
            <div className="browser-settings-field">
              <label className="browser-settings-label">
                Cleanup Interval
                <span className="browser-settings-label-hint">(30s – 10 min)</span>
              </label>
              <input
                type="number"
                value={formValues.cleanupIntervalMs / 1000}
                onChange={(e) =>
                  handleChange('cleanupIntervalMs', parseInt(e.target.value) * 1000)
                }
                min="30"
                max="600"
                className="browser-settings-input"
              />
              <div className="browser-settings-meta">
                Current: {formatMs(formValues.cleanupIntervalMs)} · Default:{' '}
                {formatMs(defaults.cleanupIntervalMs)}
              </div>
            </div>

            <div className="browser-settings-field">
              <label className="browser-settings-label">
                Log Retention
                <span className="browser-settings-label-hint">(10 min – 24 hours)</span>
              </label>
              <input
                type="number"
                value={formValues.logRetentionMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('logRetentionMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="10"
                max="1440"
                className="browser-settings-input"
              />
              <div className="browser-settings-meta">
                Current: {formatMs(formValues.logRetentionMs)} · Default:{' '}
                {formatMs(defaults.logRetentionMs)}
              </div>
            </div>
          </div>
        </section>

        <section className="browser-settings-card">
          <h3 className="browser-settings-card-title">Screenshots</h3>
          <div className="browser-settings-fields">
            <div className="browser-settings-field">
              <label className="browser-settings-label">Format</label>
              <select
                value={formValues.screenshotFormat}
                onChange={(e) => handleChange('screenshotFormat', e.target.value)}
                className="browser-settings-input"
              >
                <option value="png">PNG (lossless)</option>
                <option value="jpeg">JPEG (lossy, smaller)</option>
              </select>
              <div className="browser-settings-meta">
                Default: {defaults.screenshotFormat.toUpperCase()}
              </div>
            </div>

            <div className="browser-settings-field">
              <label className="browser-settings-label">
                JPEG Quality
                <span className="browser-settings-label-hint">(1–100)</span>
              </label>
              <input
                type="number"
                value={formValues.screenshotQuality}
                onChange={(e) =>
                  handleChange('screenshotQuality', parseInt(e.target.value))
                }
                min="1"
                max="100"
                disabled={formValues.screenshotFormat !== 'jpeg'}
                className="browser-settings-input"
              />
              <div className="browser-settings-meta">
                Default: {defaults.screenshotQuality}
                {formValues.screenshotFormat !== 'jpeg' && ' · only applies to JPEG'}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="browser-settings-actions">
        <button
          type="button"
          onClick={resetToDefaults}
          disabled={isSaving}
          className="btn-secondary"
        >
          Reset to Defaults
        </button>
        <button
          type="button"
          onClick={saveSettings}
          disabled={isSaving}
          className="btn-primary"
        >
          {isSaving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>

      <style>{`
        .browser-settings-root {
          padding: 24px;
          max-width: 720px;
          margin: 0 auto;
          color: var(--text-primary);
          font-family: var(--font-ui);
        }

        .browser-settings-title {
          margin: 0 0 20px;
          font-size: 22px;
          font-weight: 600;
          letter-spacing: -0.015em;
          color: var(--text-primary);
        }

        .browser-settings-loading {
          padding: 24px;
          color: var(--text-muted);
          font-family: var(--font-ui);
        }

        .browser-settings-banner {
          margin-bottom: 20px;
          padding: 12px 14px;
          border-radius: var(--radius-md);
          font-size: 13px;
          font-weight: 500;
          border: 1px solid transparent;
        }

        .browser-settings-banner-success {
          color: var(--success);
          background: color-mix(in srgb, var(--success) 12%, transparent);
          border-color: color-mix(in srgb, var(--success) 30%, transparent);
        }

        .browser-settings-banner-error {
          color: var(--error);
          background: color-mix(in srgb, var(--error) 12%, transparent);
          border-color: color-mix(in srgb, var(--error) 30%, transparent);
        }

        .browser-settings-sections {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .browser-settings-card {
          background: var(--bg-elevated);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-lg);
          padding: 18px 20px;
        }

        .browser-settings-card-title {
          margin: 0 0 14px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.01em;
          color: var(--text-primary);
        }

        .browser-settings-fields {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .browser-settings-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .browser-settings-label {
          display: flex;
          align-items: baseline;
          gap: 8px;
          font-size: 13px;
          font-weight: 500;
          color: var(--text-secondary);
        }

        .browser-settings-label-hint {
          font-size: 11px;
          font-weight: 400;
          color: var(--text-muted);
        }

        .browser-settings-input {
          width: 100%;
          padding: 8px 12px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          color: var(--text-primary);
          font-family: inherit;
          font-size: 13px;
          outline: none;
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
        }

        .browser-settings-input:focus {
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px var(--accent-primary-dim);
        }

        .browser-settings-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .browser-settings-meta {
          font-size: 11px;
          color: var(--text-muted);
        }

        .browser-settings-actions {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-top: 24px;
        }
      `}</style>
    </div>
  );
}
