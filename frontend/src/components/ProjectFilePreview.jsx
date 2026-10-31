import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { environmentAllows } from '../utils/runtimePermissions';
import { validProjectFilePath } from '../utils/projectFileReference';
import './ProjectFilePreview.css';

export function validProjectFilePreview(data, root, file) {
  return data?.root === root && data.path === file.path && data.line === file.line
    && Number.isSafeInteger(data.totalLines) && data.totalLines >= 0
    && Array.isArray(data.lines) && data.lines.length <= 15
    && (data.totalLines === 0 ? file.line === 1 && data.lines.length === 0
      : data.totalLines >= file.line && data.lines.some(row => row?.line === file.line))
    && data.lines.every((row, index) => Number.isSafeInteger(row?.line) && row.line >= 1 && row.line <= data.totalLines
      && (!index || row.line === data.lines[index - 1].line + 1) && typeof row.text === 'string'
      && row.text.length <= 1000 && Array.from(row.text).length <= 500 && typeof row.truncated === 'boolean');
}

function copyWithSelection(text) {
  if (typeof document.execCommand !== 'function') return false;
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.setAttribute('aria-hidden', 'true');
  Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0' });
  document.body.appendChild(field);
  try { field.focus(); field.select(); return document.execCommand('copy'); }
  catch { return false; }
  finally { field.remove(); if (previous?.isConnected) previous.focus?.({ preventScroll: true }); }
}

export function ProjectFilePreview({ sessionId, root, file, onClose, onShowInFiles }) {
  const fileScope = JSON.stringify([sessionId, root, file.path, file.line]);
  const [navigation, setNavigation] = useState({ fileScope, line: file.line, previousLine: null, attempt: 0 });
  const page = navigation.fileScope === fileScope ? navigation : { fileScope, line: file.line, previousLine: null, attempt: 0 };
  const scope = JSON.stringify([fileScope, page.line, page.attempt]);
  const [state, setState] = useState({ scope, phase: 'loading' });
  const visibleState = state.scope !== scope ? { phase: 'loading' }
    : state.auth && (!isAuthScopeCurrent(state.auth) || state.environment.aborted || !environmentAllows(getActiveEnvironment(), 'transfer'))
      ? { phase: 'unavailable' } : state;
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const lineRef = useRef(null);
  const linesRef = useRef(null);
  const retryRef = useRef(null);
  const restoreAfterRetry = useRef(false);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(false);
  const [copyState, setCopyState] = useState(null);
  const [revealError, setRevealError] = useState(null);
  const copyStatus = copyState?.scope === scope ? copyState.phase : null;
  const location = `${root.replace(/\/+$/, '')}/${file.path}:${page.line}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (visibleState.phase === 'ready') lineRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [visibleState.phase, scope]);
  useLayoutEffect(() => {
    if (visibleState.phase === 'error') retryRef.current?.focus({ preventScroll: true });
    if (visibleState.phase === 'ready' && restoreAfterRetry.current) {
      restoreAfterRetry.current = false;
      linesRef.current?.focus({ preventScroll: true });
    }
  }, [visibleState.phase, scope]);
  useEffect(() => {
    const opener = document.activeElement;
    const auth = captureAuthScope();
    const environment = getEnvironmentSignal();
    restoreAfterRetry.current = false;
    closeRef.current?.focus();
    return () => {
      if (isAuthScopeCurrent(auth) && !environment.aborted && opener?.isConnected && !opener.closest?.('[inert], [hidden], [aria-hidden="true"]')) opener.focus?.({ preventScroll: true });
    };
  }, [fileScope]);
  useEffect(() => {
    const auth = captureAuthScope();
    const environment = getEnvironmentSignal();
    const controller = new AbortController();
    let active = true;
    const current = () => active && Boolean(auth.userId) && !controller.signal.aborted && !environment.aborted && isAuthScopeCurrent(auth)
      && environmentAllows(getActiveEnvironment(), 'transfer');
    const retire = () => { if (!current()) { controller.abort(); if (active) setState({ scope, phase: 'unavailable' }); } };
    const unsubscribeAuth = subscribeAuth(retire);
    const unsubscribeEnvironment = subscribeEnvironment(retire);
    if (!sessionId || !validProjectFilePath(file.path, root)
      || !Number.isSafeInteger(page.line) || page.line < 1 || page.line > 1_000_000 || !current()) {
      setState({ scope, phase: 'unavailable' });
    } else {
      const params = new URLSearchParams({ sessionId, root, path: file.path, line: String(page.line), query: '' });
      apiFetch(`/api/workspace/files/read-content?${params}`, { signal: controller.signal, cache: 'no-store' })
        .then(async response => {
          const value = await response.json().catch(() => null);
          if (!response.ok) throw new Error(value?.error || 'Could not open this file.');
          if (!validProjectFilePreview(value, root, { path: file.path, line: page.line })) throw new Error('File preview returned an invalid response.');
          if (current()) setState({ scope, fileScope, auth, environment, phase: 'ready', data: value });
        }).catch(error => { if (current()) setState({ scope, phase: 'error', message: error.message || 'Could not open this file.' }); });
    }
    return () => {
      active = false;
      controller.abort();
      unsubscribeAuth(); unsubscribeEnvironment();
    };
  }, [sessionId, root, file.path, page.line, page.attempt, fileScope]);

  async function copyLocation() {
    if (visibleState.phase !== 'ready' || copyStatus === 'copying') return;
    const auth = captureAuthScope(), environment = getEnvironmentSignal();
    const current = () => mounted.current && scopeRef.current === scope && !environment.aborted
      && isAuthScopeCurrent(auth) && environmentAllows(getActiveEnvironment(), 'transfer');
    if (!current()) return;
    setCopyState({ scope, phase: 'copying' });
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(location); copied = true; }
    } catch { /* Fall back to selection when the clipboard API is unavailable. */ }
    if (!current()) return;
    if (!copied) copied = copyWithSelection(location);
    if (current()) setCopyState({ scope, phase: copied ? 'copied' : 'failed' });
  }

  function showInFiles() {
    if (visibleState.phase !== 'ready' || !isAuthScopeCurrent(visibleState.auth)
      || visibleState.environment.aborted || !environmentAllows(getActiveEnvironment(), 'transfer')) return;
    try {
      if (onShowInFiles?.({ sessionId, root, file: { path: file.path, line: page.line } }) === false) {
        setRevealError({ scope, message: 'This thread or workspace changed. Reopen the file before continuing.' });
      } else onClose();
    } catch { setRevealError({ scope, message: 'Could not open project files. Try again.' }); }
  }

  function keyboard(event) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialogRef.current.querySelectorAll('button, input, [tabindex="0"]')].filter(node => !node.disabled);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0].focus(); }
  }
  const ready = visibleState.phase === 'ready' ? visibleState.data : null;
  const previousData = visibleState.phase === 'loading' && state.fileScope === fileScope
    && state.phase === 'ready' && isAuthScopeCurrent(state.auth) && !state.environment.aborted ? state.data : null;
  const displayData = ready || previousData;
  const first = displayData?.lines[0]?.line;
  const last = displayData?.lines.at(-1)?.line;
  const showNavigation = displayData?.lines.length > 0 && (displayData.totalLines > displayData.lines.length || page.line !== file.line);
  function changePage(direction) {
    if (!ready?.lines.length) return;
    const start = ready.lines[0].line, end = ready.lines.at(-1).line;
    if (direction === 'previous' && start > 1) setNavigation({ fileScope, line: Math.max(1, start - 8), previousLine: page.line, attempt: 0 });
    if (direction === 'next' && end < ready.totalLines) setNavigation({ fileScope, line: Math.min(ready.totalLines, end + 8), previousLine: page.line, attempt: 0 });
  }
  return createPortal(<div className="project-file-preview-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-file-preview" role="dialog" aria-modal="true" aria-label={`File preview: ${file.path}, line ${page.line}`} ref={dialogRef} onKeyDown={keyboard}>
      <header><strong>{file.path}:{page.line}</strong><button type="button" ref={closeRef} onClick={onClose} aria-label="Close file preview">×</button></header>
      {visibleState.phase === 'loading' && <p role="status">Opening file…</p>}
      {visibleState.phase === 'unavailable' && <p role="status">This file preview is no longer available in the current account or environment.</p>}
      {visibleState.phase === 'error' && <p role="alert">{visibleState.message}</p>}
      {visibleState.phase === 'error' && <div className="project-file-preview-recovery">
        <button type="button" ref={retryRef} onClick={() => { restoreAfterRetry.current = true; setNavigation({ ...page, attempt: page.attempt + 1 }); }}>Retry</button>
        {page.previousLine && <button type="button" onClick={() => { restoreAfterRetry.current = true; setNavigation({ fileScope, line: page.previousLine, previousLine: null, attempt: 0 }); }}>Return to previous lines</button>}
        {page.line > 1 && page.previousLine !== 1 && <button type="button" onClick={() => { restoreAfterRetry.current = true; setNavigation({ fileScope, line: 1, previousLine: null, attempt: 0 }); }}>Go to first line</button>}
      </div>}
      {showNavigation && <nav className="project-file-preview-navigation" aria-label="File lines">
        <button type="button" aria-label="Previous lines" aria-disabled={!ready || first <= 1} onClick={() => changePage('previous')}>Previous</button>
        <span aria-live="polite" aria-atomic="true">{ready ? `Lines ${first}–${last} of ${displayData.totalLines}` : 'Loading lines…'}</span>
        <button type="button" aria-label="Next lines" aria-disabled={!ready || last >= displayData.totalLines} onClick={() => changePage('next')}>Next</button>
      </nav>}
      {visibleState.phase === 'ready' && <div ref={linesRef} className="project-file-preview-lines" role="region" aria-label="File lines" tabIndex={0}>
        {visibleState.data.totalLines === 0 && <p className="project-file-preview-empty">This file is empty.</p>}
        {visibleState.data.lines.map(row => <div key={row.line} ref={row.line === page.line ? lineRef : undefined}><span>{row.line}</span><code aria-current={row.line === page.line ? 'true' : undefined}>{row.text}{row.truncated ? '…' : ''}</code></div>)}
      </div>}
      {visibleState.phase === 'ready' && <footer>
        {onShowInFiles && <button type="button" onClick={showInFiles}>Show in Files</button>}
        <button type="button" aria-label="Copy file location" aria-disabled={copyStatus === 'copying'} onClick={copyLocation}>Copy location</button>
        {copyStatus === 'copied' && <span role="status">Location copied</span>}
        {copyStatus === 'failed' && <><span role="status">Could not copy. Select the location below.</span>
          <input aria-label="File location" readOnly value={location} onFocus={event => event.currentTarget.select()} /></>}
        {revealError?.scope === scope && <span role="alert">{revealError.message}</span>}
      </footer>}
    </section>
  </div>, document.body);
}
