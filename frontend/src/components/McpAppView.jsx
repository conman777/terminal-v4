import { createUuid } from '../utils/createUuid';
import { useEffect, useId, useRef, useState } from 'react';
import { isAuthScopeCurrent } from '../utils/auth';
import { captureMcpProbeScope, scopedMcpProbeFetch, subscribeMcpProbeScope } from './mcpProbeScope';
import { MCP_APP_DENIED_FEATURES, MCP_APP_MAX_PENDING, MCP_APP_METHODS, MCP_APP_PROTOCOL, MCP_APP_PROXY_URL, mcpAppDocument, mcpAppHtmlMime, mcpAppLink, mcpAppMessage, mcpAppResourceUri } from '../utils/mcpApps';
import './McpAppView.css';

const sessionPath = (id) => `/api/agent/mcp/apps/${id}`;
const requestKey = (id) => JSON.stringify(id);
async function read(response) {
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error || `MCP app request failed (${response.status}).`);
  if (!value) throw new Error('MCP app returned an invalid response.');
  return value;
}
const closeSession = async (job, keepalive = false) => {
  if (job.cleaned) return;
  if (job.cleanup) return job.cleanup;
  job.cleanup = (async () => {
    const receipt = await read(await job.fetch(sessionPath(job.id), { method: 'DELETE', keepalive, signal: AbortSignal.timeout(15_000) }));
    if (receipt.sessionId !== job.id || receipt.status !== 'closed') throw new Error('Server connection cleanup has not been confirmed.');
    job.cleaned = true;
    clearTimeout(job.retryTimer);
  })();
  try { await job.cleanup; }
  finally { job.cleanup = null; }
};
const retireSession = (job) => {
  void closeSession(job, true).catch(() => {
    // Closing can cancel the server's expiry task before transport cleanup succeeds.
    // Keep this owner alive after unmount; never retry under a different auth session.
    if (job.retryTimer || !isAuthScopeCurrent(job.scope.auth)) return;
    job.retryTimer = setTimeout(() => {
      job.retryTimer = null;
      retireSession(job);
    }, job.retryDelay);
    job.retryDelay = Math.min(job.retryDelay * 2, 30_000);
  });
};

export function McpAppView({ serverId, serverName, tool, onClose }) {
  const sourceId = useId();
  const [app, setApp] = useState(null);
  const [running, setRunning] = useState(false);
  const [networkConsent, setNetworkConsent] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Opening app…');
  const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState([]);
  const [height, setHeight] = useState(360);
  const frame = useRef(null);
  const connection = useRef(null);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;
  const resourceUri = mcpAppResourceUri(tool);

  const send = (job, message) => { if (job.proxy && !job.disposed) job.proxy.postMessage(message, '*'); };
  const reject = (job, id, message, code = -32000) => send(job, { jsonrpc: '2.0', id, error: { code, message } });
  const refreshPending = (job) => { if (!job.disposed) setPending([...job.pending.values()]); };
  const removePending = (job, item) => { job.pending.delete(requestKey(item.rpcId)); refreshPending(job); };

  useEffect(() => {
    const scope = captureMcpProbeScope();
    const job = { id: createUuid(), scope, fetch: (path, options) => scopedMcpProbeFetch(scope, path, options), controller: new AbortController(), pending: new Map(), proxy: null, disposed: false, closed: false, initialized: false, ready: false, loaded: false, app: null, teardown: null, cleaned: false, cleanup: null, retryTimer: null, retryDelay: 1000 };
    connection.current = job;
    let pollTimer;
    setApp(null); setRunning(false); setNetworkConsent(false); setPending([]); setError(''); setStatus('Opening app…'); setClosing(false);
    const revoke = (message) => {
      if (job.disposed || job.closed) return;
      if (job.ready) send(job, { jsonrpc: '2.0', id: `v4-teardown-${job.id}`, method: 'ui/resource-teardown', params: { reason: message } });
      job.closed = true; job.pending.clear(); job.controller.abort();
      setApp(null); setPending([]); setError(message); setStatus('App closed.');
      retireSession(job);
    };
    const unsubscribeScope = subscribeMcpProbeScope(() => {
      if (!isAuthScopeCurrent(scope.auth) || captureMcpProbeScope().environment !== scope.environment) revoke('The app environment or account changed. Reopen it to continue.');
    });
    const poll = async () => {
      if (job.disposed || job.closed) return;
      try {
        const response = await job.fetch(sessionPath(job.id), { signal: job.controller.signal });
        if (!response.ok) { revoke('This app session is no longer active. It may have been revoked, disabled, or expired.'); return; }
        const receipt = await read(response);
        if (receipt.status !== 'active') { revoke('This app session is no longer active.'); return; }
      } catch {
        if (!job.controller.signal.aborted) { revoke('The app session could not be verified and was closed. Reopen it to continue.'); return; }
      }
      if (!job.closed && !job.disposed) pollTimer = setTimeout(poll, 1000);
    };
    const enqueue = async (message) => {
      const key = requestKey(message.id);
      if (job.pending.has(key)) { reject(job, message.id, 'A request with this ID is already pending.'); return; }
      if (job.pending.size >= MCP_APP_MAX_PENDING) { reject(job, message.id, 'Too many pending requests.'); return; }
      const item = { rpcId: message.id, method: message.method, params: message.params || {}, phase: 'preparing' };
      job.pending.set(key, item); refreshPending(job);
      if (message.method === 'ui/open-link') {
        const url = mcpAppLink(message.params?.url);
        if (!url) { removePending(job, item); reject(job, message.id, 'Invalid link URL.'); return; }
        item.url = url; item.phase = 'pending'; refreshPending(job); return;
      }
      try {
        const receipt = await read(await job.fetch(`${sessionPath(job.id)}/requests`, { method: 'POST', body: { method: message.method, params: item.params }, signal: job.controller.signal }));
        if (job.closed || job.disposed) return;
        if (receipt.status !== 'pending' || typeof receipt.requestId !== 'string') throw new Error('Invalid approval receipt.');
        item.requestId = receipt.requestId; item.method = receipt.method; item.params = receipt.params; item.phase = 'pending'; refreshPending(job);
      } catch (err) {
        if (!job.closed && !job.disposed) { removePending(job, item); reject(job, message.id, err.message || 'Could not prepare request.'); }
      }
    };
    const onMessage = (event) => {
      if (job.disposed || event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      job.proxy = event.source;
      const raw = event.data;
      if (job.teardown && raw?.jsonrpc === '2.0' && raw.id === job.teardown.id && (Object.hasOwn(raw, 'result') || Object.hasOwn(raw, 'error'))) { job.teardown.resolve(); return; }
      const message = mcpAppMessage(raw);
      if (!message) return;
      if (message.method === 'ui/notifications/sandbox-proxy-ready') {
        if (!job.loaded && job.app && !job.closed) {
          job.loaded = true;
          send(job, { jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { html: mcpAppDocument(job.app.html), csp: {}, permissions: {}, sandbox: 'allow-scripts' } });
        }
        return;
      }
      if (job.closed) { if (message.hasId) reject(job, message.id, 'App session is closing.'); return; }
      if (message.method.startsWith('ui/notifications/sandbox-')) return;
      if (message.method === 'ui/initialize' && message.hasId) {
        if (job.initialized) { reject(job, message.id, 'App is already initialized.'); return; }
        const params = message.params;
        if (params?.protocolVersion !== MCP_APP_PROTOCOL || typeof params.appInfo?.name !== 'string' || typeof params.appInfo?.version !== 'string' || !params.appCapabilities || typeof params.appCapabilities !== 'object') {
          reject(job, message.id, 'Unsupported or invalid MCP Apps initialization.', -32602); return;
        }
        job.initialized = true;
        const dark = !window.matchMedia?.('(prefers-color-scheme: light)').matches;
        send(job, { jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: MCP_APP_PROTOCOL, hostInfo: { name: 'V4', version: '0.1.0' },
          hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {}, sandbox: { csp: {}, permissions: {} } },
          hostContext: { theme: dark ? 'dark' : 'light', displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web', locale: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, containerDimensions: { maxHeight: 720, width: frame.current?.clientWidth || 600 }, toolInfo: { tool } },
        } });
        return;
      }
      if (message.method === 'ui/notifications/initialized' && !message.hasId && job.initialized) { job.ready = true; setStatus('App connected.'); return; }
      if (!job.ready) { if (message.hasId) reject(job, message.id, 'Initialize the app before making requests.', -32002); return; }
      if (message.method === 'ui/notifications/size-changed' && !message.hasId) {
        if (Number.isFinite(message.params?.height)) setHeight(Math.max(160, Math.min(720, Math.ceil(message.params.height))));
        return;
      }
      if (!message.hasId) return;
      if (message.method === 'ping') { send(job, { jsonrpc: '2.0', id: message.id, result: {} }); return; }
      if (message.method === 'ui/request-display-mode') { send(job, { jsonrpc: '2.0', id: message.id, result: { mode: 'inline' } }); return; }
      if (MCP_APP_METHODS.has(message.method) || message.method === 'ui/open-link') { void enqueue(message); return; }
      reject(job, message.id, 'This host operation is not supported in the settings app preview.', -32601);
    };
    window.addEventListener('message', onMessage);
    void (async () => {
      try {
        if (!resourceUri) throw new Error('This tool has no valid MCP app resource.');
        const value = await read(await job.fetch(`/api/agent/mcp/${encodeURIComponent(serverId)}/apps/open`, { method: 'POST', body: { resourceUri, toolName: tool.name, sessionId: job.id }, signal: job.controller.signal }));
        if (job.disposed || job.closed) return;
        if (value.sessionId !== job.id || value.resourceUri !== resourceUri || !mcpAppHtmlMime(value.resource?.mimeType)) throw new Error('The server returned an invalid app resource.');
        mcpAppDocument(value.html);
        job.app = value; setApp(value); setStatus('Review the HTML before running this app.');
        pollTimer = setTimeout(poll, 1000);
      } catch (err) {
        if (!job.disposed && !job.closed) { job.closed = true; job.controller.abort(); setError(err.message || 'Could not open MCP app.'); setStatus('App could not be opened.'); retireSession(job); }
      }
    })();
    return () => {
      clearTimeout(pollTimer);
      if (job.ready) send(job, { jsonrpc: '2.0', id: `v4-teardown-${job.id}`, method: 'ui/resource-teardown', params: { reason: 'View closed' } });
      job.disposed = true; job.closed = true; job.controller.abort(); job.pending.clear();
      window.removeEventListener('message', onMessage);
      unsubscribeScope();
      retireSession(job);
    };
  }, [serverId, resourceUri, tool.name]);

  const finishRequest = (job, item, receipt) => {
    if (job.disposed || job.closed) return;
    if (receipt.status === 'completed') { send(job, { jsonrpc: '2.0', id: item.rpcId, result: receipt.result }); removePending(job, item); }
    else if (receipt.status === 'denied') { reject(job, item.rpcId, 'Request denied by user.'); removePending(job, item); }
    else if (receipt.status === 'failed') { reject(job, item.rpcId, receipt.error || 'App request failed.'); removePending(job, item); }
    else if (receipt.status === 'pending') { item.phase = 'pending'; delete item.error; refreshPending(job); }
    else { item.phase = 'uncertain'; refreshPending(job); }
  };
  const decide = async (item, approved, checkOnly = false) => {
    const job = connection.current;
    if (!job || job.closed || item.phase === 'deciding') return;
    if (item.url) { reject(job, item.rpcId, 'Link opening denied by user.'); removePending(job, item); return; }
    item.phase = 'deciding'; refreshPending(job);
    try {
      const path = `${sessionPath(job.id)}/requests/${encodeURIComponent(item.requestId)}`;
      const receipt = await read(await job.fetch(checkOnly ? path : `${path}/decision`, checkOnly ? { signal: job.controller.signal } : { method: 'POST', body: { approved }, signal: job.controller.signal }));
      finishRequest(job, item, receipt);
    } catch (err) {
      if (!job.disposed && !job.closed) { item.phase = 'uncertain'; item.error = err.message || 'Result could not be confirmed.'; refreshPending(job); }
    }
  };
  const close = async () => {
    const job = connection.current;
    if (!job || closing) return;
    setClosing(true); setError(''); job.closed = true; job.controller.abort();
    if (job.ready) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 300);
        job.teardown = { id: `v4-teardown-${job.id}`, resolve: () => { clearTimeout(timer); resolve(); } };
        send(job, { jsonrpc: '2.0', id: job.teardown.id, method: 'ui/resource-teardown', params: { reason: 'User closed the app' } });
      });
    }
    if (job.disposed) return;
    setApp(null); setPending([]); setStatus('Closing server connection…');
    try { await closeSession(job); if (!job.disposed) closeCallback.current?.(); }
    catch (err) { if (!job.disposed) { setError(`Could not confirm app cleanup: ${err.message || 'Unknown error'}. Retry closing.`); setStatus('App view closed; server cleanup needs confirmation.'); } }
    finally { if (!job.disposed) setClosing(false); }
  };

  return <section className="mcp-app-panel" aria-label={`MCP app from ${serverName}`}>
    <div className="mcp-app-header"><div><h4>{tool.name}</h4><p>{serverName} · {resourceUri}</p></div><button type="button" className="btn-secondary btn-small" disabled={closing} onClick={() => void close()}>{closing ? 'Closing app…' : 'Close app'}</button></div>
    <p className="mcp-settings-note">This preview denies declared CSP network sources and isolates host storage. Every server request requires approval. Browser-specific channels such as WebRTC can bypass CSP in some runtimes. Run only app HTML you trust; running may allow browser network access outside V4’s control.</p>
    <details className="mcp-app-policy"><summary>Requested server policy</summary><pre>{JSON.stringify({ csp: app?.csp || {}, permissions: app?.permissions || {} }, null, 2)}</pre><p>These are server requests. They do not grant access.</p></details>
    {error && <p role="alert" className="mcp-settings-error">{error}</p>}
    <p role="status" className="mcp-settings-note">{status}</p>
    {app && !running && <div className="mcp-app-source"><label htmlFor={sourceId}>App HTML source</label><textarea id={sourceId} readOnly value={app.html} rows={8} spellCheck="false" /><label className="mcp-check"><input type="checkbox" checked={networkConsent} onChange={(event) => setNetworkConsent(event.target.checked)} />I allow this app to use browser network channels V4 cannot block.</label><button type="button" className="btn-primary" disabled={!networkConsent} onClick={() => { setRunning(true); setStatus('Waiting for the app to initialize…'); }}>Run app preview</button></div>}
    {app && running && <iframe ref={frame} title="MCP app sandbox" className="mcp-app-frame" src={MCP_APP_PROXY_URL} sandbox="allow-scripts allow-same-origin" allow={MCP_APP_DENIED_FEATURES} referrerPolicy="no-referrer" style={{ height }} />}
    {pending.length > 0 && <div className="mcp-app-requests" aria-label="App approval requests"><h5>Review app requests</h5>{pending.map((item) => <article className="mcp-app-request" key={requestKey(item.rpcId)}>
      <strong>{item.method}</strong>{item.phase === 'deciding' && <p>Waiting for the server request…</p>}<pre>{JSON.stringify(item.params, null, 2)}</pre>
      {item.phase === 'preparing' ? <p>Preparing approval…</p> : item.url ? <div className="mcp-server-actions"><a className="btn-primary btn-small" href={item.url} target="_blank" rel="noopener noreferrer" onClick={() => { const job = connection.current; send(job, { jsonrpc: '2.0', id: item.rpcId, result: {} }); removePending(job, item); }}>Open requested link</a><button type="button" className="btn-secondary btn-small" onClick={() => void decide(item, false)}>Deny request</button></div> : item.phase === 'uncertain' ? <><p>{item.error || 'The server request is still running.'} Check its result without repeating execution.</p><button type="button" className="btn-secondary btn-small" onClick={() => void decide(item, false, true)}>Check request result</button></> : <div className="mcp-server-actions"><button type="button" className="btn-primary btn-small" disabled={item.phase === 'deciding'} onClick={() => void decide(item, true)}>Approve request</button><button type="button" className="btn-secondary btn-small" disabled={item.phase === 'deciding'} onClick={() => void decide(item, false)}>Deny request</button></div>}
    </article>)}</div>}
  </section>;
}
