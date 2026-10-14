import { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '../utils/api';

function statusLabel(provider) {
  if (provider.status === 'ready') {
    if (provider.methods?.includes('oauth')) return provider.configured ? 'OAuth connected' : 'OAuth available';
    if (provider.methods?.includes('cli')) return provider.configured ? 'Native setup ready' : 'Native setup required';
    return provider.configured ? 'Connected' : 'Available';
  }
  if (provider.status === 'auth-required') return 'Authentication required';
  if (provider.status === 'not-installed') return 'Not installed';
  return 'Unavailable';
}

function hasNativeSetup(provider) {
  return provider.methods?.includes('oauth') || provider.methods?.includes('cli');
}

function setupLabel(provider) {
  return provider.methods?.includes('oauth') ? 'OAuth login' : 'Native/cloud setup';
}

export function ProviderAuthModal({ isOpen, onClose, sessionId = null }) {
  const [providers, setProviders] = useState([]);
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(null);
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet('/api/agent/auth');
      setProviders(data.providers || []);
    } catch (loadError) {
      setError(loadError?.message || 'Unable to load provider authentication status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen]);

  const save = async provider => {
    const value = values[provider.id]?.trim();
    if (!value) return;
    setSaving(provider.id);
    setError(null);
    setNotice(null);
    try {
      await apiPut(`/api/agent/auth/${provider.id}/api-key`, { apiKey: value });
      setValues(current => ({ ...current, [provider.id]: '' }));
      setNotice(`${provider.label} API key saved securely.`);
      await load();
    } catch (saveError) {
      setError(saveError?.message || `Unable to save ${provider.label} credentials`);
    } finally {
      setSaving(null);
    }
  };

  const remove = async provider => {
    setSaving(provider.id);
    setError(null);
    try {
      await apiDelete(`/api/agent/auth/${provider.id}/api-key`);
      setNotice(`${provider.label} API key removed.`);
      await load();
    } catch (removeError) {
      setError(removeError?.message || `Unable to remove ${provider.label} credentials`);
    } finally {
      setSaving(null);
    }
  };

  const copyCommand = async provider => {
    try {
      await navigator.clipboard.writeText(provider.command);
      setCopied(provider.id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Clipboard access was unavailable.');
    }
  };

  const runOAuth = async provider => {
    if (!provider.command || !sessionId) {
      await copyCommand(provider);
      return;
    }
    setSaving(provider.id);
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/terminal/${sessionId}/input`, { command: `${provider.command}\n` });
      const setupKind = provider.methods?.includes('oauth') ? 'OAuth login' : 'provider setup';
      setNotice(`${provider.label} ${setupKind} started in the current terminal.`);
    } catch (runError) {
      const setupKind = provider.methods?.includes('oauth') ? 'OAuth login' : 'provider setup';
      setError(runError?.message || `Unable to start ${provider.label} ${setupKind}`);
    } finally {
      setSaving(null);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content tv4-provider-auth-modal" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Provider authentication</h2>
            <p className="tv4-provider-auth-subtitle">API keys stay encrypted on the Terminal v4 server; OAuth sessions remain managed by the provider&apos;s native login.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {loading && <div className="loading">Checking provider status…</div>}
          {error && <div className="tv4-provider-auth-error">{error}</div>}
          {notice && <div className="tv4-provider-auth-notice">{notice}</div>}
          {!loading && (
            <div className="tv4-provider-auth-list">
              {providers.map(provider => (
                <section className="tv4-provider-auth-card" key={provider.id}>
                  <div className="tv4-provider-auth-card-header">
                    <strong>{provider.label}</strong>
                    <span className={`tv4-provider-auth-status tv4-provider-auth-status-${provider.status}`}>{statusLabel(provider)}</span>
                  </div>
                  {hasNativeSetup(provider) && provider.command && (
                    <div className="tv4-provider-auth-oauth">
                      <span className="tv4-provider-auth-method-label">{setupLabel(provider)}</span>
                      {provider.help && <small>{provider.help}</small>}
                      <code>{provider.command}</code>
                      <button type="button" className="btn-secondary" onClick={() => runOAuth(provider)} disabled={saving === provider.id}>{saving === provider.id ? 'Starting…' : sessionId ? 'Run in current terminal' : 'Copy login command'}</button>
                      {sessionId && <button type="button" className="btn-secondary" onClick={() => copyCommand(provider)}>{copied === provider.id ? 'Copied' : 'Copy login command'}</button>}
                      <small>Run the command in a Terminal v4 terminal, then reopen this panel to refresh the connection status.</small>
                    </div>
                  )}
                  {provider.methods?.includes('api-key') && (
                    <div className="tv4-provider-auth-key-row">
                      <input
                        type="password"
                        value={values[provider.id] || ''}
                        onChange={event => setValues(current => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder={provider.masked || 'Paste API key'}
                        autoComplete="off"
                        aria-label={`${provider.label} API key`}
                      />
                      <button type="button" className="btn-primary" disabled={!values[provider.id]?.trim() || saving === provider.id} onClick={() => save(provider)}>{saving === provider.id ? 'Saving…' : provider.configured ? 'Replace' : 'Save'}</button>
                      {provider.configured && <button type="button" className="btn-secondary" disabled={saving === provider.id} onClick={() => remove(provider)}>Remove</button>}
                    </div>
                  )}
                  {provider.models && <div className="tv4-provider-auth-model-count">{provider.models} models available</div>}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
