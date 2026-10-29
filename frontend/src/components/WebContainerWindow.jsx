import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import LoginPage from './LoginPage';
import { WebContainerPreview } from './WebContainerPreview';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { subscribeEnvironment } from '../utils/remoteEnvironments';
import { disposeWebContainer, isWebContainerSupported } from '../utils/webcontainer';
import { claimWebContainerLaunch, isWebContainerLaunchCurrent, readWebContainerExport, validateWebContainerFiles } from '../utils/webcontainerWindow';
import './WebContainerWindow.css';

export function WebContainerRunner() {
  const { user, loading } = useAuth();
  const [launch, setLaunch] = useState(null);
  const [files, setFiles] = useState(null);
  const [omissions, setOmissions] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('Ready to load project');
  const [logs, setLogs] = useState([]);
  const launchRef = useRef(null);
  const operationRef = useRef(null);
  const liveRef = useRef(true);
  const claimStartedRef = useRef(false);
  const retirementRef = useRef(Promise.resolve());
  const launchIdRef = useRef(window.location.hash.slice(1));
  const support = isWebContainerSupported();

  const retire = useCallback(() => {
    operationRef.current?.abort();
    operationRef.current = null;
    setRunning(false); setFiles(null); setLogs([]); setOmissions(null); setBusy(false);
    const pending = disposeWebContainer();
    retirementRef.current = pending;
    pending.catch(() => { if (liveRef.current) setError('The runtime could not stop. Close this window before starting another project.'); });
    return pending;
  }, []);

  const revoke = useCallback(() => {
    launchRef.current = null;
    setLaunch(null);
    setError('The project account or environment changed. Open a new WebContainer window from the normal app.');
    void retire();
  }, [retire]);

  const isScopeCurrent = useCallback(() => {
    const current = liveRef.current && launchRef.current && isWebContainerLaunchCurrent(launchRef.current);
    if (!current && liveRef.current && launchRef.current) revoke();
    return Boolean(current);
  }, [revoke]);

  useEffect(() => {
    liveRef.current = true;
    const check = () => { if (launchRef.current) isScopeCurrent(); };
    const unsubscribeAuth = subscribeAuth(check);
    const unsubscribeEnvironment = subscribeEnvironment(check);
    window.addEventListener('storage', check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    const onPageHide = () => { launchRef.current = null; void retire(); };
    window.addEventListener('pagehide', onPageHide);
    const timer = setInterval(check, 1000);
    return () => {
      liveRef.current = false; operationRef.current?.abort(); launchRef.current = null;
      unsubscribeAuth(); unsubscribeEnvironment();
      window.removeEventListener('storage', check); window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check); window.removeEventListener('pagehide', onPageHide);
      clearInterval(timer); void disposeWebContainer().catch(() => {});
    };
  }, [isScopeCurrent, retire]);

  useEffect(() => {
    if (loading || !user || !support.supported || claimStartedRef.current) return;
    claimStartedRef.current = true;
    const scope = captureAuthScope();
    const current = () => liveRef.current && isAuthScopeCurrent(scope);
    if (window.location.search) { setError('Launch URLs accept only a project launch ID in the fragment. Open a new launch from the app.'); return; }
    void (async () => {
      try {
        if (!current()) return;
        const record = await claimWebContainerLaunch(launchIdRef.current);
        if (!current() || !isWebContainerLaunchCurrent(record)) throw new Error('The project account or environment changed. Open a new launch from the app.');
        launchRef.current = record; setLaunch(record);
        window.history.replaceState(null, '', window.location.pathname);
      } catch (failure) {
        if (liveRef.current) setError(failure.message || 'Unable to claim this project launch.');
      }
    })();
  }, [loading, user?.id, support.supported]);

  const run = useCallback(async () => {
    if (!isScopeCurrent() || operationRef.current) return;
    const controller = new AbortController();
    operationRef.current = controller; setBusy(true); setError(''); setLogs([]); setPhase('Loading safe project files…');
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!isScopeCurrent()) throw new DOMException('The project account or environment changed', 'AbortError');
    };
    try {
      assertCurrent(); await retirementRef.current; assertCurrent();
      const record = launchRef.current;
      assertCurrent();
      const response = await apiFetch(`/api/webcontainer/files?path=${encodeURIComponent(record.projectPath)}`, { signal: controller.signal });
      assertCurrent();
      if (!response.ok) throw new Error(`Unable to export project files (${response.status}).`);
      assertCurrent(); const exported = await readWebContainerExport(response, { signal: controller.signal, assertCurrent }); assertCurrent();
      const tree = validateWebContainerFiles(exported.files);
      const omitted = exported.omissions || { total: 0, entries: [], truncated: false };
      if (!Number.isSafeInteger(omitted.total) || omitted.total < 0 || !Array.isArray(omitted.entries) || omitted.entries.length > 100 || omitted.entries.some(entry => typeof entry.path !== 'string' || entry.path.length > 512)) throw new Error('Invalid private-file omission metadata.');
      assertCurrent(); setFiles(tree); setOmissions(omitted);
      if (omitted.total > 0) setPhase('Review omitted private files before running');
      else { setRunning(true); setPhase('Starting WebContainer…'); }
    } catch (failure) {
      if (!controller.signal.aborted && liveRef.current && isScopeCurrent()) { setFiles(null); setError(failure.message || 'Unable to load this project.'); setPhase('Error'); }
    } finally {
      if (operationRef.current === controller) { operationRef.current = null; if (liveRef.current) setBusy(false); }
    }
  }, [isScopeCurrent]);

  if (loading) return <main className="webcontainer-window"><p role="status">Checking your account…</p></main>;
  if (!user) return <LoginPage />;

  return (
    <main className="webcontainer-window">
      <header className="webcontainer-window-header">
        <h1>WebContainer</h1>
        <a href="/" onClick={() => { void retire(); }}>Return to normal app</a>
      </header>
      {!support.supported && <p role="alert">{support.reason} Ask your app host to enable the isolated /webcontainer document, then reopen it from the normal app.</p>}
      {error && <p role="alert">{error}</p>}
      {launch && <>
        <dl className="webcontainer-project-identity">
          <dt>Home project</dt><dd>{launch.projectPath}</dd>
          <dt>Start command</dt><dd><code>{launch.startCommand}</code></dd>
        </dl>
        <p>This window stays pinned to this project. Project code and npm scripts run in the hosted browser runtime; known private configuration and keys are excluded from the export.</p>
        <div className="webcontainer-window-actions">
          <button type="button" disabled={!support.supported || busy || running} onClick={run}>{error ? 'Retry' : 'Run'}</button>
          <button type="button" disabled={!busy && !running && !files} onClick={() => { setError(''); setPhase('Stopped'); void retire(); }}>Stop</button>
          {!running && files && omissions?.total > 0 && <button type="button" onClick={() => { if (isScopeCurrent()) { setError(''); setRunning(true); } }}>Run exported files</button>}
        </div>
        <p role="status">{phase}</p>
        {omissions?.total > 0 && <section className="webcontainer-omissions" aria-label="Omitted private files">
          <h2>{omissions.total} private entries omitted</h2>
          <p>Required configuration may be missing. Review this list before running; use proxy preview when the project requires these files.</p>
          <ul>{omissions.entries.map((entry, index) => <li key={index}>{entry.path}</li>)}</ul>
          {omissions.truncated && <p>The list is limited to 100 paths.</p>}
        </section>}
        {running && files && <WebContainerPreview
          projectFiles={files}
          startCommand={launch.startCommand}
          isScopeCurrent={isScopeCurrent}
          onStatusChange={(_status, message) => { if (isScopeCurrent()) setPhase(message); }}
          onError={failure => { if (isScopeCurrent()) { setError(failure.message); setPhase('Error'); void retire(); } }}
          onConsoleLog={entry => { if (isScopeCurrent()) setLogs(previous => [...previous.slice(-99), String(entry.text).slice(0,4096)]); }}
        />}
        {logs.length > 0 && <section className="webcontainer-window-logs" aria-label="Runtime output"><h2>Runtime output</h2><pre>{logs.join('\n')}</pre></section>}
      </>}
    </main>
  );
}

export default function WebContainerWindow() {
  return <AuthProvider><WebContainerRunner /></AuthProvider>;
}
