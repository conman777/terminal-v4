import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { useEffect, useLayoutEffect, useState, useRef, useId, useSyncExternalStore } from 'react';
import './AccountAccess.css';
import './ProviderAuthModal.css';
import { apiDelete, apiGet, apiPost, apiPut } from '../utils/api';
import { PreviewIcon } from './preview/PreviewIcon';
import { isStructuredSessionId } from '../utils/structuredSessions';

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

export function ProviderAuthModal({ isOpen, onClose, sessionId = null, focusProviderId = null }) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const writing = useRef(false);
  const [pending, setPending] = useState(false);
  return isOpen ? <OpenProviderAuthModal key={`${environment?.id || 'home'}:${sessionId || ''}:${focusProviderId || ''}`} onClose={onClose} sessionId={sessionId} focusProviderId={focusProviderId} remoteEnvironment={environment} writing={writing} pending={pending} onWritingChange={setPending} /> : null;
}

function OpenProviderAuthModal({ onClose, sessionId, focusProviderId, remoteEnvironment, writing, pending, onWritingChange }) {
  const dialog = useRef(null);
  const mounted = useRef(false);
  const inheritedWrite = useRef(pending);
  const copyTimer = useRef(null);
  const statusRequest = useRef(null);
  const terminalSessionId = sessionId && !isStructuredSessionId(sessionId) ? sessionId : null;
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const element = dialog.current;
    const coderTrigger = element.closest('.desktop-status-bar')?.querySelector('.status-ai-selector');
    element.showModal();
    element.focus();
    return () => {
      if (element.open) element.close();
      const returnTarget = opener?.isConnected && opener !== document.body ? opener : coderTrigger;
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!pending && inheritedWrite.current) { inheritedWrite.current = false; void load(); }
  }, [pending]);
  function keyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const fields = dialog.current?.querySelectorAll(':is(button, input, a[href]):not(:disabled)');
    if (!fields?.length) return;
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  }
  const [providers, setProviders] = useState([]);
  const [values, setValues] = useState({});
  const [settingValues, setSettingValues] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(null);
  const [copied, setCopied] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet('/api/agent/auth', { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setProviders(data.providers || []);
    } catch (loadError) {
      if (mounted.current && !controller.signal.aborted) setError(loadError?.message || 'Unable to load provider authentication status');
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; statusRequest.current?.abort(); clearTimeout(copyTimer.current); };
  }, []);

  const focusedProvider = useRef(false);
  useEffect(() => {
    if (!focusProviderId || focusedProvider.current || loading || !providers.length) return;
    const card = [...dialog.current.querySelectorAll('[data-provider-id]')].find(node => node.dataset.providerId === focusProviderId);
    const target = card?.querySelector('input:not(:disabled)');
    if (!target) return;
    focusedProvider.current = true;
    target.focus();
    target.scrollIntoView?.({ block: 'nearest' });
  }, [focusProviderId, loading, providers]);

  const settingValue = (provider, key) => settingValues[provider.id]?.[key] ?? provider.configuredSettings?.[key] ?? '';
  const missingSettings = provider => (provider.settings || []).some(field => field.required && !String(settingValue(provider, field.key)).trim());
  const settingsPayload = provider => Object.fromEntries((provider.settings || []).map(field => [field.key, String(settingValue(provider, field.key)).trim()]).filter(([, value]) => value));

  const save = async provider => {
    if (remoteEnvironment || writing.current) return;
    const value = values[provider.id]?.trim();
    if (!value || missingSettings(provider)) return;
    writing.current = true;
    onWritingChange(true);
    setSaving(provider.id);
    setError(null);
    setNotice(null);
    try {
      await apiPut(`/api/agent/auth/${provider.id}/api-key`, provider.settings?.length ? { apiKey: value, settings: settingsPayload(provider) } : { apiKey: value });
      if (!mounted.current) return;
      setValues(current => ({ ...current, [provider.id]: '' }));
      setNotice(`${provider.label} API key saved securely.`);
      await load();
    } catch (saveError) {
      if (mounted.current) setError(saveError?.message || `Unable to save ${provider.label} credentials`);
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setSaving(null);
    }
  };

  const remove = async provider => {
    if (remoteEnvironment || writing.current) return;
    writing.current = true;
    onWritingChange(true);
    setSaving(provider.id);
    setError(null);
    setNotice(null);
    try {
      await apiDelete(`/api/agent/auth/${provider.id}/api-key`);
      if (!mounted.current) return;
      setNotice(`${provider.label} API key removed.`);
      await load();
    } catch (removeError) {
      if (mounted.current) setError(removeError?.message || `Unable to remove ${provider.label} credentials`);
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setSaving(null);
    }
  };

  const copyCommand = async provider => {
    try {
      await navigator.clipboard.writeText(provider.command);
      if (!mounted.current) return;
      setCopied(provider.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1800);
    } catch {
      if (mounted.current) setError('Clipboard access was unavailable.');
    }
  };

  const runOAuth = async provider => {
    if (writing.current) return;
    if (!provider.command || !terminalSessionId) {
      await copyCommand(provider);
      return;
    }
    writing.current = true;
    onWritingChange(true);
    setSaving(provider.id);
    setError(null);
    setNotice(null);
    try {
      await apiPost(`/api/terminal/${terminalSessionId}/input`, { command: `${provider.command}\n` });
      if (!mounted.current) return;
      const setupKind = provider.methods?.includes('oauth') ? 'OAuth login' : 'provider setup';
      setNotice(`${provider.label} ${setupKind} started in the current terminal.`);
    } catch (runError) {
      const setupKind = provider.methods?.includes('oauth') ? 'OAuth login' : 'provider setup';
      if (mounted.current) setError(runError?.message || `Unable to start ${provider.label} ${setupKind}`);
    } finally {
      writing.current = false;
      onWritingChange(false);
      if (mounted.current) setSaving(null);
    }
  };

  return (
    <dialog
      className="modal-overlay tv4-provider-auth-overlay"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      ref={dialog}
      tabIndex={-1}
      onKeyDown={keyDown}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="modal-content account-access-modal tv4-provider-auth-modal" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <h2 id={titleId}>Provider authentication</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><PreviewIcon name="close" /></button>
        </div>
        <div className="modal-body">
          <p id={descriptionId} className="tv4-provider-auth-subtitle">API keys stay encrypted on the Terminal v4 server; OAuth sessions remain managed by the provider&apos;s native login.</p>
          {remoteEnvironment && <p role="note">Configure API keys on {remoteEnvironment.label || remoteEnvironment.url} directly. This connection grants runtime access.</p>}
          {loading && <div className="loading" role="status">Checking provider status…</div>}
          {error && <div className="tv4-provider-auth-error" role="alert">{error}</div>}
          {notice && <div className="tv4-provider-auth-notice" role="status">{notice}</div>}
          {pending && saving === null && <p role="status">An earlier provider update is still pending. Wait before making another change.</p>}
          {!loading && !error && providers.length === 0 && <p role="status">No providers are available.</p>}
          {!loading && (
            <div className="tv4-provider-auth-list">
              {providers.map(provider => (
                <section className="tv4-provider-auth-card" key={provider.id} data-provider-id={provider.id}>
                  <div className="tv4-provider-auth-card-header">
                    <strong>{provider.label}</strong>
                    <span className={`tv4-provider-auth-status tv4-provider-auth-status-${provider.status}`}>{statusLabel(provider)}</span>
                  </div>
                  {hasNativeSetup(provider) && provider.command && (
                    <div className="tv4-provider-auth-oauth">
                      <span className="tv4-provider-auth-method-label">{setupLabel(provider)}</span>
                      {provider.help && <small>{provider.help}</small>}
                      <code>{provider.command}</code>
                      <button type="button" className="btn-secondary" onClick={() => runOAuth(provider)} disabled={saving !== null || pending}>{saving === provider.id ? 'Starting…' : terminalSessionId ? 'Run in current terminal' : copied === provider.id ? 'Copied' : 'Copy login command'}</button>
                      {terminalSessionId && <button type="button" className="btn-secondary" onClick={() => copyCommand(provider)}>{copied === provider.id ? 'Copied' : 'Copy login command'}</button>}
                      <small>Run the command in a Terminal v4 terminal, then use Refresh provider status to check the connection.</small>
                    </div>
                  )}
                  {provider.methods?.includes('api-key') && provider.settings?.length > 0 && (
                    <div className="tv4-provider-auth-settings">
                      {provider.help && <small>{provider.help}</small>}
                      {provider.settings.map(field => (
                        <input
                          key={field.key}
                          type="text"
                          disabled={Boolean(remoteEnvironment) || saving !== null || pending}
                          value={settingValue(provider, field.key)}
                          onChange={event => setSettingValues(current => ({ ...current, [provider.id]: { ...current[provider.id], [field.key]: event.target.value } }))}
                          placeholder={field.placeholder || field.label}
                          autoComplete="off"
                          spellCheck={false}
                          aria-label={`${provider.label} ${field.label}${field.required ? ' (required)' : ''}`}
                        />
                      ))}
                    </div>
                  )}
                  {provider.methods?.includes('api-key') && (
                    <div className="tv4-provider-auth-key-row">
                      <input
                        type="password"
                        disabled={Boolean(remoteEnvironment) || saving !== null || pending}
                        value={values[provider.id] || ''}
                        onChange={event => setValues(current => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder={provider.masked || 'Paste API key'}
                        autoComplete="off"
                        aria-label={`${provider.label} API key`}
                      />
                      <button type="button" className="btn-primary" disabled={Boolean(remoteEnvironment) || !values[provider.id]?.trim() || missingSettings(provider) || saving !== null || pending} onClick={() => save(provider)}>{saving === provider.id ? 'Saving…' : provider.configured ? 'Replace' : 'Save'}</button>
                      {provider.configured && <button type="button" className="btn-secondary" disabled={Boolean(remoteEnvironment) || saving !== null || pending} onClick={() => remove(provider)}>Remove</button>}
                    </div>
                  )}
                  {provider.models && <div className="tv4-provider-auth-model-count">{provider.models} models available</div>}
                </section>
              ))}
            </div>
          )}
          <button type="button" className="btn-secondary" disabled={loading || saving !== null} onClick={load}>Refresh provider status</button>
        </div>
      </div>
    </dialog>
  );
}
