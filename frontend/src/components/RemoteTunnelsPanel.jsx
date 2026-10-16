import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
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
 const [busy, setBusy] = useState(false);
 const mounted = useRef(true);
 async function reload(signal) {
  const [hosts, active] = await Promise.all([request('/api/environments', {signal}), request('/api/tunnels', {signal})]);
  if (!mounted.current || signal?.aborted) return;
  setEnvironments(hosts.environments || []); setTunnels(active.tunnels || []);
 }
 useEffect(() => {
  mounted.current = true;
  const controller = new AbortController();
  reload(controller.signal).catch(err => { if (!controller.signal.aborted) setError(err.message); });
  const poll = setInterval(() => reload(controller.signal).catch(() => {}), 5000);
  return () => { mounted.current = false; controller.abort(); clearInterval(poll); };
 }, []);
 async function perform(action) {
  setBusy(true); setError('');
  try { await action(); if (mounted.current) await reload(); }
  catch(err) { if (mounted.current) setError(err.message); }
  finally { if (mounted.current) setBusy(false); }
 }
 function create(event) {
  event.preventDefault();
  const port = Number(targetPort), local = Number(localPort);
  if (!environmentId || !Number.isInteger(port) || port < 1 || port > 65535 || (localPort && (!Number.isInteger(local) || local < 1 || local > 65535))) { setError('Choose a device and valid ports between 1 and 65535.'); return; }
  perform(() => request('/api/tunnels', {method:'POST', body:{environmentId,targetPort:port,...(localPort ? {localPort:local} : {})}}));
 }
 return <section className="remote-tunnels" aria-label="Service tunnels">
  <h3>Service tunnels</h3>
  <p>Forward a remote loopback service to the home API computer. Use its local address on that computer; a phone viewing this page cannot connect to that address.</p>
  <p>Requires an explicit Service tunnels grant. Stopping a tunnel or revoking access closes its connections. Tunnels end when this login expires or the server stops.</p>
  {error && <p role="alert">{error}</p>}
  <form onSubmit={create}>
   <label>Tunnel device<select value={environmentId} onChange={event=>setEnvironmentId(event.target.value)} required><option value="">Choose a paired device</option>{environments.filter(host=>host.capabilities?.tunnels).map(host=><option key={host.id} value={host.id}>{host.label}</option>)}</select></label>
   <label>Remote service port<input type="number" min="1" max="65535" required value={targetPort} onChange={event=>setTargetPort(event.target.value)} /></label>
   <label>Home local port (optional)<input type="number" min="1" max="65535" value={localPort} onChange={event=>setLocalPort(event.target.value)} placeholder="Choose an available port" /></label>
   <button disabled={busy} type="submit">Start service tunnel</button>
  </form>
  {!tunnels.length && <p>No active service tunnels.</p>}
  {tunnels.map(tunnel=><article key={tunnel.id}><div><strong>127.0.0.1:{tunnel.localPort}</strong><small>{environments.find(host=>host.id===tunnel.environmentId)?.label || 'Paired device'} · remote port {tunnel.targetPort}</small></div><button disabled={busy} aria-label={'Stop tunnel '+tunnel.localPort} onClick={()=>perform(()=>request('/api/tunnels/'+tunnel.id,{method:'DELETE'}))}>Stop</button></article>)}
 </section>;
}
