import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { desktopKey, desktopPoint } from '../utils/remoteDesktop';
import './RemoteAccess.css';
import './RemoteDesktopPanel.css';

async function request(path, options = {}) {
  const response = await apiFetch(path, { ...options, home: true });
  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || 'Desktop request failed'), { status: response.status });
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
  const [stopping, setStopping] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const lifecycle = useRef(null);
  const sessionRef = useRef(null);
  const frameRef = useRef('');
  const inputWorker = useRef(null);
  const inputQueue = useRef([]);
  const controlRef = useRef(false);
  const changingSession = useRef(false);
  const viewAllowed = !environment || environment.capabilities?.desktopView;
  const controlAllowed = status?.control && (!environment || environment.capabilities?.desktopControl);

  async function loadStatus(controller = lifecycle.current) {
    if (!controller || controller.signal.aborted || !viewAllowed) return;
    setLoadingStatus(true); setError('');
    try {
      const value = await request(base + '/status', { signal: controller.signal });
      if (controller.signal.aborted) return;
      setStatus(value);
      setMonitor(value.monitors?.find(display => display.primary)?.id || value.monitors?.[0]?.id || '');
    } catch (err) { if (!controller.signal.aborted) setError(err.message); }
    finally { if (!controller.signal.aborted) setLoadingStatus(false); }
  }

  function disableControl() {
    controlRef.current = false; inputWorker.current = null; inputQueue.current = []; setControl(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    if (!viewAllowed) {
      setLoadingStatus(false);
      setError('Desktop viewing permission is required. Pair this device with an explicit desktop viewing grant.');
    } else {
      void loadStatus(controller);
    }
    return () => {
      controller.abort();
      inputQueue.current = []; controlRef.current = false;
      if (frameRef.current) URL.revokeObjectURL(frameRef.current);
      const active = sessionRef.current;
      if (active) request(base + '/sessions/' + active.id, { method: 'DELETE', keepalive: true }).catch(() => {});
    };
  }, [base, viewAllowed]);

  useEffect(() => {
    if (!session || stopping) return;
    const controller = new AbortController();
    let timer;
    setStreaming(true);
    async function poll() {
      try {
        const response = await apiFetch(base + '/sessions/' + session.id + '/frame', { home: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 409) { timer = setTimeout(poll, 150); return; }
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
        if (!controller.signal.aborted) { setError(err.message); setStreaming(false); disableControl(); }
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); setStreaming(false); };
  }, [base, session, stopping]);

  async function start() {
    if (changingSession.current || sessionRef.current) return;
    changingSession.current = true;
    setError(''); setBusy(true);
    try {
      const value = await request(base + '/sessions', { method: 'POST', body: { monitor }, signal: lifecycle.current.signal });
      if (lifecycle.current.signal.aborted) return;
      sessionRef.current = value; setSession(value);
    } catch (err) { if (!lifecycle.current.signal.aborted) setError(err.message); }
    finally { changingSession.current = false; if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  async function stop() {
    const active = sessionRef.current;
    if (!active || changingSession.current) return;
    changingSession.current = true;
    setBusy(true); setError(''); setStopping(true); disableControl(); setFrame(''); setStreaming(false);
    if (frameRef.current) { URL.revokeObjectURL(frameRef.current); frameRef.current = ''; }
    try {
      await request(base + '/sessions/' + active.id, { method: 'DELETE', signal: lifecycle.current.signal });
      if (lifecycle.current.signal.aborted) return;
      sessionRef.current = null; setSession(null); setStopping(false);
    } catch (err) {
      if (!lifecycle.current.signal.aborted) {
        if (err.status === 404) { sessionRef.current = null; setSession(null); setStopping(false); }
        else setError(err.message + '. Retry stopping to confirm cleanup.');
      }
    }
    finally { changingSession.current = false; if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  async function send(value) {
    if (!controlRef.current || !controlAllowed || !session || !streaming) return;
    const active = sessionRef.current;
    const controller = lifecycle.current;
    inputQueue.current.push(value);
    if (inputWorker.current?.session === active) return;
    const worker = { session: active };
    inputWorker.current = worker;
    try {
      while (inputQueue.current.length && inputWorker.current === worker && controlRef.current && sessionRef.current === active && !controller.signal.aborted) {
        const next = inputQueue.current.shift();
        let attempts = 0;
        while (inputWorker.current === worker && controlRef.current && sessionRef.current === active && !controller.signal.aborted) {
          try {
            await request(base + '/sessions/' + active.id + '/input', { method: 'POST', body: next, signal: controller.signal });
            break;
          } catch (err) {
            if (err.status !== 409 || ++attempts >= 5) throw err;
            await new Promise(resolve => setTimeout(resolve, 150));
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted && inputWorker.current === worker && sessionRef.current === active) { setError(err.message + '. Remote control paused; unsent input was discarded. Enable control to retry.'); disableControl(); }
    } finally { if (inputWorker.current === worker) inputWorker.current = null; }
  }
  function pointer(event, action = 'click') {
    if (!control) return;
    const point = desktopPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (point) send({ kind: 'pointer', ...point, action });
  }
  function keyboard(event) {
    if (!control) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); disableControl(); return; }
    const value = desktopKey(event);
    if (value) { event.preventDefault(); send(value); }
  }
  // Desktop sharing only exists on Windows hosts; elsewhere the panel would only say so.
  if (status?.platform && status.platform !== 'windows') return null;
  return <section className="remote-access-panel remote-desktop" aria-label="Remote desktop">
    <h3>Desktop · {environment?.label || 'This host'}</h3>
    <p>View the interactive Windows desktop alongside your terminal. Images refresh approximately once per second; this is a basic desktop viewer.</p>
    <p>Viewing and input require explicit host opt-in and matching device permissions. Secure login screens, elevated applications, and computers without an interactive Windows session may be unavailable.</p>
    {error && <p role="alert">{error}</p>}
    {loadingStatus && <p role="status">Checking desktop availability…</p>}
    {viewAllowed && !status?.available && !session && <button type="button" disabled={loadingStatus} onClick={() => void loadStatus()}>{status ? 'Refresh desktop status' : 'Retry desktop status'}</button>}
    {status && !status.available && <p>{status.message || 'The desktop helper is unavailable on this host.'}</p>}
    {status?.available && !session && <div className="remote-desktop-toolbar">
      <label>Display<select value={monitor} onChange={event => setMonitor(event.target.value)}>{status.monitors.map(display => <option key={display.id} value={display.id}>{display.label} · {display.width} × {display.height}</option>)}</select></label>
      <button disabled={busy || !monitor} onClick={start}>Start viewing</button>
    </div>}
    {session && <>
      <div className="remote-desktop-toolbar">
        <span role="status">{streaming ? 'Viewing desktop' : 'Desktop stream stopped'} · expires {new Date(session.expiresAt * 1000).toLocaleTimeString()}</span>
        <button disabled={busy} onClick={stop}>{busy ? 'Stopping…' : stopping ? 'Retry stopping' : 'Stop viewing'}</button>
        {controlAllowed && <label><input type="checkbox" checked={control} disabled={!streaming || stopping} onChange={event => { if (event.target.checked) { controlRef.current = true; setControl(true); } else disableControl(); }} />Enable remote keyboard and pointer control</label>}
      </div>
      {control && <p className="remote-desktop-control-warning">Your clicks and keys act on {environment?.label || 'this computer'}. Focus the image to type. Press Escape to disable control.</p>}
      {frame ? <img className={control ? 'remote-desktop-frame controlling' : 'remote-desktop-frame'} src={frame} alt="Live remote Windows desktop" tabIndex={control ? 0 : -1} onPointerUp={event => { if (event.button === 0) pointer(event); }} onContextMenu={event => { if (control) { event.preventDefault(); pointer(event, 'rightClick'); } }} onKeyDown={keyboard} draggable={false} /> : <p>{stopping ? 'Viewing stopped locally; server cleanup needs confirmation.' : 'Waiting for the first desktop image…'}</p>}
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
