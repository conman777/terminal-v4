import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { replayEvents, replayTranscript, validateRecording } from '../utils/sessionReplay';
import './SessionReplayPanel.css';

function ReplayTerminal({ events, position }) {
  const container = useRef(null);
  const terminal = useRef(null);
  const renderVersion = useRef(0);
  const writes = useRef(Promise.resolve());
  const [ready, setReady] = useState(false);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([import('@xterm/xterm'), import('@xterm/xterm/css/xterm.css')]).then(([{ Terminal }]) => {
      if (cancelled) return;
      const instance = new Terminal({ disableStdin: true, cols: 100, rows: 18, scrollback: 10000, convertEol: true, theme: { background: '#111318' } });
      terminal.current = instance;
      instance.open(container.current);
      setReady(true);
    }).catch(() => { if (!cancelled) setFallback(true); });
    return () => { cancelled = true; renderVersion.current += 1; terminal.current?.dispose(); terminal.current = null; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    const version = ++renderVersion.current;
    const text = replayEvents(events, position).map(event => event.text).join('');
    writes.current = writes.current.catch(() => {}).then(() => new Promise(resolve => {
      const instance = terminal.current;
      if (!instance || version !== renderVersion.current) { resolve(); return; }
      instance.reset();
      instance.write(text, resolve);
    }));
  }, [events, position, ready]);
  return <div className="session-replay-output" aria-label="Recorded output">
    <div ref={container} hidden={fallback} />
    {fallback && <pre>{replayTranscript(events, position)}</pre>}
  </div>;
}

export function SessionReplayPanel({ workspacePath = '', sessionId = '' }) {
  const [recordings, setRecordings] = useState([]);
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [position, setPosition] = useState(0);
  const [consent, setConsent] = useState(false);
  const scope = useRef(0);
  const controller = useRef(null);
  const selected = useRef(null);
  const request = useCallback(async (suffix = '', options = {}) => {
    const response = await apiFetch('/api/recordings' + suffix, { ...options, signal: controller.current?.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Recording request failed');
    return data;
  }, []);
  const load = useCallback(async () => {
    const generation = scope.current;
    const result = await request('?' + new URLSearchParams({ workspacePath }));
    if (generation !== scope.current) return;
    setRecordings(result.recordings || []);
    if (selected.current) {
      const selectedId = selected.current;
      const next = validateRecording(await request('/' + encodeURIComponent(selectedId)));
      if (generation === scope.current && selected.current === selectedId) setRecord(next);
    }
  }, [request, workspacePath]);
  useEffect(() => {
    scope.current += 1;
    const generation = scope.current;
    controller.current = new AbortController();
    selected.current = null;
    setRecordings([]); setRecord(null); setError(''); setPlaying(false); setConsent(false); setPosition(0); setBusy(false);
    if (workspacePath) load().catch(failure => { if (generation === scope.current && !controller.current.signal.aborted) setError(failure.message); });
    const timer = workspacePath ? setInterval(() => load().catch(() => {}), 3000) : null;
    return () => { scope.current += 1; controller.current?.abort(); clearInterval(timer); };
  }, [workspacePath, load]);
  useEffect(() => setConsent(false), [sessionId]);
  const first = record?.events?.[0]?.ts ?? 0;
  const last = record?.events?.at(-1)?.ts ?? first;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setPosition(previous => {
      const next = Math.min(last, previous + 100 * speed);
      if (next >= last) setPlaying(false);
      return next;
    }), 100);
    return () => clearInterval(timer);
  }, [playing, speed, last]);
  async function perform(action) {
    const generation = scope.current;
    setBusy(true); setError('');
    try { await action(generation); }
    catch (failure) { if (generation === scope.current && !controller.current.signal.aborted) setError(failure.message); }
    finally { if (generation === scope.current) setBusy(false); }
  }
  async function choose(id, generation = scope.current) {
    setPlaying(false);
    selected.current = id || null;
    setRecord(null);
    if (!id) { setRecord(null); return; }
    const next = validateRecording(await request('/' + encodeURIComponent(id)));
    if (generation !== scope.current || selected.current !== id) return;
    setRecord(next); setPosition(next.events[0]?.ts ?? 0);
  }
  const structured = sessionId.startsWith('structured:');
  const nativeSessionId = structured ? sessionId.slice('structured:'.length) : sessionId;
  const active = recordings.find(item => item.sessionId === nativeSessionId && item.status === 'recording');
  return <div className="session-replay-panel">
    <h3>Session replay</h3>
    <p>Record terminal output or structured agent events, including existing saved output. Keystrokes are not captured separately; echoed commands and sensitive output can still appear. Recordings stay on the selected server until you delete them.</p>
    {error && <p role="alert">{error}</p>}
    <label className="session-replay-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I want to record this session’s output.</label>
    <button disabled={busy || !workspacePath || !nativeSessionId || !consent || Boolean(active)} onClick={() => perform(async generation => {
      const result = await request('', { method: 'POST', body: { sessionId: nativeSessionId, kind: structured ? 'structured' : 'terminal', workspacePath } });
      if (generation !== scope.current) return;
      await load(); await choose(result.id, generation);
    })}>Start recording</button>
    {!sessionId && <p>Select a running terminal or agent session to start recording.</p>}
    <label>Saved recording<select value={record?.id || ''} disabled={busy} onChange={event => perform(() => choose(event.target.value))}>
      <option value="">Select recording</option>
      {recordings.map(item => <option key={item.id} value={item.id}>{new Date(item.startedAt).toLocaleString()} · {item.kind} · {item.status}</option>)}
    </select></label>
    {!recordings.length && <p>No recordings in this workspace.</p>}
    {record && <section aria-label="Replay controls">
      <p role="status">{record.status}{record.receipt ? ': ' + record.receipt : ''}</p>
      <div className="session-replay-controls">
        {record.status === 'recording' && <button disabled={busy} onClick={() => perform(async () => { await request('/' + record.id + '/stop', { method: 'POST' }); await load(); })}>Stop recording</button>}
        <button disabled={last <= first} onClick={() => { if (position >= last) setPosition(first); setPlaying(value => !value); }}>{playing ? 'Pause replay' : 'Play replay'}</button>
        <label>Playback speed<select value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
        <button disabled={busy} onClick={() => perform(async () => {
          const result = validateRecording(await request('/' + record.id + '/export'));
          const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
          const href = URL.createObjectURL(blob); const anchor = document.createElement('a');
          anchor.href = href; anchor.download = 'session-recording-' + record.id + '.json'; anchor.click(); URL.revokeObjectURL(href);
        })}>Export recording</button>
        <button disabled={busy} onClick={() => perform(async generation => {
          await request('/' + record.id, { method: 'DELETE' });
          if (generation !== scope.current) return;
          selected.current = null; setRecord(null); setPlaying(false); await load();
        })}>Delete recording</button>
      </div>
      <label>Replay position<input type="range" min={first} max={Math.max(first + 1, last)} value={Math.max(first, Math.min(position, last))} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} /></label>
      <span>{Math.max(0, (position - first) / 1000).toFixed(1)} / {((last - first) / 1000).toFixed(1)} seconds</span>
      <ReplayTerminal key={record.id} events={record.events} position={position} />
      <p>Export removes known credential patterns and terminal formatting. Review exported files before sharing; automatic redaction cannot detect every secret.</p>
    </section>}
  </div>;
}
