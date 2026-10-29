import { useEffect, useId, useRef, useState } from 'react';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import {
  newConnectionId, loadConnections, mutateConnection, connectionOperation,
  beginConnectionDiscovery, loadConnectionDiscovery, cancelConnectionDiscovery,
  connectionDraft, connectionBody, canKeepConnectionCredential, discoveryPending,
} from '../utils/providerConnections';
import './ProviderConnectionsPanel.css';

export function ProviderConnectionsPanel({ onDirtyChange }) {
  const snapshot = () => ({ auth: captureAuthScope(), environment: getActiveEnvironment(), environmentSignal: getEnvironmentSignal(), epoch: 0 });
  const [context, setContext] = useState(snapshot);
  useEffect(() => { if (context.environment) onDirtyChange?.(false); }, [context.environment, onDirtyChange]);
  useEffect(() => {
    const environmentChanged = () => setContext(previous => ({ ...snapshot(), epoch: previous.epoch + 1 }));
    const authChanged = () => setContext(previous => {
      const next = captureAuthScope();
      if (next.generation === previous.auth.generation && next.home === previous.auth.home && next.userId === previous.auth.userId) return previous;
      return { ...snapshot(), epoch: previous.epoch + 1 };
    });
    const auth = subscribeAuth(authChanged);
    const environment = subscribeEnvironment(environmentChanged);
    if (!isAuthScopeCurrent(context.auth)) authChanged();
    if (context.environmentSignal !== getEnvironmentSignal()) environmentChanged();
    return () => { auth(); environment(); };
  }, []);
  if (context.environment) return <section className="provider-connections" aria-label="Provider connections">
    <h3>Provider connections</h3>
    <p>Connection profiles are available on Home. Select Home to manage them.</p>
  </section>;
  return <ConnectionWorkspace key={`${context.auth.generation}:${context.auth.home}:${context.epoch}`} onDirtyChange={onDirtyChange} />;
}

function ConnectionWorkspace({ onDirtyChange }) {
  const prefix = useId();
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(() => connectionDraft(null));
  const [draftBase, setDraftBase] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [needsReconciliation, setNeedsReconciliation] = useState(false);
  const [job, setJob] = useState(null);
  const [discoveryAttempt, setDiscoveryAttempt] = useState(null);
  const [pollError, setPollError] = useState('');
  const lifetime = useRef(null);
  const saved = profiles.find(profile => profile.profileId === selected) || null;
  const current = token => token === lifetime.current && !token.signal.aborted
    && isAuthScopeCurrent(token.auth) && token.environmentSignal === getEnvironmentSignal() && !getActiveEnvironment();
  const options = token => ({ signal: token.signal });
  const field = name => `${prefix}-${name}`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(connectionDraft(draftBase));
  useEffect(() => { onDirtyChange?.(dirty || Boolean(pending)); }, [dirty, pending, onDirtyChange]);
  const draftConflict = !!draftBase && draftBase.revision !== saved?.revision;
  const keepsKey = canKeepConnectionCredential(draft, draftBase);
  const locked = loading || busy || !!pending;

  async function reload(token = lifetime.current) {
    if (!token || !current(token)) return;
    setLoading(true); setError('');
    try {
      const value = await loadConnections(options(token));
      if (!current(token)) return;
      setProfiles(value);
      const next = value.find(profile => profile.profileId === selected) || null;
      setSelected(next?.profileId || null); setDraftBase(next); setDraft(connectionDraft(next));
      setNeedsReconciliation(false); setMessage('Saved connections reloaded.');
    } catch (failure) { if (current(token)) setError(failure.message); }
    finally { if (current(token)) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    const environmentSignal = getEnvironmentSignal();
    const token = { signal: AbortSignal.any([controller.signal, environmentSignal]), environmentSignal, auth: captureAuthScope() };
    lifetime.current = token;
    void reload(token);
    return () => { controller.abort(); lifetime.current = null; };
  }, []);

  function choose(profileId) {
    const next = profiles.find(profile => profile.profileId === profileId) || null;
    setSelected(next?.profileId || null); setDraftBase(next); setDraft(connectionDraft(next));
    setError(''); setMessage(''); setReceipt(null);
  }
  function update(name, value) { setDraft(previous => ({ ...previous, [name]: value })); setError(''); setMessage(''); }
  async function reconcileProfiles(token, profileId, updateDraft) {
    setNeedsReconciliation(true);
    try {
      // Receipts retain the historical profile, including cleanup-pending activation.
      const value = await loadConnections(options(token));
      if (!current(token)) return;
      setProfiles(value);
      if (updateDraft) {
        const next = value.find(profile => profile.profileId === profileId) || null;
        setSelected(next?.profileId || null); setDraftBase(next); setDraft(connectionDraft(next));
      }
      setNeedsReconciliation(false);
    } catch (failure) { if (current(token)) setError(failure.message); }
  }
  async function retryReconciliation() {
    const token = lifetime.current;
    if (!token || !current(token) || busy) return;
    setBusy(true); setError('');
    try { await reconcileProfiles(token, selected, !dirty && !draftConflict); }
    finally { if (current(token)) setBusy(false); }
  }
  async function submitMutation(mutation) {
    const token = lifetime.current;
    if (!token || !current(token) || busy) return;
    setBusy(true); setPending(mutation); setError(''); setMessage('');
    try {
      const value = await mutateConnection(mutation, options(token));
      if (!current(token)) return;
      setPending(null); setReceipt(value);
      setProfiles(previous => [...previous.filter(profile => profile.profileId !== mutation.profileId), ...(value.profile ? [value.profile] : [])]);
      setSelected(value.profile?.profileId || null); setDraftBase(value.profile); setDraft(connectionDraft(value.profile));
      setMessage(value.deleted ? 'Connection deleted.' : value.cleanupConfirmed ? 'Connection saved.' : 'Connection saved. Previous work is still stopping.');
      await reconcileProfiles(token, mutation.profileId, true);
    } catch (failure) {
      if (!current(token)) return;
      // A missing/invalid response or a server failure can follow a committed
      // mutation. Keep its exact operation ID/body, including a pending key,
      // only in component memory until its outcome can be checked by retry.
      if (failure.status >= 400 && failure.status < 500 && failure.status !== 429) setPending(null);
      setError(failure.message);
    } finally { if (current(token)) setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    if (locked || draftConflict) return;
    try {
      const body = connectionBody(draft, draftBase, newConnectionId());
      void submitMutation({ method: 'PUT', profileId: draftBase?.profileId || newConnectionId(), body });
    } catch (failure) { setError(failure.message); }
  }
  async function checkReceipt() {
    const token = lifetime.current;
    if (!token || !current(token) || !receipt || busy) return;
    setBusy(true); setError('');
    try {
      const value = await connectionOperation(receipt.profileId, receipt.operationId, options(token));
      if (!current(token)) return;
      setReceipt(value);
      setMessage(value.cleanupConfirmed ? 'Previous connection work has stopped.' : 'Previous connection work is still stopping.');
      await reconcileProfiles(token, selected, !dirty && !draftConflict);
    } catch (failure) { if (current(token)) setError(failure.message); }
    finally { if (current(token)) setBusy(false); }
  }
  async function startDiscovery(attempt = null) {
    const token = lifetime.current;
    if (!token || !current(token) || busy) return;
    const next = attempt || { profileId: saved.profileId, requestId: newConnectionId() };
    setBusy(true); setDiscoveryAttempt(next); setPollError(''); setError('');
    try {
      const value = await beginConnectionDiscovery(next.profileId, next.requestId, options(token));
      if (!current(token)) return;
      setJob(value); setDiscoveryAttempt(null);
    } catch (failure) { if (current(token)) setError(failure.message); }
    finally { if (current(token)) setBusy(false); }
  }
  async function refreshJob(cancel = false) {
    const token = lifetime.current;
    if (!token || !current(token) || !job || busy) return;
    setBusy(true); setPollError('');
    try {
      const value = cancel
        ? await cancelConnectionDiscovery(job.profileId, job.requestId, options(token))
        : await loadConnectionDiscovery(job.requestId, options(token));
      if (current(token)) setJob(value);
    } catch (failure) { if (current(token)) setPollError(failure.message); }
    finally { if (current(token)) setBusy(false); }
  }
  useEffect(() => {
    const token = lifetime.current;
    if (!token || !current(token) || !discoveryPending(job) || job.error?.code === 'server_restarted' || pollError || busy) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const value = await loadConnectionDiscovery(job.requestId, options(token));
        if (!cancelled && current(token)) setJob(value);
      } catch (failure) { if (!cancelled && current(token)) setPollError(failure.message); }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job, pollError, busy]);

  return <section className="provider-connections" aria-label="Provider connections">
    <h3>Provider connections</h3>
    <p>Save an Actual or LM Studio connection on Home, discover models, and select it for a V4 conversation. A successful inventory does not verify that a model can answer.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {loading && <p role="status">Loading connections…</p>}
    {draftConflict && <p role="alert">This connection changed or was deleted elsewhere. Your unsaved changes have been kept. Reload saved settings before saving. <button type="button" disabled={locked} onClick={() => reload()}>Reload saved settings</button></p>}
    <div className="provider-connection-actions">
      <button type="button" disabled={locked || dirty} onClick={() => reload()}>Reload connections</button>
      <label htmlFor={field('selected')}>Saved connection</label>
      <select id={field('selected')} disabled={locked || dirty || draftConflict} value={selected || ''} onChange={event => choose(event.target.value)}>
        <option value="">New connection</option>
        {selected && !saved && <option value={selected}>Selected connection no longer exists</option>}
        {profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.provider === 'actual' ? 'Actual' : 'LM Studio'} · {profile.baseUrl}</option>)}
      </select>
      {dirty && !pending && !draftConflict && <button type="button" disabled={busy} onClick={() => { setDraft(connectionDraft(draftBase)); setError(''); }}>Reset unsaved changes</button>}
    </div>
    <form aria-label="Connection settings" onSubmit={save} noValidate>
      <fieldset disabled={locked}>
        <label htmlFor={field('kind')}>Provider and mode</label>
        <select id={field('kind')} value={draft.kind} onChange={event => { const kind = event.target.value; setDraft(previous => ({ ...previous, kind, secret: '', baseUrl: kind === 'actual:relay' ? 'https://api.actual.inc/v1' : previous.kind === 'actual:relay' ? kind === 'lmstudio:local' ? 'http://127.0.0.1:1234/v1' : 'http://127.0.0.1:8080/v1' : previous.baseUrl })); setError(''); setMessage(''); }}>
          <option value="actual:local">Actual local</option><option value="actual:relay">Actual relay</option><option value="lmstudio:local">LM Studio local</option>
        </select>
        <label htmlFor={field('endpoint')}>API endpoint</label>
        <input id={field('endpoint')} value={draft.baseUrl} onChange={event => update('baseUrl', event.target.value)} maxLength={4096} spellCheck="false" autoComplete="off" />
        <small>Include /v1. Local connections use a literal loopback IP on the Home server.</small>
        {draft.kind === 'lmstudio:local' && <><label htmlFor={field('auth')}>Authentication</label>
          <select id={field('auth')} value={draft.authMode} onChange={event => update('authMode', event.target.value)}><option value="none">None</option><option value="bearer">Bearer key</option></select></>}
        {(draft.kind === 'actual:relay' || (draft.kind === 'lmstudio:local' && draft.authMode === 'bearer')) && <>
          <label htmlFor={field('secret')}>{keepsKey ? 'Replacement bearer key (optional)' : 'Bearer key'}</label>
          <input id={field('secret')} type="password" value={draft.secret} onChange={event => update('secret', event.target.value)} maxLength={16384} autoComplete="new-password" spellCheck="false" />
          <small>{keepsKey ? 'A key is saved for this endpoint. Leave this blank to keep it.' : 'The key is encrypted on the Home server after saving.'}</small>
        </>}
        {draft.kind === 'actual:relay' && <><label htmlFor={field('cluster')}>Cluster ID (optional)</label>
          <input id={field('cluster')} value={draft.clusterId} onChange={event => update('clusterId', event.target.value)} maxLength={200} spellCheck="false" /></>}
        <button type="submit" disabled={draftConflict}>Save connection</button>
        {draftBase && <button type="button" disabled={draftConflict} onClick={() => submitMutation({ method: 'DELETE', profileId: draftBase.profileId, body: { operationId: newConnectionId(), expectedRevision: draftBase.revision } })}>Delete connection</button>}
      </fieldset>
    </form>
    {pending && <p role="status">The save outcome has not been confirmed. <button type="button" disabled={busy} onClick={() => submitMutation(pending)}>Retry same {pending.method === 'DELETE' ? 'deletion' : 'save'}</button></p>}
    {receipt && !receipt.cleanupConfirmed && <button type="button" disabled={busy} onClick={checkReceipt}>Check previous work</button>}
    {needsReconciliation && <p role="status">Current connection settings need to be refreshed. <button type="button" disabled={busy} onClick={retryReconciliation}>Retry connection refresh</button></p>}
    {saved && <p>Connection: {needsReconciliation ? 'current state unconfirmed' : saved.activation === 'ready' ? 'ready' : 'waiting for previous work to stop'}. <button type="button" disabled={locked || dirty || draftConflict || needsReconciliation || saved.activation !== 'ready' || discoveryPending(job) || !!discoveryAttempt} onClick={() => startDiscovery()}>Discover models</button></p>}
    {discoveryAttempt && <button type="button" disabled={busy} onClick={() => startDiscovery(discoveryAttempt)}>Retry same discovery</button>}
    {job && <section className="provider-discovery" aria-label="Latest discovery">
      <h4>Latest discovery</h4>
      {saved && job.profileId !== saved.profileId && <p className="provider-discovery-origin">This discovery belongs to a previously selected connection.</p>}
      {saved && job.profileId === saved.profileId && job.revision && job.revision !== saved.revision && <p className="provider-discovery-origin">This discovery used earlier connection settings.</p>}
      <p role="status">Status: {job.status}{job.cleanupPending ? ' · cleanup unconfirmed' : ''}{job.cancelConfirmed ? ' · cancellation confirmed' : ''}</p>
      {job.error && <p>{job.error.code === 'server_restarted' ? 'The server restarted during discovery. Cleanup remains unconfirmed.' : 'The inventory could not be published. Refresh the saved connection before trying again.'}</p>}
      {pollError && <p role="alert">{pollError}</p>}
      <button type="button" disabled={busy} onClick={() => refreshJob()}>Refresh discovery</button>
      {discoveryPending(job) && <button type="button" disabled={busy} onClick={() => refreshJob(true)}>Cancel discovery</button>}
      {Array.isArray(job.models) && (job.models.length ? <ul>{job.models.map(model => <li key={model.id}>
        <strong>{model.label.length > 200 ? `${model.label.slice(0, 200)}…` : model.label}</strong> <code>{model.id}</code><br />
        <small>Loaded: {model.loaded == null ? 'unknown' : model.loaded ? 'yes' : 'no'} · Images: {model.imageInput == null ? 'unknown' : model.imageInput ? 'yes' : 'no'} · Context: {model.contextWindow == null ? 'unknown' : model.contextWindow.toLocaleString()}</small>
      </li>)}</ul> : <p>The endpoint returned no models.</p>)}
    </section>}
  </section>;
}
