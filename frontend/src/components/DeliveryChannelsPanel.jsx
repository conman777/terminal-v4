import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { DELIVERY_CHANNELS, validateDeliveryEndpoint } from '../utils/deliveryChannels';
import './DeliveryChannelsPanel.css';

const BASE = '/api/workspace/delivery-channels';
const EMPTY_DRAFT = { url: '', secret: '' };

async function failure(response, fallback) {
  try { return (await response.json())?.error || fallback; } catch { return fallback; }
}

export function DeliveryChannelsPanel({ onUnavailable, onDirtyChange }) {
  const prefix = useId();
  const [configured, setConfigured] = useState({});
  const [drafts, setDrafts] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(null);
  const [state, setState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await apiFetch(BASE, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 404) { setState('unavailable'); onUnavailable?.(); return; }
        if (!response.ok) throw new Error('failed');
        const data = await response.json();
        setConfigured(Object.fromEntries(DELIVERY_CHANNELS.map(({ id }) => [id, Boolean(data?.[id]?.configured)])));
        setState('ready');
      } catch {
        if (controller.signal.aborted) return;
        setLoadError('Unable to load delivery channels');
        setState('ready');
      }
    })();
    return () => { mounted.current = false; controller.abort(); };
  }, []);

  const dirty = Object.values(drafts).some(draft => draft?.url || draft?.secret);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const draftOf = id => drafts[id] || EMPTY_DRAFT;
  const edit = (id, key, value) => {
    setDrafts(current => ({ ...current, [id]: { ...EMPTY_DRAFT, ...current[id], [key]: value } }));
    setErrors(current => ({ ...current, [id]: '' }));
  };

  async function save(channel) {
    if (busy) return;
    const draft = draftOf(channel.id);
    const problem = validateDeliveryEndpoint(channel.id, draft.url, draft.secret);
    if (problem) { setErrors(current => ({ ...current, [channel.id]: problem })); return; }
    const body = { url: draft.url.trim() };
    if (channel.id === 'webhook') body.secret = draft.secret.trim();
    setBusy(channel.id);
    try {
      const response = await apiFetch(`${BASE}/${channel.id}`, { method: 'PUT', body });
      if (!mounted.current) return;
      if (!response.ok) throw new Error(await failure(response, `Unable to save ${channel.label}`));
      setDrafts(current => ({ ...current, [channel.id]: EMPTY_DRAFT }));
      setConfigured(current => ({ ...current, [channel.id]: true }));
      setErrors(current => ({ ...current, [channel.id]: '' }));
    } catch (error) {
      if (mounted.current) setErrors(current => ({ ...current, [channel.id]: error?.message || `Unable to save ${channel.label}` }));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(channel) {
    if (busy) return;
    setBusy(channel.id);
    try {
      const response = await apiFetch(`${BASE}/${channel.id}`, { method: 'DELETE' });
      if (!mounted.current) return;
      if (!response.ok && response.status !== 204) throw new Error(await failure(response, `Unable to remove ${channel.label}`));
      setConfigured(current => ({ ...current, [channel.id]: false }));
      setErrors(current => ({ ...current, [channel.id]: '' }));
    } catch (error) {
      if (mounted.current) setErrors(current => ({ ...current, [channel.id]: error?.message || `Unable to remove ${channel.label}` }));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  if (state === 'unavailable') return null;
  return (
    <section className="delivery-channels" aria-label="Delivery channels">
      <h3>Delivery channels</h3>
      <p className="delivery-channels-intro">Send scheduled task results to Slack, Discord or a signed webhook. Saved addresses and secrets are write-only and never shown again.</p>
      {state === 'loading' && <p role="status">Loading delivery channels…</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {state === 'ready' && !loadError && DELIVERY_CHANNELS.map(channel => {
        const draft = draftOf(channel.id);
        const isConfigured = Boolean(configured[channel.id]);
        const error = errors[channel.id];
        const urlId = `${prefix}-${channel.id}-url`;
        const secretId = `${prefix}-${channel.id}-secret`;
        const errorId = `${prefix}-${channel.id}-error`;
        return (
          <fieldset key={channel.id} className="delivery-channel" disabled={busy !== null}>
            <legend className="delivery-channel-legend"><h4>{channel.label}</h4></legend>
            <span className="delivery-channel-state" data-testid={`delivery-state-${channel.id}`}>{isConfigured ? 'Configured' : 'Not configured'}</span>
            <label htmlFor={urlId}>{channel.urlLabel}</label>
            <input id={urlId} type="password" autoComplete="off" spellCheck={false} placeholder={isConfigured ? 'Enter a new URL to replace' : channel.placeholder} value={draft.url} onChange={event => edit(channel.id, 'url', event.target.value)} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? errorId : undefined} />
            {channel.secretLabel && <>
              <label htmlFor={secretId}>{channel.secretLabel}</label>
              <input id={secretId} type="password" autoComplete="off" spellCheck={false} placeholder="16 to 256 characters" value={draft.secret} onChange={event => edit(channel.id, 'secret', event.target.value)} />
            </>}
            {error && <small id={errorId} className="delivery-channel-error" role="alert">{error}</small>}
            <div className="delivery-channel-actions">
              <button type="button" className="delivery-channel-save" onClick={() => save(channel)} aria-label={`Save ${channel.label}`}>{busy === channel.id ? 'Saving…' : isConfigured ? 'Replace' : 'Save'}</button>
              {isConfigured && <button type="button" onClick={() => remove(channel)} aria-label={`Remove ${channel.label}`}>Remove</button>}
            </div>
          </fieldset>
        );
      })}
    </section>
  );
}
