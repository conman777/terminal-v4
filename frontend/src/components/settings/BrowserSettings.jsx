import React, { useState, useEffect } from 'react';

/**
 * BrowserSettings Component
 *
 * Allows users to configure browser session settings like timeouts, limits, and quality
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
    if (!confirm('Reset all browser settings to defaults?')) return;

    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/browser/reset', { method: 'POST' });
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
    return <div className="p-4">Loading...</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Browser Settings</h2>

      {message && (
        <div
          className={`mb-6 p-4 rounded ${
            message.type === 'success'
              ? 'bg-green-100 text-green-800 border border-green-200'
              : 'bg-red-100 text-red-800 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="space-y-6">
        {/* Session Timeouts */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Session Timeouts</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Idle Timeout
                <span className="text-gray-500 font-normal ml-2">
                  (1 min - 1 hour)
                </span>
              </label>
              <input
                type="number"
                value={formValues.idleTimeoutMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('idleTimeoutMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="1"
                max="60"
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              <div className="text-xs text-gray-500 mt-1">
                Current: {formatMs(formValues.idleTimeoutMs)} | Default:{' '}
                {formatMs(defaults.idleTimeoutMs)}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Max Lifetime
                <span className="text-gray-500 font-normal ml-2">
                  (10 min - 4 hours)
                </span>
              </label>
              <input
                type="number"
                value={formValues.maxLifetimeMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('maxLifetimeMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="10"
                max="240"
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              <div className="text-xs text-gray-500 mt-1">
                Current: {formatMs(formValues.maxLifetimeMs)} | Default:{' '}
                {formatMs(defaults.maxLifetimeMs)}
              </div>
            </div>
          </div>
        </div>

        {/* Session Limits */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Session Limits</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Max Concurrent Sessions
              <span className="text-gray-500 font-normal ml-2">(1-20)</span>
            </label>
            <input
              type="number"
              value={formValues.maxSessions}
              onChange={(e) => handleChange('maxSessions', parseInt(e.target.value))}
              min="1"
              max="20"
              className="w-full px-3 py-2 border border-gray-300 rounded"
            />
            <div className="text-xs text-gray-500 mt-1">
              Default: {defaults.maxSessions}
            </div>
          </div>
        </div>

        {/* Cleanup Settings */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Cleanup Settings</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Cleanup Interval
                <span className="text-gray-500 font-normal ml-2">
                  (30s - 10 min)
                </span>
              </label>
              <input
                type="number"
                value={formValues.cleanupIntervalMs / 1000}
                onChange={(e) =>
                  handleChange('cleanupIntervalMs', parseInt(e.target.value) * 1000)
                }
                min="30"
                max="600"
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              <div className="text-xs text-gray-500 mt-1">
                Current: {formatMs(formValues.cleanupIntervalMs)} | Default:{' '}
                {formatMs(defaults.cleanupIntervalMs)}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Log Retention
                <span className="text-gray-500 font-normal ml-2">
                  (10 min - 24 hours)
                </span>
              </label>
              <input
                type="number"
                value={formValues.logRetentionMs / (60 * 1000)}
                onChange={(e) =>
                  handleChange('logRetentionMs', parseInt(e.target.value) * 60 * 1000)
                }
                min="10"
                max="1440"
                className="w-full px-3 py-2 border border-gray-300 rounded"
              />
              <div className="text-xs text-gray-500 mt-1">
                Current: {formatMs(formValues.logRetentionMs)} | Default:{' '}
                {formatMs(defaults.logRetentionMs)}
              </div>
            </div>
          </div>
        </div>

        {/* Screenshot Settings */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Screenshot Settings</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Format
              </label>
              <select
                value={formValues.screenshotFormat}
                onChange={(e) => handleChange('screenshotFormat', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded"
              >
                <option value="png">PNG (lossless)</option>
                <option value="jpeg">JPEG (lossy, smaller)</option>
              </select>
              <div className="text-xs text-gray-500 mt-1">
                Default: {defaults.screenshotFormat.toUpperCase()}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                JPEG Quality
                <span className="text-gray-500 font-normal ml-2">(1-100)</span>
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
                className="w-full px-3 py-2 border border-gray-300 rounded disabled:bg-gray-100"
              />
              <div className="text-xs text-gray-500 mt-1">
                Default: {defaults.screenshotQuality}
                {formValues.screenshotFormat !== 'jpeg' && ' (only applies to JPEG)'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-between mt-8">
        <button
          onClick={resetToDefaults}
          disabled={isSaving}
          className="px-4 py-2 bg-gray-600 text-white rounded font-medium hover:bg-gray-700 disabled:opacity-50"
        >
          Reset to Defaults
        </button>
        <button
          onClick={saveSettings}
          disabled={isSaving}
          className="px-6 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
}
