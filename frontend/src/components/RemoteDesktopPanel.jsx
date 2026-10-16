import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { desktopKey, desktopPoint } from '../utils/remoteDesktop';
import './RemoteDesktopPanel.css';

async function request(path, options = {}) {
  const response = await apiFetch(path, { ...options, home: true });
  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Desktop request failed');
  }
  return response.json();
}

function DesktopSurface({ environment }) {
  const base = environment ? '/api/environments/' + encodeURIComponent(environment.id) + '/proxy/api/desktop' : '/api/desktop';
  const [status, setStatus] = useState(null);
  const [monitor, setMonitor] = useState('');
  const [session, setSession] = useState(null);
  const [frame, setFrame] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [text, setText] = useState('');
  const lifecycle = useRef(null);
  const sessionRef = useRef(null);
  const frameRef = useRef('');
  const sending = useRef(false);
  const viewAllowed = !environment || environment.capabilities?.desktopView;
  const controlAllowed = status?.control && (!environment || environment.capabilities?.desktopControl);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    if (!viewAllowed) {
      setError('Desktop viewing permission is required. Pair this device with an explicit desktop viewing grant.');
    } else {
      request(base + '/status', { signal: controller.signal }).then(value => {
        if (controller.signal.aborted) return;
        setStatus(value);
        setMonitor(value.monitors?.find(display => display.primary)?.id || value.monitors?.[0]?.id || '');
      }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    }
    return () => {
      controller.abort();
      if (frameRef.current) URL.revokeObjectURL(frameRef.current);
      const active = sessionRef.current;
      if (active) request(base + '/sessions/' + active.id, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
  }, [base, viewAllowed]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let timer;
    setStreaming(true);
    async function poll() {
      try {
        const response = await apiFetch(base + '/sessions/' + session.id + '/frame', { home: true, signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || 'Desktop stream stopped');
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const next = URL.createObjectURL(blob);
        if (frameRef.current) URL.revokeObjectURL(frameRef.current);
        frameRef.current = next;
        setFrame(next);
        timer = setTimeout(poll, 1100);
      } catch (err) {
        if (!controller.signal.aborted) { setError(err.message); setStreaming(false); setControl(false); }
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); setStreaming(false); };
  }, [base, session]);

  async function start() {
    setError(''); setBusy(true);
    try {
      const value = await request(base + '/sessions', { method: 'POST', body: { monitor }, signal: lifecycle.current.signal });
      if (lifecycle.current.signal.aborted) return;
      sessionRef.current = value; setSession(value);
    } catch (err) { if (!lifecycle.current.signal.aborted) setError(err.message); }
    finally { if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  async function stop() {
    const active = sessionRef.current;
    sessionRef.current = null;
    setSession(null); setControl(false); setFrame(''); setStreaming(false);
    if (frameRef.current) { URL.revokeObjectURL(frameRef.current); frameRef.current = ''; }
    if (active) {
      try { await request(base + '/sessions/' + active.id, { method: 'DELETE', signal: lifecycle.current.signal }); }
      catch (err) { if (!lifecycle.current.signal.aborted) setError(err.message); }
    }
  }
  async function send(value) {
    if (!control || !controlAllowed || !session || !streaming || sending.current) return;
    sending.current = true;
    try {
      await request(base + '/sessions/' + session.id + '/input', { method: 'POST', body: value, signal: lifecycle.current.signal });
    } catch (err) {
      if (!lifecycle.current.signal.aborted) { setError(err.message); setControl(false); }
    } finally { sending.current = false; }
  }
  function pointer(event, action = 'click') {
    if (!control) return;
    const point = desktopPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (point) send({ kind: 'pointer', ...point, action });
  }
  function keyboard(event) {
    if (!control) return;
    if (event.key === 'Escape') { event.preventDefault(); setControl(false); return; }
    const value = desktopKey(event);
    if (value) { event.preventDefault(); send(value); }
  }
  return <section className="remote-desktop" aria-label="Remote desktop">
    <h3>Desktop · {environment?.label || 'This host'}</h3>
    <p>View the interactive Windows desktop alongside your terminal. Images refresh approximately once per second; this is a basic desktop viewer.</p>
    <p>Viewing and input require explicit host opt-in and matching device permissions. Secure login screens, elevated applications, and computers without an interactive Windows session may be unavailable.</p>
    {error && <p role="alert">{error}</p>}
    {status && !status.available && <p>{status.message || 'The desktop helper is unavailable on this host.'}</p>}
    {status?.available && !session && <div className="remote-desktop-toolbar">
      <label>Display<select value={monitor} onChange={event => setMonitor(event.target.value)}>{status.monitors.map(display => <option key={display.id} value={display.id}>{display.label} · {display.width} × {display.height}</option>)}</select></label>
      <button disabled={busy || !monitor} onClick={start}>Start viewing</button>
    </div>}
    {session && <>
      <div className="remote-desktop-toolbar">
        <span role="status">{streaming ? 'Viewing desktop' : 'Desktop stream stopped'} · expires {new Date(session.expiresAt * 1000).toLocaleTimeString()}</span>
        <button onClick={stop}>Stop viewing</button>
        {controlAllowed && <label><input type="checkbox" checked={control} disabled={!streaming} onChange={event => setControl(event.target.checked)} />Enable remote keyboard and pointer control</label>}
      </div>
      {control && <p className="remote-desktop-control-warning">Your clicks and keys act on {environment?.label || 'this computer'}. Focus the image to type. Press Escape to disable control.</p>}
      {frame ? <img className={control ? 'remote-desktop-frame controlling' : 'remote-desktop-frame'} src={frame} alt="Live remote Windows desktop" tabIndex={control ? 0 : -1} onPointerUp={event => { if (event.button === 0) pointer(event); }} onContextMenu={event => { if (control) { event.preventDefault(); pointer(event, 'rightClick'); } }} onKeyDown={keyboard} draggable={false} /> : <p>Waiting for the first desktop image…</p>}
      {control && <form className="remote-desktop-toolbar" onSubmit={event => { event.preventDefault(); if (text) send({ kind: 'text', text }); }}>
        <label>Text to type on the remote computer<input value={text} maxLength={256} onChange={event => setText(event.target.value)} /></label><button disabled={!text || !streaming} type="submit">Type text</button>
        <button type="button" onClick={() => send({kind:'key',key:'Escape',modifiers:[]})}>Send Escape</button>
      </form>}
    </>}
    <small>Host setting: TERMINAL_V4_DESKTOP_ACCESS=view or control. Access is off by default. Desktop sessions expire after 10 minutes.</small>
  </section>;
}
export default function RemoteDesktopPanel() {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  return <DesktopSurface key={environment?.id || 'home'} environment={environment} />;
}
