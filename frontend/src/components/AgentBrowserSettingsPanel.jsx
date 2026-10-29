import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './AgentBrowserSettingsPanel.css';

const API_PATH = '/api/agent/browser';
const bytes = value => new TextEncoder().encode(value).length;

function draftFromConfig(config) {
  return { enabled: config.enabled, executable: config.executable || '', headless: config.headless, timeoutSeconds: String(config.timeoutSeconds), origins: config.allowedOrigins.join('\n') };
}

function configFromDraft(draft) {
  const executable = draft.executable.trim();
  if (executable && (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(executable) || /[\p{Cc}]/u.test(executable) || bytes(executable) > 4096)) {
    throw new Error('Enter an absolute path to an installed browser executable, without control characters. Leave it blank for host discovery.');
  }
  const timeoutSeconds = Number(draft.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 60) {
    throw new Error('Action timeout must be a whole number between 1 and 60 seconds.');
  }
  const allowedOrigins = [];
  for (const line of draft.origins.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let url;
    try { url = new URL(text); } catch { throw new Error('Enter one HTTP or HTTPS origin per line, for example https://example.test.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || url.hostname.includes('*') || text.includes('?') || text.includes('#') || /[\p{Cc}]/u.test(text) || bytes(text) > 4096) {
      throw new Error('Allowed origins must use HTTP or HTTPS without credentials, paths, queries, fragments, wildcards, or control characters.');
    }
    if (!allowedOrigins.includes(url.origin)) allowedOrigins.push(url.origin);
    if (allowedOrigins.length > 64) throw new Error('Allow at most 64 distinct origins.');
  }
  return { enabled: draft.enabled, executable: executable || null, headless: draft.headless, timeoutSeconds, allowedOrigins };
}

function normalizeConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['enabled', 'executable', 'headless', 'timeoutSeconds', 'allowedOrigins'].includes(key))
    || typeof payload.enabled !== 'boolean' || typeof payload.headless !== 'boolean'
    || (payload.executable != null && typeof payload.executable !== 'string') || !Number.isInteger(payload.timeoutSeconds)
    || !Array.isArray(payload.allowedOrigins) || payload.allowedOrigins.some(origin => typeof origin !== 'string')) {
    throw new Error('The browser configuration response is invalid. Reload settings to check its state.');
  }
  try { return configFromDraft(draftFromConfig(payload)); }
  catch { throw new Error('The browser configuration response is invalid. Reload settings to check its state.'); }
}

async function readConfig(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || 'Unable to load or save browser settings.');
    if (response.status === 503 && payload?.settingsSaved === true && payload?.cleanupConfirmed === false) error.savedConfig = normalizeConfig(payload.config);
    throw error;
  }
  return normalizeConfig(payload);
}

export function AgentBrowserSettingsPanel({ onDirtyChange }) {
  const prefix = useId();
  const [config, setConfig] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [cleanupPending, setCleanupPending] = useState(false);
  const request = useRef(null);
  const mounted = useRef(false);
  const field = name => prefix + '-' + name;
  const dirty = config && draft && JSON.stringify(draft) !== JSON.stringify(draftFromConfig(config));
  useEffect(() => { onDirtyChange?.(Boolean(dirty)); }, [dirty, onDirtyChange]);
  const busy = loading || saving;
  const update = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setMessage(''); };

  async function load(event) {
    event?.currentTarget?.closest('dialog, [role="dialog"]')?.querySelector('.modal-close')?.focus({ preventScroll: true });
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError(''); setMessage('');
    try {
      const saved = await readConfig(await apiFetch(API_PATH, { home: true, signal: controller.signal }));
      if (!mounted.current || controller.signal.aborted) return;
      setConfig(saved); setDraft(draftFromConfig(saved));
    } catch (loadError) {
      if (mounted.current && !controller.signal.aborted) setError(loadError.message || 'Unable to load browser settings.');
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setError(''); setMessage('');
    let next;
    try { next = configFromDraft(draft); }
    catch (validationError) { setError(validationError.message); return; }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    try {
      const saved = await readConfig(await apiFetch(API_PATH, { home: true, method: 'PUT', body: next, signal: controller.signal }));
      if (!mounted.current || controller.signal.aborted) return;
      setConfig(saved); setDraft(draftFromConfig(saved)); setCleanupPending(false); setMessage('Browser settings saved. No browser was started.');
    } catch (saveError) {
      if (mounted.current && !controller.signal.aborted) {
        if (saveError.savedConfig) { setConfig(saveError.savedConfig); setDraft(draftFromConfig(saveError.savedConfig)); setCleanupPending(true); }
        setError(saveError.message || 'Unable to save browser settings.');
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setSaving(false);
    }
  }

  return <div className="agent-browser-settings">
    <div className="session-settings-section-heading">
      <span className="session-settings-section-kicker">Agent tools</span>
      <h3>Agent browser</h3>
      <p>Configure the shared browser on Home. Each browser action requires explicit approval.</p>
    </div>
    {error && <p role="alert" className="agent-browser-settings-error">{error}</p>}
    {message && <p role="status" className="agent-browser-settings-message">{message}</p>}
    {loading ? <p role="status">Loading browser settings…</p> : !draft ? <button type="button" className="btn-secondary" onClick={load}>Retry loading browser settings</button> : <form aria-label="Agent browser configuration" onSubmit={save} noValidate>
      <fieldset disabled={busy}>
        <div className="agent-browser-settings-actions">
          <p className="agent-browser-settings-note">Saving changed settings stops active integrations and holds queued work.</p>
          <button type="submit" className="btn-primary">{saving ? 'Saving browser settings…' : 'Save browser settings'}</button>
          {dirty ? <button type="button" className="btn-secondary" aria-label="Reset unsaved changes" onClick={() => { setDraft(draftFromConfig(config)); setError(''); setMessage('Unsaved browser changes reset.'); }}>Reset</button>
            : <button type="button" className="btn-secondary" aria-label="Reload browser settings" onClick={load}>Reload</button>}
          <span role="status" className="agent-browser-settings-note">{cleanupPending ? (dirty ? 'Cleanup is unconfirmed and you have unsaved changes. Save to retry cleanup with these settings.' : 'Browser settings are saved. Cleanup is unconfirmed. Retry Save browser settings.') : dirty ? 'Unsaved changes' : draft.enabled ? 'Browser tools enabled; actions still require approval.' : 'Browser tools disabled.'}</span>
        </div>
        <label className="agent-browser-check"><input type="checkbox" checked={draft.enabled} onChange={event => update('enabled', event.target.checked)} />Enable browser tools for V4 agents</label>
        <div className="agent-browser-field"><label htmlFor={field('origins')}>Allowed origins</label><textarea id={field('origins')} rows={4} aria-describedby={field('origins-help')} value={draft.origins} onChange={event => update('origins', event.target.value)} spellCheck="false" placeholder={'https://example.test\nhttp://127.0.0.1:3000'} /></div>
        <p id={field('origins-help')} className="agent-browser-settings-note">One exact HTTP or HTTPS origin per line, including a port when needed. No paths or wildcards. An empty list allows no sites.</p>
        <details className="agent-browser-disclosure">
          <summary>Advanced browser options</summary>
          <div className="agent-browser-advanced-fields">
        <label htmlFor={field('executable')}>Browser executable path<input id={field('executable')} value={draft.executable} onChange={event => update('executable', event.target.value)} maxLength={4096} autoComplete="off" spellCheck="false" placeholder="Optional absolute path" /></label>
        <p className="agent-browser-settings-note">Leave blank to use Terminal v4's bundled Chromium. An executable override applies only to standalone V4 agent runs; the shared workspace browser always uses its bundled engine.</p>
        <div className="agent-browser-settings-grid">
          <label htmlFor={field('timeout')}>Action timeout (seconds)<input id={field('timeout')} type="number" min={1} max={60} step={1} value={draft.timeoutSeconds} onChange={event => update('timeoutSeconds', event.target.value)} /></label>
          <label className="agent-browser-check"><input type="checkbox" checked={draft.headless} onChange={event => update('headless', event.target.checked)} />Run browser without a visible window</label>
        </div>
          <p className="agent-browser-settings-note">The visible-window option applies to standalone V4 runs. The shared workspace browser always uses headless frames.</p>
          </div>
        </details>
        <details className="agent-browser-disclosure">
          <summary>Browser access and save behavior</summary>
          <p className="agent-browser-settings-note">Terminal v4 uses bundled Chromium and a separate disposable browser profile. An allowed origin permits requests to that site's paths after approval. Email access requires separate consent and the exact account address.</p>
          <p className="agent-browser-settings-note">Saving never starts a browser or visits a site. If cleanup is unconfirmed, the settings remain saved; retry Save browser settings.</p>
          <p className="agent-browser-settings-note">Allow up to 64 distinct origins without credentials, queries, or fragments. Host casing, default ports, and trailing slashes are normalized.</p>
        </details>
      </fieldset>
    </form>}
  </div>;
}
