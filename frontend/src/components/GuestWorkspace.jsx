import { useEffect, useRef, useState } from 'react';
import { resolveHomeApiUrl } from '../utils/apiBase';
import './GuestWorkspace.css';
export function hasGuestInvitation() { return window.location.hash.startsWith('#invite='); }
function invitation() {
  const value = window.location.hash.slice('#invite='.length);
  const separator = value.indexOf('.');
  if (separator < 1) return null;
  try { return { id: decodeURIComponent(value.slice(0, separator)), secret: decodeURIComponent(value.slice(separator + 1)) }; } catch { return null; }
}
function GuestTerminalOutput({ output }) {
  const container = useRef(null);
  const terminal = useRef(null);
  const previous = useRef('');
  const queuedWrites = useRef(Promise.resolve());
  const version = useRef(0);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let observer;
    let fit;
    const resize = () => {
      if (cancelled || !container.current?.clientWidth || !container.current?.clientHeight) return;
      try { fit?.fit(); } catch { /* A detached terminal has no drawable size. */ }
    };
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')]).then(([{ Terminal }, { FitAddon }]) => {
      if (cancelled) return;
      const instance = new Terminal({ disableStdin: true, screenReaderMode: true, cols: 100, rows: 24, scrollback: 5000, fontSize: 14, convertEol: true, theme: { background: '#111318', foreground: '#eceef3' } });
      terminal.current = instance;
      fit = new FitAddon(); instance.loadAddon(fit); instance.open(container.current);
      if (instance.textarea) { instance.textarea.readOnly = true; instance.textarea.tabIndex = -1; instance.textarea.setAttribute('aria-label', 'Read-only shared terminal output'); }
      resize();
      if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(resize); observer.observe(container.current); }
      window.addEventListener('resize', resize);
      setReady(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; version.current += 1; observer?.disconnect(); window.removeEventListener('resize', resize); terminal.current?.dispose(); terminal.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const generation = version.current;
    queuedWrites.current = queuedWrites.current.catch(() => {}).then(() => new Promise(resolve => {
      const instance = terminal.current;
      if (!instance || generation !== version.current) { resolve(); return; }
      const append = output.startsWith(previous.current);
      const text = append ? output.slice(previous.current.length) : output;
      if (!append) instance.reset();
      previous.current = output;
      if (text) instance.write(text, resolve); else resolve();
    }));
  }, [output, ready]);
  return <section className="guest-terminal-output" aria-label="Shared terminal output"><div ref={container} className="guest-terminal-host" />{failed && <p role="alert">The terminal renderer could not load. Refresh the page to reconnect with a new invitation.</p>}</section>;
}

export function GuestWorkspace() {
  const [invite] = useState(invitation);
  const [name, setName] = useState('Guest');
  const [access, setAccess] = useState(null);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const socket = useRef(null);
  const controller = useRef(null);
  useEffect(() => () => { controller.current?.abort(); socket.current?.close(); }, []);
  async function join(event) {
    event.preventDefault(); if (!invite || busy) return;
    setBusy(true); setConnected(false); setOutput(''); setStatus('Joining…');
    controller.current = new AbortController();
    try {
      const response = await fetch(resolveHomeApiUrl('/api/collaboration/guest/exchange'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', body: JSON.stringify({ ...invite, displayName: name }), signal: controller.current.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Invitation is unavailable');
      if (controller.current.signal.aborted) return;
      history.replaceState(null, '', window.location.pathname + window.location.search);
      setAccess(data); setStatus('Connecting…');
      const url = new URL(resolveHomeApiUrl('/api/collaboration/guest/' + encodeURIComponent(data.sessionId) + '/ws'), location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection = new WebSocket(url.href); socket.current = connection;
      connection.onopen = () => { connection.send(JSON.stringify({ type: 'auth', credential: data.credential })); setConnected(true); setStatus('Connected'); };
      connection.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'output') setOutput(previous => (previous + String(message.text || '')).slice(-500000));
          if (message.type === 'error') setStatus(message.error || 'Access denied');
        } catch { setStatus('Invalid stream message'); }
      };
      connection.onclose = () => { setConnected(false); setStatus('Disconnected. Access may have expired or been revoked.'); socket.current = null; };
      connection.onerror = () => { setConnected(false); setStatus('Connection interrupted'); };
    } catch (error) { if (!controller.current?.signal.aborted) setStatus(error.message); } finally { setBusy(false); }
  }
  return <main className="guest-workspace">
    <header><h1>Shared terminal</h1><p>Guest access is limited to one terminal. The host can revoke it at any time.</p></header>
    {!access && <form onSubmit={join}><label>Your name<input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button disabled={!invite || busy}>Join terminal</button>{!invite && <p>Invitation link is incomplete.</p>}</form>}
    {status && <p role="status">{status}</p>}
    {access && <><p>{access.role === 'controller' ? 'Controller · terminal input enabled' : 'Observer · output only'} · expires {new Date(access.expiresAt * 1000).toLocaleString()}</p><GuestTerminalOutput output={output} />
      {access.role === 'controller' && <form onSubmit={event => { event.preventDefault(); if (connected && socket.current?.readyState === WebSocket.OPEN && input) { socket.current.send(JSON.stringify({ type: 'input', text: input + '\r' })); setInput(''); } }}><label>Terminal input<input disabled={!connected} value={input} maxLength={65536} onChange={event => setInput(event.target.value)} /></label><button disabled={!connected || socket.current?.readyState !== WebSocket.OPEN || !input}>Send input</button></form>}
      <button type="button" onClick={() => { setConnected(false); socket.current?.close(); setAccess(null); setStatus('Left shared terminal. Ask the host for another invitation to rejoin.'); }}>Leave terminal</button></>}
  </main>;
}
