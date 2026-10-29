import { environmentAllows } from '../utils/runtimePermissions';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, setActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { useViewportMetrics } from '../hooks/useViewportHeight';
import './RemoteAccess.css';
import './RemoteEnvironmentsPanel.css';

async function request(path, options) {
  const response = await apiFetch('/api/environments' + path, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Environment request failed');
  return data;
}

const CAPABILITIES = [
  ['terminalInput', 'Terminal input'], ['fileWrite', 'File changes'],
  ['agentExecute', 'Agent execution'], ['tunnels', 'Service tunnels'],
  ['desktopView', 'Desktop viewing'], ['desktopControl', 'Desktop control'],
  ['transfer', 'File transfers'], ['recordings', 'Session recordings'],
];
const emptyCapabilities = () => Object.fromEntries(CAPABILITIES.map(([key]) => [key, false]));
function timestamp(value) {
  if (!value) return '';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}
function PermissionSummary({ profile, capabilities }) {
  if (!profile) return null;
  const enabled = CAPABILITIES.filter(([key]) => capabilities?.[key]).map(([, title]) => title);
  return <small className="remote-device-permissions">{profile === 'observer' ? 'Observer' : profile === 'custom' ? 'Custom access' : 'Operator'}: {enabled.length ? enabled.join(', ') : 'View existing sessions and browse files'}</small>;
}
function DeviceEntry({ environment, active, status, busy, onSelect, onSave, onDisconnect }) {
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState(environment.label || '');
  const [tags, setTags] = useState((environment.tags || []).join(', '));
  const [favorite, setFavorite] = useState(Boolean(environment.favorite));
  const name = environment.label || environment.url;
  function edit() {
    setAlias(environment.label || ''); setTags((environment.tags || []).join(', '));
    setFavorite(Boolean(environment.favorite)); setEditing(true);
  }
  async function save(event) {
    event.preventDefault();
    const saved = await onSave(environment.id, { label: alias.trim(), favorite, tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))] });
    if (saved) setEditing(false);
  }
  return <article className="remote-device-entry">
    <div className="remote-environment-row">
      <div><strong>{environment.favorite && <span aria-label="Favorite">★ </span>}{name}</strong>
        <small>{environment.url}</small>
        {(environment.hostname || environment.os || environment.deviceId) && <small>{[environment.hostname, environment.os, environment.deviceId && 'ID ' + environment.deviceId].filter(Boolean).join(' · ')}</small>}
        <small className={'remote-device-status ' + (status?.connected ? 'online' : '')}>{status?.checkError ? `Could not check connection: ${status.checkError}` : status ? (status.connected ? 'Online' : 'Offline') : 'Checking connection…'}</small>
        {!status?.connected && timestamp(environment.lastSeenAt) && <small>Last seen {timestamp(environment.lastSeenAt)}</small>}
        {timestamp(environment.lastUsedAt) && <small>Last used {timestamp(environment.lastUsedAt)}</small>}
        {environment.lastWorkspace && <small>Recent workspace: {environment.lastWorkspace}</small>}
        {environment.tags?.length > 0 && <div className="remote-device-tags">{environment.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
        <PermissionSummary profile={status?.profile || environment.profile} capabilities={status?.capabilities || environment.capabilities} />
        {environment.insecureTransport && <small>Unencrypted connection</small>}
      </div>
      <div className="remote-device-actions">
        <button type="button" disabled={busy} aria-pressed={active?.id === environment.id} onClick={() => onSelect(environment)}>Use {name}</button>
        <button type="button" disabled={busy} aria-label={'Edit ' + name} onClick={edit}>Edit</button>
        <button type="button" disabled={busy} aria-label={'Disconnect ' + name} onClick={() => onDisconnect(environment)}>Disconnect</button>
      </div>
    </div>
    {editing && <form className="remote-device-editor" onSubmit={save}>
      <label>Device alias<input required maxLength={80} disabled={busy} value={alias} onChange={event => setAlias(event.target.value)} /></label>
      <label>Tags (comma separated)<input maxLength={500} disabled={busy} value={tags} onChange={event => setTags(event.target.value)} /></label>
      <label className="remote-environment-consent"><input type="checkbox" disabled={busy} checked={favorite} onChange={event => setFavorite(event.target.checked)} />Favorite device</label>
      <button type="submit" disabled={busy}>Save device</button> <button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel edit</button>
    </form>}
  </article>;
}

export function RemoteEnvironmentsPanel({ onSelected, children }) {
  const active = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const [data, setData] = useState({ environments: [], grants: [] });
  const [statuses, setStatuses] = useState({});
  const [search, setSearch] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [profile, setProfile] = useState('operator');
  const [capabilities, setCapabilities] = useState(emptyCapabilities);
  const mounted = useRef(true);
  const revision = useRef(0);
  const operation = useRef(false);
  useEffect(() => {
    if (!pairing) return;
    const expiry = typeof pairing.expiresAt === 'number' ? pairing.expiresAt * 1000 : new Date(pairing.expiresAt).getTime();
    const timeout = setTimeout(() => setPairing(null), Math.min(120000, Math.max(0, expiry - Date.now())));
    return () => clearTimeout(timeout);
  }, [pairing]);
  async function reload(signal) {
    if (!mounted.current) return;
    const version = ++revision.current;
    setRefreshing(true);
    try {
      const result = await request('', { signal });
      if (!mounted.current || signal?.aborted || version !== revision.current) return;
      setData(result);
      setStatuses({});
      const devices = [...(result.environments || [])];
      await Promise.all(Array.from({ length: Math.min(4, devices.length) }, async () => {
        while (devices.length && mounted.current && !signal?.aborted && version === revision.current) {
          const device = devices.shift();
          let status;
          try { status = await request('/' + encodeURIComponent(device.id) + '/status', { signal }); }
          catch (failure) { status = { checkError: failure.message || 'Status request failed' }; }
          if (mounted.current && !signal?.aborted && version === revision.current) {
            setStatuses(previous => ({ ...previous, [device.id]: status }));
            if (status.lastSeenAt) setData(previous => ({ ...previous, environments: previous.environments.map(item => item.id === device.id ? { ...item, lastSeenAt: status.lastSeenAt } : item) }));
          }
        }
      }));
    } catch (err) { if (mounted.current && !signal?.aborted && version === revision.current) setError(err.message); }
    finally { if (mounted.current && version === revision.current) setRefreshing(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    reload(controller.signal);
    const interval = setInterval(() => { if (!operation.current) reload(controller.signal); }, 60000);
    return () => { mounted.current = false; revision.current += 1; controller.abort(); clearInterval(interval); };
  }, []);
  async function perform(action) {
    if (operation.current) return false;
    operation.current = true; setError(''); setBusy(true);
    try { await action(); return true; } catch (err) { if (mounted.current) setError(err.message); return false; }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  function select(environment) { setActiveEnvironment(environment); onSelected?.(environment); }
  function connect(event) {
    event.preventDefault();
    if (/^http:\/\//i.test(url) && !allowInsecureHttp) { setError('Allow unencrypted HTTP only when you trust this network.'); return; }
    perform(async () => {
      await request('/connect', { method: 'POST', body: { url: url.trim(), code: code.trim(), label: label.trim() || new URL(url.trim()).hostname, allowInsecureHttp } });
      if (mounted.current) { setCode(''); setUrl(''); }
      await reload();
    });
  }
  const query = search.trim().toLocaleLowerCase();
  const devices = (data.environments || []).filter(environment => (!favoritesOnly || environment.favorite) && [environment.label, environment.url, environment.hostname, environment.deviceId, environment.lastWorkspace, ...(environment.tags || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || (a.label || a.url).localeCompare(b.label || b.url));
  return <div className="remote-access-panel remote-environments-panel">
    <p>Manage connected Terminal v4 servers and their access. Connection credentials stay on this server.</p>
    {error && <p role="alert">{error}</p>}
    <section aria-label="Available environments"><h3>Device address book</h3>
      <div className="remote-directory-controls"><label>Search devices<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Alias, tag, host or workspace" /></label>
        <label className="remote-environment-consent"><input type="checkbox" checked={favoritesOnly} onChange={event => setFavoritesOnly(event.target.checked)} />Favorites only</label>
        <button type="button" disabled={busy} aria-busy={refreshing} onClick={() => { setError(''); reload(); }}>Refresh devices</button>
      </div>
      <div className="remote-environment-row"><div><strong>This server</strong><small>{window.location.host}</small></div>
        <button type="button" onClick={() => select(null)} aria-pressed={!active}>Use this server</button></div>
      {!devices.length && !error && <p role="status">{refreshing ? 'Checking devices…' : data.environments?.length ? 'No devices match your search.' : 'No paired devices yet.'}</p>}
      {devices.map(environment => <DeviceEntry key={environment.id} environment={environment} active={active} status={statuses[environment.id]} busy={busy} onSelect={select}
        onSave={(id, fields) => perform(async () => { await request('/' + encodeURIComponent(id), { method: 'PATCH', body: fields }); if (getActiveEnvironment()?.id === id) setActiveEnvironment({ ...getActiveEnvironment(), ...fields }); await reload(); })}
        onDisconnect={environment => perform(async () => { await request('/' + encodeURIComponent(environment.id), { method: 'DELETE' }); if (getActiveEnvironment()?.id === environment.id) setActiveEnvironment(null); await reload(); })} />)}
    </section>
    <form onSubmit={connect}><h3>Pair another server</h3>
      <p>On the other server, open Server → Manage servers and create a pairing code. Paste it here before it expires.</p>
      <label>Remote server URL<input type="url" required disabled={busy} placeholder="https://server.example.com" value={url} onChange={event => setUrl(event.target.value)} /></label>
      <label>Label (optional)<input maxLength={80} disabled={busy} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label>Pairing code<input required disabled={busy} autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} /></label>
      {/^http:\/\//i.test(url) && <label className="remote-environment-consent"><input type="checkbox" disabled={busy} checked={allowInsecureHttp} onChange={event => setAllowInsecureHttp(event.target.checked)} />Allow unencrypted HTTP on this trusted network</label>}
      <button disabled={busy} type="submit">Pair server</button>
    </form>
    <section><h3>Allow access to this server</h3><p>A pairing code expires in two minutes and can be used once. Only share it with a server you trust.</p>
      <label>Access profile<select disabled={busy} value={profile} onChange={event => { setProfile(event.target.value); setPairing(null); }}><option value="observer">Observer — view and browse</option><option value="operator">Operator — terminals, files and agents</option><option value="custom">Custom permissions</option></select></label>
      {profile === 'custom' && <fieldset className="remote-permission-options"><legend>Allow this paired device to</legend>{CAPABILITIES.map(([key, title]) => <label className="remote-environment-consent" key={key}><input type="checkbox" disabled={busy} checked={capabilities[key]} onChange={event => { setCapabilities(previous => ({ ...previous, [key]: event.target.checked })); setPairing(null); }} />{title}</label>)}</fieldset>}
      <p>{profile === 'observer' ? 'Observers can view existing session output and browse files. They cannot start sessions or send input.' : profile === 'operator' ? 'Operators can run terminals and agents, change and transfer files, and use recordings. Desktop access and service tunnels require custom permissions.' : 'Only selected actions are allowed. Desktop control also requires desktop viewing.'}</p>
      <button disabled={busy || (profile === 'custom' && capabilities.desktopControl && !capabilities.desktopView)} type="button" onClick={() => perform(async () => {
        const result = await request('/pairing-code', { method: 'POST', body: { label: label.trim() || 'Paired client', profile, ...(profile === 'custom' ? { capabilities } : {}) } });
        if (mounted.current) setPairing(result);
      })}>Create pairing code</button>
      {pairing && <div className="remote-environment-code"><output aria-label="Generated pairing code">{pairing.code}</output><small>Expires {new Date(typeof pairing.expiresAt === 'number' ? pairing.expiresAt * 1000 : pairing.expiresAt).toLocaleTimeString()}</small></div>}
      {data.grants?.map(grant => <div className="remote-environment-row" key={grant.id}><div><strong>{grant.label}</strong><PermissionSummary profile={grant.profile} capabilities={grant.capabilities} />{timestamp(grant.expiresAt) && <small>Access expires {timestamp(grant.expiresAt)}</small>}</div><button type="button" disabled={busy} aria-label={'Revoke ' + grant.label} onClick={() => perform(async () => { await request('/grants/' + encodeURIComponent(grant.id), { method: 'DELETE' }); await reload(); })}>Revoke access</button></div>)}
    </section>
    {children}
  </div>;
}

function ServerChooser({ active, onSelect, onManage, manageRef }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const requestRef = useRef(null);
  async function load() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError('');
    try {
      const data = await request('', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(data?.environments)) throw new Error('Unable to read the server list.');
      setServers(data.environments);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Unable to load servers.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, []);
  const available = active && !servers.some(server => server.id === active.id) ? [active, ...servers] : servers;
  const query = search.trim().toLocaleLowerCase();
  const visible = available.filter(server => [server.label, server.url, server.hostname, ...(server.tags || [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || (a.label || a.url).localeCompare(b.label || b.url));
  return <>
    <p className="server-chooser-description">Choose where your terminals, agents and files run.</p>
    {available.length > 5 && <label className="server-chooser-search">Find server<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name or address" /></label>}
    <div className="server-chooser-list" aria-label="Available servers">
      <button type="button" className="server-chooser-option" aria-label="Use this server" aria-pressed={!active} onClick={() => onSelect(null)}>
        <span><strong>This server</strong><small title={window.location.host}>{window.location.host}</small></span><span className="server-chooser-check" aria-hidden="true">{!active ? '✓' : ''}</span>
      </button>
      {visible.map(server => <button type="button" className="server-chooser-option" key={server.id} aria-label={`Use ${server.label || server.url}`} aria-pressed={active?.id === server.id} onClick={() => onSelect(server)}>
        <span><strong>{server.label || server.url}</strong><small title={server.url}>{server.hostname || server.url}{server.profile === 'observer' ? ' · Read-only' : ''}</small></span><span className="server-chooser-check" aria-hidden="true">{active?.id === server.id ? '✓' : ''}</span>
      </button>)}
      {loading && <p role="status">Loading connected servers…</p>}
      {!loading && !error && !available.length && <p>No other servers connected.</p>}
      {!loading && !error && available.length > 0 && !visible.length && <p>No servers match your search.</p>}
      {error && <div className="server-chooser-error" role="alert">{error}<button type="button" onClick={() => void load()}>Retry server list</button></div>}
    </div>
    <footer className="server-chooser-footer"><button ref={manageRef} type="button" onClick={onManage}><span>Manage servers</span><span aria-hidden="true">›</span></button></footer>
  </>;
}

function ServerSwitcherDialog({ active, onSelect, onClose, children }) {
  const [managing, setManaging] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const dialog = useRef(null);
  const manageRef = useRef(null);
  const backRef = useRef(null);
  const wasManaging = useRef(false);
  const titleId = useId();
  const viewport = useViewportMetrics();
  useEffect(() => {
    const root = document.getElementById('root');
    const previousInert = root?.inert;
    if (root) root.inert = true;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (root) root.inert = previousInert; };
  }, []);
  useLayoutEffect(() => {
    if (managing) backRef.current?.focus({ preventScroll: true });
    else if (wasManaging.current) manageRef.current?.focus({ preventScroll: true });
    wasManaging.current = managing;
  }, [managing]);
  function keyDown(event) {
    if (event.defaultPrevented) return;
    if (event.target.closest('[role="dialog"]') !== event.currentTarget) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (managing) { setManaging(false); setAdvanced(false); } else onClose();
    }
    if (event.key !== 'Tab') return;
    const fields = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]')].filter(element => !element.closest('[hidden]'));
    const first = fields[0], last = fields[fields.length - 1];
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return createPortal(<div className={`modal-overlay remote-environment-overlay server-switcher-overlay${managing ? ' server-switcher-managing' : ''}`}
    style={{ top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height, bottom: 'auto', right: 'auto' }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`remote-environment-dialog server-switcher-dialog${managing ? ' server-management-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialog} onKeyDown={keyDown}>
      <header><div>{managing && <button ref={backRef} type="button" className="server-switcher-back" onClick={() => { setManaging(false); setAdvanced(false); }}><span aria-hidden="true">‹</span> Back to servers</button>}<h2 id={titleId}>{managing ? 'Manage servers' : 'Switch server'}</h2></div><button type="button" aria-label="Close server chooser" onClick={onClose}>&times;</button></header>
      {!managing && <div className="server-chooser-body"><ServerChooser active={active} onSelect={onSelect} manageRef={manageRef} onManage={() => setManaging(true)} /></div>}
      {managing && <div className="server-management-body"><RemoteEnvironmentsPanel onSelected={onClose}>
        {children && <section className="server-advanced-tools"><button type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>Additional remote tools <span aria-hidden="true">{advanced ? '⌃' : '⌄'}</span></button>{advanced && children}</section>}
      </RemoteEnvironmentsPanel></div>}
    </section>
  </div>, document.body);
}

export function RemoteEnvironmentSwitcher({ children, compact = false }) {
  const active = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const trigger = useRef(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!active) { setStatus(''); return; }
    const controller = new AbortController();
    const check = () => request('/' + encodeURIComponent(active.id) + '/status', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setStatus(result.connected ? 'Connected' : 'Unavailable'); })
      .catch(() => { if (!controller.signal.aborted) setStatus('Unavailable'); });
    setStatus('Connecting'); check();
    const timer = setInterval(check, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active]);
  useEffect(() => { if (!open && wasOpen.current) trigger.current?.focus({ preventScroll: true }); wasOpen.current = open; }, [open]);
  function close() { setOpen(false); }
  function select(environment) { setActiveEnvironment(environment); close(); }
  const name = active?.label || active?.url || 'This server';
  const selector = <button type="button" ref={trigger} className={compact ? 'remote-server-compact-trigger' : undefined}
    onClick={() => setOpen(true)} title={`Server: ${name}${status ? ` · ${status}` : ''}`}
    aria-label={`Switch server, ${name}`} aria-haspopup="dialog" aria-expanded={open}>
    {compact ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></svg>
      : <><span className="remote-environment-kicker">Server</span> <strong>{name}</strong></>}
    <svg className="remote-environment-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
  </button>;
  return <>
    {compact ? selector : <div className="remote-environment-bar" role="region" aria-label="Active environment">
      {selector}
      {active && <><span role="status">{!environmentAllows(active, 'terminalInput') ? 'Read-only terminal · ' : ''}{status}</span><button type="button" onClick={() => setActiveEnvironment(null)}>This server</button></>}
    </div>}
    {open && <ServerSwitcherDialog active={active} onSelect={select} onClose={close}>{children}</ServerSwitcherDialog>}
  </>;
}
