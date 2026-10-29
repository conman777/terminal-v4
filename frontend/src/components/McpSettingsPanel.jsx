import { createUuid } from '../utils/createUuid';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import './McpSettingsPanel.css';
import { McpAppView } from './McpAppView';
import { mcpAppResourceUri } from '../utils/mcpApps';
import { captureMcpProbeScope, getHeldMcpProbe, mcpProbeScopeSnapshot, releaseMcpProbe, retainMcpProbe, scopedMcpProbeFetch, subscribeHeldMcpProbes, subscribeMcpProbeScope } from './mcpProbeScope';

const MAX_SERVERS = 20;
const MAX_SERVER_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const bytes = (value) => new TextEncoder().encode(value).length;
const probePath = (job) => `/api/agent/mcp/${encodeURIComponent(job.server.id)}/probes/${job.id}`;
const checkProbeReceipt = (job, receipt) => {
  if (receipt.probeId !== job.id) throw new Error('The connection test returned an unexpected identifier.');
  if (typeof receipt.cleanupConfirmed !== 'boolean') throw new Error('The connection test did not confirm its cleanup state.');
  if (!['running', 'completed', 'failed', 'cancelled'].includes(receipt.status)) throw new Error('The connection test returned an invalid status.');
  return receipt;
};
const stopProbe = async (job, keepalive = false) => {
  const receipt = checkProbeReceipt(job, await readResponse(await scopedMcpProbeFetch(job.scope, probePath(job), {
    method: 'DELETE', signal: AbortSignal.timeout(15_000), keepalive,
  })));
  if (!receipt.cleanupConfirmed || receipt.status === 'running') throw new Error(receipt.error || 'Connection cleanup is still unconfirmed.');
  job.cleanupConfirmed = true;
  releaseMcpProbe(job.scope, job.id);
  return receipt;
};
const pausePolling = (signal) => new Promise((resolve, reject) => {
  const aborted = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 500);
  if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
});

function redactedServer(server) {
  const transport = server.transport.type === 'stdio'
    ? { type: 'stdio', command: server.transport.command, args: server.transport.args || [] }
    : { type: 'http', url: server.transport.url };
  return { id: server.id, name: server.name, enabled: server.enabled, timeoutSeconds: server.timeoutSeconds, transport };
}

function newDraft(server) {
  return {
    original: server || null,
    id: server?.id || '', name: server?.name || '', enabled: server?.enabled === true,
    timeoutSeconds: server?.timeoutSeconds ?? 30, type: server?.transport.type || 'stdio',
    command: server?.transport.command || '', args: JSON.stringify(server?.transport.args || [], null, 2),
    envMode: server?.transport.type === 'stdio' ? 'keep' : 'replace', envRows: [],
    url: server?.transport.url || '', bearerToken: '', clearBearerToken: false,
  };
}

function draftServer(draft, servers) {
  const id = draft.id.trim();
  const name = draft.name.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Use 1–64 letters, numbers, hyphens, or underscores for the server ID.');
  if (!draft.original && servers.some((server) => server.id === id)) throw new Error('A server with this ID already exists.');
  if (!name || name.length > 80 || /[\p{Cc}]/u.test(name)) throw new Error('Enter a server name using 1–80 printable characters.');
  const timeoutSeconds = Number(draft.timeoutSeconds);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw new Error('Connection timeout must be a whole number between 1 and 120 seconds.');
  let transport;
  if (draft.type === 'stdio') {
    const command = draft.command.trim();
    if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(command) || command.includes('\0') || bytes(command) > 4096) throw new Error('Enter the absolute path to an installed executable.');
    let args;
    try { args = JSON.parse(draft.args); } catch { throw new Error('Arguments must be a JSON array of strings, for example ["--stdio"].'); }
    if (!Array.isArray(args) || args.length > 100 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || bytes(arg) > 4096)) throw new Error('Use at most 100 arguments, each a string of up to 4096 bytes.');
    transport = { type: 'stdio', command, args };
    const stored = draft.original?.transport;
    const targetChanged = stored?.type !== 'stdio' || stored.command !== command || JSON.stringify(stored.args || []) !== JSON.stringify(args);
    if (draft.envMode === 'keep' && targetChanged && stored?.envKeys?.length) throw new Error('Choose Replace or Remove for environment variables before changing the executable or arguments.');
    if (draft.envMode !== 'keep') {
      const env = Object.create(null);
      for (const row of draft.envMode === 'clear' ? [] : draft.envRows) {
        const key = row.name.trim();
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key)) throw new Error('Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.');
        if (Object.hasOwn(env, key)) throw new Error(`Environment variable ${key} is listed more than once.`);
        if (row.value.includes('\0') || bytes(row.value) > 16 * 1024) throw new Error('Environment variable values must contain no null characters and be at most 16 KiB.');
        env[key] = row.value;
      }
      if (Object.keys(env).length > 64) throw new Error('Use at most 64 environment variables.');
      transport.env = env;
    }
  } else {
    const url = draft.url.trim();
    let target;
    try { target = new URL(url); } catch { throw new Error('Enter an HTTPS URL or an HTTP URL using a literal loopback address.'); }
    const octets = target.hostname.split('.');
    const loopback = (octets.length === 4 && octets[0] === '127' && octets.every((part) => /^\d+$/.test(part) && Number(part) <= 255)) || target.hostname === '[::1]';
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP with a literal loopback address such as 127.0.0.1 or [::1].');
    if (target.username || target.password || target.search || target.hash || bytes(url) > 4096) throw new Error('MCP URLs cannot include credentials, a query, or a fragment, and must be at most 4096 bytes.');
    transport = { type: 'http', url };
    const stored = draft.original?.transport;
    if (draft.bearerToken) {
      if (!/^[\x21-\x7e]{1,8192}$/.test(draft.bearerToken)) throw new Error('Bearer tokens must contain 1–8192 visible ASCII characters.');
      transport.bearerToken = draft.bearerToken;
    } else if (draft.clearBearerToken) {
      transport.clearBearerToken = true;
    } else if (stored?.type === 'http' && stored.bearerTokenSet && stored.url !== url) {
      throw new Error('Enter a replacement bearer token or select Remove stored bearer token before changing the URL.');
    }
  }
  return { id, name, enabled: draft.enabled, timeoutSeconds, transport };
}

async function readResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'The MCP request failed. Try again.');
    if (response.status === 503 && data?.settingsSaved === true && data?.cleanupConfirmed === false) {
      if (!Array.isArray(data.config?.servers)) throw new Error('MCP settings were saved, but the saved configuration response is invalid. Reload settings to check its state.');
      error.savedServers = data.config.servers;
    }
    throw error;
  }
  if (!data) throw new Error('The MCP server returned an invalid response.');
  return data;
}

function DiscoveryMetadata({ label, items, kind, onOpenApp, appDisabled }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return <div className="mcp-discovery-metadata">
    <h6>{label} ({items.length})</h6>
    <ul>{items.map((item, index) => <li key={item.uri || item.uriTemplate || item.name || index}>
      <code>{typeof item.name === 'string' ? item.name : `Item ${index + 1}`}</code>
      {typeof item.description === 'string' && <span>{item.description}</span>}
      {kind === 'tool' && mcpAppResourceUri(item) && <button type="button" className="btn-secondary btn-small" disabled={appDisabled} title={appDisabled ? 'Enable this server and finish other actions before opening its app' : undefined} aria-label={`Open app for ${item.name}`} onClick={() => onOpenApp(item)}>Open app</button>}
      {kind === 'resource' && typeof item.uri === 'string' && <code>{item.uri}</code>}
      {kind === 'template' && typeof item.uriTemplate === 'string' && <code>{item.uriTemplate}</code>}
      {kind === 'prompt' && Array.isArray(item.arguments) && <div className="mcp-prompt-arguments">{item.arguments.map((arg, argIndex) => <span key={arg.name || argIndex}>{String(arg.name || 'Argument')}{arg.required ? ' (required)' : ' (optional)'}</span>)}</div>}
    </li>)}</ul>
  </div>;
}

export function McpSettingsPanel({ isActive = true, onDirtyChange }) {
  const key = useSyncExternalStore(subscribeMcpProbeScope, mcpProbeScopeSnapshot);
  const scope = useMemo(captureMcpProbeScope, [key]);
  return <ScopedMcpSettingsPanel key={key} scope={scope} isActive={isActive} onDirtyChange={onDirtyChange} />;
}

function ScopedMcpSettingsPanel({ scope, isActive, onDirtyChange }) {
  const initial = useRef(getHeldMcpProbe(scope));
  const restored = initial.current && !initial.current.invalid ? {
    id: initial.current.probeId, scope, controller: new AbortController(),
    server: { id: initial.current.serverId, name: `MCP server ${initial.current.serverId}`, timeoutSeconds: initial.current.timeoutSeconds },
  } : null;
  const prefix = useId();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(initial.current?.invalid === true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState(null);
  const [removeId, setRemoveId] = useState(null);
  const [probeId, setProbeId] = useState(initial.current?.serverId || null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(Boolean(initial.current));
  const [results, setResults] = useState({});
  const [appTool, setAppTool] = useState(null);
  const request = useRef(null);
  const probe = useRef(restored);
  const mounted = useRef(false);
  const busy = saving || probeId !== null;
  const unavailable = busy || cleanupPending;
  const field = (name) => `${prefix}-${name}`;
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  useEffect(() => { onDirtyChange?.(Boolean(draft)); }, [draft, onDirtyChange]);
  useEffect(() => {
    if (!isActive) { setAppTool(null); if (probe.current) void cancelProbe(); }
  }, [isActive]);

  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoaded(false); setLoading(true); setError('');
    try {
      const data = await readResponse(await apiFetch('/api/agent/mcp', { signal: controller.signal }));
      if (!Array.isArray(data.servers)) throw new Error('The MCP configuration response is invalid.');
      if (mounted.current && !controller.signal.aborted) { setServers(data.servers); setLoaded(true); }
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(err.message || 'Could not load MCP settings.');
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    if (initial.current) setError(initial.current.invalid ? 'Stored MCP cleanup identity is invalid. Retry MCP cleanup before starting another connection.' : 'A previous MCP connection still needs cleanup confirmation. Retry cancellation before starting another connection.');
    const unsubscribe = subscribeHeldMcpProbes(() => {
      if (mounted.current && !getHeldMcpProbe(scope)) {
        if (!probe.current?.cleanupConfirmed) probe.current = null;
        setProbeId(null); setCancelError(false); setCleanupPending(false);
      }
    });
    return () => {
      unsubscribe();
      mounted.current = false; request.current?.abort();
      const job = probe.current;
      if (job) { job.controller.abort(); void stopProbe(job, true).catch(() => {}); }
    };
  }, []);

  const persist = async (next) => {
    if (!loaded || loading) {
      setError('Load MCP settings successfully before saving settings or retrying cleanup.');
      return false;
    }
    if (next.some((server) => bytes(JSON.stringify(server)) > MAX_SERVER_BYTES)) {
      setError('Each MCP server configuration must be at most 64 KiB. Reduce arguments or environment values.');
      return false;
    }
    if (bytes(JSON.stringify({ servers: next })) > MAX_CONFIG_BYTES) {
      setError('The complete MCP configuration must be at most 256 KiB. Reduce arguments or environment values.');
      return false;
    }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true); setError(''); setMessage('');
    try {
      const data = await readResponse(await apiFetch('/api/agent/mcp', { method: 'PUT', body: { servers: next }, signal: controller.signal }));
      if (!Array.isArray(data.servers)) throw new Error('The saved MCP configuration response is invalid. Reload settings to check its state.');
      if (!mounted.current || controller.signal.aborted) return false;
      setServers(data.servers); setResults({}); setAppTool(null); setRemoveId(null); setCleanupPending(false); setMessage('MCP settings saved.');
      if (getHeldMcpProbe(scope)?.invalid) releaseMcpProbe(scope, null);
      return true;
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) {
        if (err.savedServers) {
          setServers(err.savedServers); setResults({}); setAppTool(null); setRemoveId(null); setDraft(null); setCleanupPending(true);
          setError(`MCP settings are saved. Cleanup is unconfirmed: ${err.message}. Retry MCP cleanup before starting another connection.`);
        } else setError(cleanupPending ? `MCP settings are saved. Cleanup is unconfirmed: ${err.message || 'Could not confirm cleanup'}. Retry MCP cleanup.` : err.message || 'Could not save MCP settings.');
      }
      return false;
    } finally {
      if (mounted.current && !controller.signal.aborted) setSaving(false);
    }
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    setError('');
    let server;
    try { server = draftServer(draft, servers); } catch (err) { setError(err.message); return; }
    const next = servers.map((existing) => existing.id === draft.original?.id ? server : redactedServer(existing));
    if (!draft.original) next.push(server);
    if (await persist(next)) setDraft(null);
  };

  const applyReceipt = (job, receipt) => {
    checkProbeReceipt(job, receipt);
    if (!receipt.cleanupConfirmed) {
      setCancelError(true);
      setError(`Connection to ${job.server.name} needs cleanup: ${receipt.error || 'Cleanup is unconfirmed'}. Retry cancellation before starting another connection.`);
      return;
    }
    if (receipt.status === 'completed' && receipt.result) {
      setResults((current) => ({ ...current, [job.server.id]: receipt.result }));
      setMessage(`Connection to ${job.server.name} succeeded.`);
    } else if (receipt.status === 'failed') {
      setError(`Connection to ${job.server.name} failed: ${receipt.error || 'Unknown error'}`);
    } else if (receipt.status === 'cancelled') {
      setMessage('Connection test cancelled.');
    } else {
      throw new Error('The connection test returned an invalid status.');
    }
    job.cleanupConfirmed = true;
    releaseMcpProbe(job.scope, job.id);
  };

  const testConnection = async (server) => {
    const job = { server, scope, id: createUuid(), controller: new AbortController() };
    try { retainMcpProbe(scope, server, job.id); }
    catch (err) { setError(err.message); return; }
    probe.current = job;
    setProbeId(server.id); setError(''); setMessage(''); setCancelError(false);
    setResults((current) => { const next = { ...current }; delete next[server.id]; return next; });
    try {
      const receipt = await readResponse(await scopedMcpProbeFetch(job.scope, `/api/agent/mcp/${encodeURIComponent(server.id)}/probe`, {
        method: 'POST', body: { background: true, probeId: job.id }, signal: job.controller.signal,
      }));
      if (job.controller.signal.aborted || !mounted.current) return;
      checkProbeReceipt(job, receipt);
      if (receipt.status !== 'running') { applyReceipt(job, receipt); return; }
      while (!job.controller.signal.aborted) {
        const current = await readResponse(await scopedMcpProbeFetch(job.scope, probePath(job), { signal: job.controller.signal }));
        if (job.controller.signal.aborted || !mounted.current) return;
        checkProbeReceipt(job, current);
        if (current.status !== 'running') { applyReceipt(job, current); return; }
        await pausePolling(job.controller.signal);
      }
    } catch (err) {
      if (mounted.current && !job.controller.signal.aborted) {
        try { await stopProbe(job); job.cleanupConfirmed = true; }
        catch {
          if (mounted.current && !job.controller.signal.aborted) {
            job.controller.abort(); setCancelError(true);
            setError(`Connection to ${server.name} failed: ${err.message || 'Unknown error'}. Cleanup could not be confirmed. Retry cancellation; the server timeout is ${server.timeoutSeconds} seconds.`);
          }
          return;
        }
        if (mounted.current && !job.controller.signal.aborted) setError(`Connection to ${server.name} failed: ${err.message || 'Unknown error'}`);
      }
    } finally {
      if (mounted.current && probe.current === job && job.cleanupConfirmed && !job.controller.signal.aborted) {
        setProbeId(null); probe.current = null;
      }
    }
  };

  const cancelProbe = async () => {
    const job = probe.current;
    if (!job || cancelling) return;
    job.controller.abort(); setCancelling(true); setError(''); setMessage('');
    try {
      const receipt = await stopProbe(job);
      if (!mounted.current || probe.current !== job) return;
      applyReceipt(job, receipt);
      probe.current = null; setProbeId(null); setCancelError(false);
    } catch (err) {
      if (mounted.current && probe.current === job) {
        setCancelError(true);
        setError(`Could not confirm connection cleanup: ${err.message || 'Unknown error'}. Retry cancellation; the server timeout is ${job.server.timeoutSeconds} seconds.`);
      }
    } finally {
      if (mounted.current) setCancelling(false);
    }
  };

  const beginEdit = (server) => { setDraft(newDraft(server)); setError(''); setMessage(''); setRemoveId(null); };
  const changeEnvRow = (index, key, value) => setDraft((current) => ({ ...current, envRows: current.envRows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row) }));
  const storedKeys = draft?.original?.transport.envKeys || [];
  const storedToken = draft?.original?.transport.bearerTokenSet === true;

  return (
    <div className="mcp-settings">
      <div className="session-settings-section-heading">
        <span className="session-settings-section-kicker">Agent tools</span>
        <h3>MCP servers</h3>
        <p>Connect tools through the Model Context Protocol. Enabling a server lets V4 expose its tools to agents; executing a tool still requires approval.</p>
      </div>
      <p className="mcp-settings-note">Only add servers you trust. A stdio connection starts the configured executable; an HTTP connection contacts the configured URL. Saving changed settings stops this account's active integrations and holds queued work. Saving does not connect. Test connection starts a connection and lists available tools, resources, and prompts without invoking them.</p>
      {error && <div className="mcp-settings-error" role="alert">{error}</div>}
      {message && <p className="mcp-settings-message" role="status">{message}</p>}
      {probeId && !servers.some(server => server.id === probeId) && <div className="mcp-settings-note">
        <p>Connection cleanup for {probeId} needs confirmation.</p>
        <button type="button" className="btn-secondary" disabled={cancelling} onClick={() => void cancelProbe()}>{cancelling ? 'Cancelling…' : 'Retry cancellation'}</button>
      </div>}
      {cleanupPending && <button type="button" className="btn-secondary" disabled={busy || loading || !loaded} onClick={() => void persist(servers.map(redactedServer))}>{saving ? 'Retrying MCP cleanup…' : 'Retry MCP cleanup'}</button>}
      {cleanupPending && (loading || !loaded) && <p className="mcp-settings-note">Load MCP settings successfully before retrying cleanup.</p>}
      {loading ? <p role="status">Loading MCP settings…</p> : !loaded ? <button type="button" className="btn-secondary" onClick={load}>Retry loading MCP settings</button> : <>
        <div className="mcp-settings-toolbar">
          <span>{servers.length} / {MAX_SERVERS} servers</span>
          <button type="button" className="btn-secondary btn-small" disabled={unavailable || Boolean(draft) || servers.length >= MAX_SERVERS} onClick={() => beginEdit(null)}>Add MCP server</button>
          <button type="button" className="btn-secondary btn-small" disabled={unavailable || Boolean(draft)} onClick={load}>Reload</button>
        </div>
        {servers.length === 0 && <p className="mcp-settings-empty">No MCP servers configured.</p>}
        <div className="mcp-server-list">
          {servers.map((server) => <article key={server.id} className="mcp-server-card" aria-label={server.name}>
            <div className="mcp-server-header">
              <div><h4>{server.name}</h4><span className="mcp-server-id">{server.id} · {server.transport.type === 'stdio' ? 'Local stdio' : 'HTTP'} · {server.timeoutSeconds}s timeout</span></div>
              <label className="mcp-check"><input type="checkbox" aria-label={`Enable ${server.name}`} checked={server.enabled} disabled={unavailable || Boolean(draft)} onChange={(event) => void persist(servers.map((item) => ({ ...redactedServer(item), ...(item.id === server.id ? { enabled: event.target.checked } : {}) })))} />Enabled</label>
            </div>
            <code className="mcp-server-target">{server.transport.type === 'stdio' ? server.transport.command : server.transport.url}</code>
            {server.transport.type === 'stdio' && server.transport.envKeys?.length > 0 && <p className="mcp-server-secrets">Stored environment names: {server.transport.envKeys.map((key, index) => <span key={key}>{index > 0 ? ', ' : ''}<code>{key}</code></span>)}. Values are hidden.</p>}
            {server.transport.type === 'http' && <p className="mcp-server-secrets">Bearer token: {server.transport.bearerTokenSet ? 'stored; value hidden' : 'not set'}.</p>}
            <div className="mcp-server-actions">
              <button type="button" className="btn-secondary btn-small" disabled={unavailable || Boolean(draft)} onClick={() => beginEdit(server)}>Edit</button>
              <button type="button" className="btn-secondary btn-small" disabled={unavailable || Boolean(draft)} onClick={() => void testConnection(server)}>Test connection</button>
              <button type="button" className="btn-secondary btn-small" disabled={unavailable || Boolean(draft)} onClick={() => { setRemoveId(server.id); setError(''); }}>Remove</button>
              {probeId === server.id && <button type="button" className="btn-secondary btn-small" disabled={cancelling} onClick={() => void cancelProbe()}>{cancelling ? 'Cancelling…' : cancelError ? 'Retry cancellation' : 'Cancel connection test'}</button>}
            </div>
            {probeId === server.id && <p className="mcp-settings-note">{cancelling ? 'Closing the server connection…' : cancelError ? 'Connection cleanup needs confirmation.' : `Connecting to ${server.name}…`}</p>}
            {removeId === server.id && <div className="mcp-remove-confirm"><p>Remove {server.name} and its stored credentials?</p><button type="button" className="btn-secondary btn-small" disabled={busy} onClick={() => setRemoveId(null)}>Keep server</button><button type="button" className="btn-primary btn-small" disabled={busy} onClick={() => void persist(servers.filter((item) => item.id !== server.id).map(redactedServer))}>Confirm removal</button></div>}
            {results[server.id] && <div className="mcp-probe-result">
              <h5>Connected: {results[server.id].serverInfo?.name || server.name}{results[server.id].serverInfo?.version ? ` ${results[server.id].serverInfo.version}` : ''}</h5>
              <p>Protocol: {results[server.id].protocolVersion || 'negotiated'} · {results[server.id].tools?.length || 0} {results[server.id].tools?.length === 1 ? 'tool' : 'tools'}</p>
              {results[server.id].tools?.length > 0 ? <DiscoveryMetadata label="Tools" items={results[server.id].tools} kind="tool" appDisabled={unavailable || !server.enabled || Boolean(draft) || Boolean(appTool)} onOpenApp={(tool) => setAppTool({ server, tool })} /> : <p>No tools advertised by this server.</p>}
              <DiscoveryMetadata label="Resources" items={results[server.id].resources} kind="resource" />
              <DiscoveryMetadata label="Resource templates" items={results[server.id].resourceTemplates} kind="template" />
              <DiscoveryMetadata label="Prompts" items={results[server.id].prompts} kind="prompt" />
            </div>}
          </article>)}
        </div>
        {appTool && <McpAppView serverId={appTool.server.id} serverName={appTool.server.name} tool={appTool.tool} onClose={() => setAppTool(null)} />}
        {draft && <form className="mcp-editor" aria-label={draft.original ? 'Edit MCP server' : 'Add MCP server'} onSubmit={saveDraft} noValidate>
          <h4>{draft.original ? `Edit ${draft.original.name}` : 'Add MCP server'}</h4>
          <p className="mcp-settings-note">Use Save server to save this form before closing the panel. Stored secret values are never shown.</p>
          <fieldset disabled={saving}>
            <div className="mcp-editor-grid">
              <label htmlFor={field('id')}>Server ID<input id={field('id')} value={draft.id} onChange={(event) => update('id', event.target.value)} disabled={Boolean(draft.original)} maxLength={64} autoComplete="off" spellCheck="false" /></label>
              <label htmlFor={field('name')}>Server name<input id={field('name')} value={draft.name} onChange={(event) => update('name', event.target.value)} maxLength={80} autoComplete="off" /></label>
              <label htmlFor={field('transport')}>Transport<select id={field('transport')} value={draft.type} onChange={(event) => { update('type', event.target.value); update('envMode', draft.original?.transport.type === 'stdio' ? 'keep' : 'replace'); }}><option value="stdio">Local executable (stdio)</option><option value="http">HTTP endpoint</option></select></label>
              <label htmlFor={field('timeout')}>Connection timeout (seconds)<input id={field('timeout')} type="number" min={1} max={120} step={1} value={draft.timeoutSeconds} onChange={(event) => update('timeoutSeconds', event.target.value)} /></label>
            </div>
            <label className="mcp-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} />Enable server for V4 agents</label>
            {draft.type === 'stdio' ? <>
              <label htmlFor={field('command')}>Executable path<input id={field('command')} value={draft.command} onChange={(event) => update('command', event.target.value)} maxLength={4096} autoComplete="off" spellCheck="false" placeholder="/absolute/path/to/server" /></label>
              <div className="mcp-field"><label htmlFor={field('args')}>Arguments (JSON array)</label><textarea id={field('args')} value={draft.args} onChange={(event) => update('args', event.target.value)} maxLength={MAX_SERVER_BYTES} rows={3} spellCheck="false" /></div>
              <p className="mcp-settings-note">Arguments are passed directly without a shell. Use a JSON array to preserve spaces and empty arguments. The executable must already be installed.</p>
              <label htmlFor={field('env-mode')}>Environment variables<select id={field('env-mode')} value={draft.envMode} onChange={(event) => update('envMode', event.target.value)}>
                {draft.original?.transport.type === 'stdio' && <option value="keep">Keep stored variables unchanged</option>}
                <option value="replace">Set replacement variables</option><option value="clear">Remove all variables</option>
              </select></label>
              {storedKeys.length > 0 && <p className="mcp-settings-note">Stored names: {storedKeys.join(', ')}. Existing values are never shown. Replacement removes any stored variable not entered below.</p>}
              {draft.envMode === 'replace' && <div className="mcp-env-editor">
                {draft.envRows.map((row, index) => <div key={row.key} className="mcp-env-row">
                  <label htmlFor={field(`env-name-${row.key}`)}>Variable name {index + 1}<input id={field(`env-name-${row.key}`)} value={row.name} onChange={(event) => changeEnvRow(index, 'name', event.target.value)} maxLength={128} autoComplete="off" spellCheck="false" /></label>
                  <label htmlFor={field(`env-value-${row.key}`)}>Variable value {index + 1}<input id={field(`env-value-${row.key}`)} type="password" value={row.value} onChange={(event) => changeEnvRow(index, 'value', event.target.value)} maxLength={16 * 1024} autoComplete="new-password" /></label>
                  <button type="button" className="btn-secondary btn-small" aria-label={`Remove environment variable ${index + 1}`} onClick={() => update('envRows', draft.envRows.filter((_, rowIndex) => rowIndex !== index))}>Remove</button>
                </div>)}
                <button type="button" className="btn-secondary btn-small" disabled={draft.envRows.length >= 64} onClick={() => update('envRows', [...draft.envRows, { key: createUuid(), name: '', value: '' }])}>Add environment variable</button>
              </div>}
            </> : <>
              <label htmlFor={field('url')}>MCP URL<input id={field('url')} type="url" value={draft.url} onChange={(event) => update('url', event.target.value)} maxLength={4096} autoComplete="off" spellCheck="false" placeholder="https://example.test/mcp" /></label>
              <p className="mcp-settings-note">Use HTTPS or HTTP on a literal loopback IP address. Credentials, query parameters, and fragments are not allowed in the URL.</p>
              <label htmlFor={field('token')}>Bearer token<input id={field('token')} type="password" value={draft.bearerToken} onChange={(event) => { update('bearerToken', event.target.value); if (event.target.value) update('clearBearerToken', false); }} maxLength={8192} autoComplete="new-password" placeholder={storedToken ? 'Leave blank to keep stored token for the same URL' : 'Optional'} /></label>
              {storedToken && <label className="mcp-check"><input type="checkbox" checked={draft.clearBearerToken} onChange={(event) => { update('clearBearerToken', event.target.checked); if (event.target.checked) update('bearerToken', ''); }} />Remove stored bearer token</label>}
            </>}
            <div className="mcp-editor-actions"><button type="button" className="btn-secondary" onClick={() => { setDraft(null); setError(''); }}>Cancel editing</button><button type="submit" className="btn-primary">{saving ? 'Saving…' : 'Save server'}</button></div>
          </fieldset>
        </form>}
      </>}
    </div>
  );
}
