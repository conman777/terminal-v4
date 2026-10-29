import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './RemoteAccess.css';
import './RemoteTunnelsPanel.css';
async function request(path, options = {}) {
 const response = await apiFetch(path, { home: true, ...options });
 const data = response.status === 204 ? null : await response.json();
 if (!response.ok) throw new Error(data?.error || 'Tunnel request failed');
 return data;
}
export default function RemoteTunnelsPanel() {
 const [environments, setEnvironments] = useState([]);
 const [tunnels, setTunnels] = useState([]);
 const [environmentId, setEnvironmentId] = useState('');
 const [targetPort, setTargetPort] = useState('');
 const [localPort, setLocalPort] = useState('');
 const [error, setError] = useState('');
 const [loadError, setLoadError] = useState('');
 const [loading, setLoading] = useState(true);
 const [loaded, setLoaded] = useState(false);
 const [busy, setBusy] = useState(false);
 const mounted = useRef(true);
 const revision = useRef(0);
 const pendingRead = useRef(null);
 const operation = useRef(false);
 async function reload(signal) {
  const version = ++revision.current;
  pendingRead.current = version;
  setLoading(true);
  try {
   const [hosts, active] = await Promise.all([request('/api/environments', {signal}), request('/api/tunnels', {signal})]);
   if (!mounted.current || signal?.aborted || version !== revision.current) return;
   if (!Array.isArray(hosts?.environments) || !Array.isArray(active?.tunnels)) throw new Error('Invalid device or tunnel list response');
   setEnvironments(hosts.environments); setTunnels(active.tunnels); setLoaded(true); setLoadError('');
  } catch (failure) {
   if (mounted.current && !signal?.aborted && version === revision.current) setLoadError(failure.message || 'Could not load service tunnels');
  } finally {
   if (pendingRead.current === version) pendingRead.current = null;
   if (mounted.current && !signal?.aborted && version === revision.current) setLoading(false);
  }
 }
 useEffect(() => {
  mounted.current = true;
  const controller = new AbortController();
  void reload(controller.signal);
  const poll = setInterval(() => { if (!operation.current && pendingRead.current === null) void reload(controller.signal); }, 5000);
  return () => { mounted.current = false; revision.current += 1; controller.abort(); clearInterval(poll); };
 }, []);
 async function perform(action) {
  if (operation.current) return;
  operation.current = true; revision.current += 1;
  setBusy(true); setError('');
  try { await action(); if (mounted.current) await reload(); }
  catch(err) { if (mounted.current) setError(err.message); }
  finally { operation.current = false; if (mounted.current) setBusy(false); }
 }
 function create(event) {
  event.preventDefault();
  if (!loaded || loading || loadError || !environments.some(host => host.id === environmentId && host.capabilities?.tunnels)) return;
  const port = Number(targetPort), local = Number(localPort);
  if (!environmentId || !Number.isInteger(port) || port < 1 || port > 65535 || (localPort && (!Number.isInteger(local) || local < 1 || local > 65535))) { setError('Choose a device and valid ports between 1 and 65535.'); return; }
  perform(() => request('/api/tunnels', {method:'POST', body:{environmentId,targetPort:port,...(localPort ? {localPort:local} : {})}}));
 }
 return <section className="remote-access-panel remote-tunnels" aria-label="Service tunnels">
  <h3>Service tunnels</h3>
  <p>Forward a remote loopback service to the home API computer. Use its local address on that computer; a phone viewing this page cannot connect to that address.</p>
  <p>Requires an explicit Service tunnels grant. Stopping a tunnel or revoking access closes its connections. Tunnels end when this login expires or the server stops.</p>
  {error && <p role="alert">{error}</p>}
  {loading && <p role="status">Loading service tunnels…</p>}
  {loadError && <p role="alert">{loaded ? 'Device and tunnel list is unconfirmed. ' : ''}{loadError}</p>}
  <button type="button" disabled={loading || busy} onClick={() => void reload()}>Refresh service tunnels</button>
  {loaded && !loadError && !environments.some(host => host.capabilities?.tunnels) && <p>No paired device has Service tunnels permission. Pair a device with a Custom access profile that grants Service tunnels.</p>}
  <form onSubmit={create}>
   <label>Tunnel device<select disabled={busy || loading || !!loadError} value={environmentId} onChange={event=>setEnvironmentId(event.target.value)} required><option value="">Choose a paired device</option>{environments.filter(host=>host.capabilities?.tunnels).map(host=><option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
   <label>Remote service port<input disabled={busy} type="number" min="1" max="65535" required value={targetPort} onChange={event=>setTargetPort(event.target.value)} /></label>
   <label>Home local port (optional)<input disabled={busy} type="number" min="1" max="65535" value={localPort} onChange={event=>setLocalPort(event.target.value)} placeholder="Choose an available port" /></label>
   <button disabled={busy || loading || !!loadError || !loaded || !environments.some(host=>host.id === environmentId && host.capabilities?.tunnels)} type="submit">Start service tunnel</button>
  </form>
  {loaded && !loadError && !loading && !tunnels.length && <p>No active service tunnels.</p>}
  {tunnels.map(tunnel=><article key={tunnel.id}><div><strong>127.0.0.1:{tunnel.localPort}</strong><small>{environments.find(host=>host.id===tunnel.environmentId)?.label || 'Paired device'} · remote port {tunnel.targetPort}</small></div><button disabled={busy} aria-label={'Stop tunnel '+tunnel.localPort} onClick={()=>perform(()=>request('/api/tunnels/'+tunnel.id,{method:'DELETE'}))}>Stop</button></article>)}
 </section>;
}
