import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { browserAddress, browserPoint } from '../utils/workspaceBrowser';
import { getBrowserToolDisplayInfo } from '../utils/browserToolPresentation';
import { useBrowserApprovals } from '../hooks/useBrowserApprovals';
import './WorkspaceBrowser.css';
import { PreviewIcon } from './preview/PreviewIcon';

const BASE = '/api/workspace-browser/sessions';
function viewportSize(rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { width: Math.min(1920, Math.max(320, Math.floor(rect.width))), height: Math.min(1200, Math.max(240, Math.floor(rect.height))) };
}
function newPointerGesture() {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16)).join('-');
}
async function request(path, options = {}) {
  const response = await apiFetch(path, { ...options, home: true, cache: 'no-store' });
  if (response.status === 204) return null;
  const value = await response.json();
  if (!response.ok) { const error = new Error(value.error || 'Browser request failed.'); error.status = response.status; throw error; }
  return value;
}

export default function WorkspaceBrowser({ onClose, isExpanded = false, onToggleExpanded }) {
  const [session, setSession] = useState(null);
  const [state, setState] = useState({ tabs: [], activeTabId: null, dialog: null });
  const [image, setImage] = useState('');
  const [size, setSize] = useState({ width: 1280, height: 800 });
  const [resizing, setResizing] = useState(false);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [typingPending, setTypingPending] = useState(false);
  const [typingOpen, setTypingOpen] = useState(() => window.matchMedia?.('(max-width: 600px), (pointer: coarse)').matches || false);
  const typingId = useId();
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 600px), (pointer: coarse)');
    const update = event => setTypingOpen(event.matches);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  const [prompt, setPrompt] = useState('');
  useEffect(() => { setPrompt(state.dialog?.defaultValue || ''); }, [state.dialog?.id, state.dialog?.defaultValue]);
  const [generation, setGeneration] = useState(0);
  const pendingApprovals = useBrowserApprovals();
  const [resolvedApprovals, setResolvedApprovals] = useState([]);
  const approvals = pendingApprovals.filter(row => !resolvedApprovals.includes(row.id));
  const [deciding, setDeciding] = useState('');
  const lifecycle = useRef(null), sessionRef = useRef(null), addressRef = useRef(null), surfaceRef = useRef(null), closeRef = useRef(null);
  const queue = useRef(Promise.resolve()), queued = useRef(0), dragging = useRef(false), lastMove = useRef(0);
  const touch = useRef(null), lastPoint = useRef(null);
  const scrollSequence = useRef(null), inputSequence = useRef(null);
  const resizeFence = useRef(null), pressedButton = useRef('left');
  const requestResize = useRef(null);
  const observedSurface = useRef(null);
  const pointerGesture = useRef(null), pointerCancel = useRef(null);
  const outstandingGestures = useRef(new Set());
  const dialogRef = useRef(null);
  dialogRef.current = state.dialog;
  const stateRevision = useRef(0), mutationPending = useRef(false);
  const displayedDocument = useRef('');
  const active = state.tabs.find(tab => tab.id === state.activeTabId);
  const frameBinding = useRef(null);
  frameBinding.current = active?.documentId ? { tabId: state.activeTabId, documentId: active.documentId, width: size.width, height: size.height, ...(Number.isSafeInteger(size.revision) ? { revision: size.revision } : {}) } : null;
  const agentHasControl = state.control?.owner === 'agent';
  const takeoverPending = state.control?.owner === 'human_pending';
  const inputBlocked = agentHasControl || takeoverPending;
  const apply = useCallback(value => {
    const tab = value.tabs.find(tab => tab.id === value.activeTabId);
    const documentKey = `${value.activeTabId || ''}:${tab?.documentId || ''}`;
    if (displayedDocument.current !== documentKey) {
      displayedDocument.current = documentKey;
      setImage('');
    }
    setState(value);
    if (document.activeElement !== addressRef.current) {
      setAddress(tab?.url === 'about:blank' ? '' : tab?.url || '');
    }
  }, []);
  const changeState = useCallback(async (path, options, id) => {
    const revision = ++stateRevision.current;
    mutationPending.current = true;
    try {
      const value = await request(path, options);
      if (revision !== stateRevision.current || options.signal?.aborted || sessionRef.current !== id) return null;
      apply(value);
      return value;
    } catch (error) {
      if (revision === stateRevision.current && !options.signal?.aborted && sessionRef.current === id) throw error;
      return null;
    } finally {
      if (revision === stateRevision.current) {
        stateRevision.current++;
        mutationPending.current = false;
      }
    }
  }, [apply]);

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    setError(''); setStreamError(''); setBusy(true); setImage(''); setResizing(false); resizeFence.current = null; pointerCancel.current = null; pointerGesture.current = null; sessionRef.current = null; setSession(null);
    request(BASE, { method: 'POST', signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      sessionRef.current = value.id; setSession(value.id); apply(value.state);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => {
      const id = sessionRef.current;
      if (id) for (const gestureId of outstandingGestures.current) {
        void request(`${BASE}/${id}/command`, { method: 'POST', body: { type: 'pointer', action: 'cancel', gestureId }, keepalive: true }).catch(() => {});
      }
      outstandingGestures.current.clear();
      controller.abort();
      dragging.current = false;
    };
  }, [apply, generation]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController(); let timer;
    async function poll() {
      if (controller.signal.aborted) return;
      let delay = 180;
      if (document.visibilityState !== 'hidden') {
        const revision = stateRevision.current, readable = !mutationPending.current;
        try {
          const value = await request(`${BASE}/${session}/frame`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (readable && revision === stateRevision.current && !mutationPending.current) {
            apply(value);
            const pending = resizeFence.current;
            const tab = value.tabs.find(item => item.id === value.activeTabId);
            const frameAvailable = value.image || (tab?.url === 'about:blank' && !value.dialog);
            const superseded = pending && (!Number.isSafeInteger(pending.revision)
              || (Number.isSafeInteger(value.viewRevision) && value.viewRevision > pending.revision));
            if (!pending || (pending.acknowledged && frameAvailable && ((value.width === pending.width && value.height === pending.height) || superseded))) {
              setSize({ width: value.width, height: value.height, revision: value.viewRevision });
              setImage(value.image ? 'data:image/jpeg;base64,' + value.image : '');
              if (pending) { resizeFence.current = null; setResizing(false); }
            }
            setStreamError('');
          }
        } catch (error) {
          if (!controller.signal.aborted && readable && revision === stateRevision.current && !mutationPending.current) { delay = 1000; setStreamError(error.message); }
        }
      }
      timer = setTimeout(poll, delay);
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [apply, session]);

  const send = useCallback((value, navigation = false, onDispatch = null) => {
    const id = sessionRef.current, controller = lifecycle.current;
    const release = value.type === 'pointer' && ['up', 'cancel'].includes(value.action);
    if (!id || controller?.signal.aborted || queued.current >= (release ? 65 : 64)) return Promise.resolve();
    if (value.type === 'pointer' && pointerGesture.current && !value.gestureId) value = { ...value, gestureId: pointerGesture.current };
    if (['pointer', 'wheel', 'key', 'text'].includes(value.type) && value.action !== 'cancel' && frameBinding.current) {
      value = { ...value, frame: { ...frameBinding.current } };
    }
    queued.current++;
    if (value.type === 'pointer' && value.action === 'down' && value.gestureId) outstandingGestures.current.add(value.gestureId);
    if (navigation) { setBusy(true); setError(''); }
    const result = queue.current.catch(() => {}).then(async () => {
      if (controller.signal.aborted || sessionRef.current !== id) return;
      onDispatch?.();
      const changed = await changeState(`${BASE}/${id}/command`, { method: 'POST', body: value, signal: controller.signal }, id);
      if (changed) {
        if (value.type === 'pointer' && ['up', 'cancel'].includes(value.action)) outstandingGestures.current.delete(value.gestureId);
        setError('');
      }
      return changed;
    }).catch(error => { if (!controller.signal.aborted && !(value.type === 'resize' && /dialog/i.test(error.message))) setError(error.message); })
      .finally(() => { queued.current--; if (navigation && !controller.signal.aborted) setBusy(false); });
    queue.current = result;
    return result;
  }, [changeState]);
  const cancelGesture = useCallback(gesture => {
    if (!gesture) return;
    pointerCancel.current = gesture;
    setImage('');
    setResizing(true);
    send({ type: 'pointer', action: 'cancel', gestureId: gesture }).then(result => {
      if (pointerCancel.current !== gesture) return;
      if (!result) { setError('The browser pointer could not be released. Restart the browser before continuing.'); return; }
      pointerCancel.current = null;
      if (resizeFence.current) resizeFence.current.start();
      else if (requestResize.current) requestResize.current();
      else setResizing(false);
    });
  }, [send]);
  useEffect(() => {
    if (inputBlocked) {
      if (dragging.current && !touch.current) {
        pointerCancel.current = pointerGesture.current;
        setImage('');
        setResizing(true);
      }
      dragging.current = false;
      touch.current = null;
      return undefined;
    }
    const gesture = pointerCancel.current;
    if (!gesture) return undefined;
    cancelGesture(gesture);
    return undefined;
  }, [inputBlocked, cancelGesture]);
  async function control(owner) {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const value = await changeState(`${BASE}/${id}/command`, { method: 'POST', body: { type: 'control', owner }, signal: lifecycle.current.signal }, id);
      if (value) setError('');
    } catch (error) { setError(error.message); }
  }
  async function decide(id, approved) {
    setDeciding(id);
    try {
      await request('/api/workspace-browser/approvals/' + encodeURIComponent(id), { method: 'POST', body: { approved }, signal: lifecycle.current.signal });
      setResolvedApprovals(previous => [...previous.slice(-63), id]);
    }
    catch (error) {
      if (error.status === 404) setResolvedApprovals(previous => [...previous.slice(-63), id]);
      else setError(error.message);
    }
    finally { setDeciding(''); }
  }
  useEffect(() => {
    if (!session || typeof ResizeObserver === 'undefined') return;
    let timer, previous = '';
    const update = (force = false) => {
      const dimensions = viewportSize(surfaceRef.current?.getBoundingClientRect());
      if (!dimensions) return;
      const { width, height } = dimensions;
      observedSurface.current = dimensions;
      const next = `${width}:${height}`;
      if ((!force && previous === next) || (resizeFence.current?.width === width && resizeFence.current?.height === height)) return;
      previous = next;
      clearTimeout(timer);
      const pending = { width, height, acknowledged: false, retries: 0 };
      pending.start = () => {
        if (resizeFence.current !== pending || dialogRef.current || dragging.current || pointerCancel.current) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (resizeFence.current !== pending || dialogRef.current || dragging.current || pointerCancel.current) return;
          let dispatched = false;
          send({ type: 'resize', width, height }, false, () => { dispatched = true; }).then(value => {
            if (resizeFence.current !== pending) return;
            if (value || dispatched) {
              pending.acknowledged = true;
              pending.revision = value?.tabs?.find(tab => tab.id === value.activeTabId)?.viewRevision;
            }
            else if (pending.retries++ < 3) pending.start();
            else setError('The browser is busy. Restart it to finish resizing.');
          });
        }, 180);
      };
      resizeFence.current = pending;
      setResizing(true);
      setImage('');
      if (dragging.current && !touch.current) {
        dragging.current = false;
        cancelGesture(pointerGesture.current);
      } else if (touch.current) {
        dragging.current = false;
        touch.current = null;
      }
      if (!dragging.current) pending.start();
    };
    requestResize.current = () => update(true);
    const observer = new ResizeObserver(() => update());
    observer.observe(surfaceRef.current);
    return () => { observer.disconnect(); clearTimeout(timer); resizeFence.current = null; requestResize.current = null; observedSurface.current = null; };
  }, [session, send, cancelGesture]);
  useEffect(() => {
    if (!state.dialog && !dragging.current) resizeFence.current?.start();
  }, [state.dialog?.id]);
  function navigate(event) {
    event.preventDefault();
    if (inputBlocked) return;
    try { send({ type: 'navigate', url: browserAddress(address) }, true); surfaceRef.current?.focus(); }
    catch (error) { setError(error.message); }
  }
  async function selectTab(command) {
    if (inputBlocked) return;
    const focused = document.activeElement;
    const value = await send(command);
    if (value) requestResize.current?.();
    const tab = value?.tabs.find(tab => tab.id === value.activeTabId);
    if (tab?.url === 'about:blank' && value.control?.owner !== 'agent' && document.activeElement === focused) {
      setAddress('');
      addressRef.current?.focus();
    }
  }
  async function typeText(event) {
    event.preventDefault();
    if (!text || inputBlocked || typingPending || !surfaceReady()) return;
    const submitted = text;
    setTypingPending(true);
    try {
      const inputId = continuationIdentity(inputSequence);
      const value = await send({ type: 'text', text: submitted, ...(inputId ? { inputId } : {}) });
      if (value) setText(current => current === submitted ? '' : current);
    } finally { setTypingPending(false); }
  }
  function shortcut(event) {
    if (inputBlocked || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'l' && key !== 'r') return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'l') { addressRef.current?.focus(); addressRef.current?.select(); }
    else if (session && !busy) send({ type: 'reload' }, true);
  }
  function surfaceReady(rect = surfaceRef.current?.getBoundingClientRect()) {
    if (resizeFence.current || pointerCancel.current || !rect) return false;
    if (typeof ResizeObserver === 'undefined') return true;
    const expected = viewportSize(rect);
    if (!expected || !observedSurface.current || expected.width !== observedSurface.current.width || expected.height !== observedSurface.current.height) return false;
    if (active?.url && active.url !== 'about:blank') {
      const frame = surfaceRef.current?.querySelector('img');
      if (!frame?.complete || frame.naturalWidth !== size.width || frame.naturalHeight !== size.height) return false;
    }
    return true;
  }
  function continuationIdentity(sequence) {
    const frame = frameBinding.current;
    if (!Number.isSafeInteger(frame?.revision)) return undefined;
    const now = Date.now();
    const previous = sequence.current;
    if (!previous || now < previous.at || now - previous.at > 500
      || previous.tabId !== frame.tabId || previous.documentId !== frame.documentId
      || previous.width !== frame.width || previous.height !== frame.height) {
      sequence.current = { id: newPointerGesture(), at: now, tabId: frame.tabId, documentId: frame.documentId, width: frame.width, height: frame.height };
    } else previous.at = now;
    return sequence.current.id;
  }
  function rememberPointerForTyping() {
    const frame = frameBinding.current;
    if (!pointerGesture.current || !Number.isSafeInteger(frame?.revision)) return;
    inputSequence.current = { id: pointerGesture.current, at: Date.now(), tabId: frame.tabId, documentId: frame.documentId, width: frame.width, height: frame.height };
  }
  function point(event, action) {
    if (inputBlocked) return;
    if (action === 'down' && dragging.current) return;
    if (action === 'up' && !dragging.current) return;
    if (action === 'down' && queued.current >= 64) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (!surfaceReady(rect)) {
      if (action === 'up' && dragging.current && !touch.current) {
        dragging.current = false;
        cancelGesture(pointerGesture.current);
      } else if (action === 'up') { dragging.current = false; touch.current = null; }
      return;
    }
    const coordinates = browserPoint(rect, size.width, size.height, event.clientX, event.clientY) || (action === 'up' ? lastPoint.current : null);
    if (!coordinates) return;
    lastPoint.current = coordinates;
    event.preventDefault();
    if (action === 'down') { target.focus(); target.setPointerCapture?.(event.pointerId); dragging.current = true; pointerGesture.current = newPointerGesture(); pressedButton.current = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'; }
    if (action === 'up') dragging.current = false;
    if (event.pointerType === 'touch') {
      if (action === 'down') touch.current = { ...coordinates, moved: false, scrollId: Number.isSafeInteger(frameBinding.current?.revision) ? newPointerGesture() : undefined };
      else if (action === 'move' && touch.current) {
        const deltaX = touch.current.x - coordinates.x, deltaY = touch.current.y - coordinates.y;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 6) {
          send({ type: 'wheel', deltaX: Math.max(-2000, Math.min(2000, deltaX)), deltaY: Math.max(-2000, Math.min(2000, deltaY)), ...(touch.current.scrollId ? { scrollId: touch.current.scrollId } : {}) });
          touch.current = { ...coordinates, moved: true, scrollId: touch.current.scrollId };
        }
      } else if (action === 'up') {
        if (touch.current && !touch.current.moved) {
          rememberPointerForTyping();
          send({ type: 'pointer', ...coordinates, action: 'down', button: 'left' });
          send({ type: 'pointer', ...coordinates, action: 'up', button: 'left' });
        }
        touch.current = null;
      }
      return;
    }
    if (action === 'up') rememberPointerForTyping();
    send({ type: 'pointer', ...coordinates, action, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clickCount: event.detail === 2 ? 2 : 1 });
  }
  function key(event) {
    if (inputBlocked) return;
    if (event.target !== event.currentTarget || event.isComposing) return;
    if (!surfaceReady()) { event.preventDefault(); return; }
    if ((event.ctrlKey || event.metaKey) && ['v', 'c', 'x'].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const inputId = continuationIdentity(inputSequence);
      send({ type: 'text', text: event.key, ...(inputId ? { inputId } : {}) });
    }
    else {
      const modifiers = ['Control', 'Meta', 'Alt', 'Shift'].filter(name => event.getModifierState(name));
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
      const scrolling = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
      const identity = continuationIdentity(scrolling ? scrollSequence : inputSequence);
      send({ type: 'key', key: [...modifiers, event.key === ' ' ? 'Space' : event.key].join('+'), ...(identity ? { [scrolling ? 'scrollId' : 'inputId']: identity } : {}) });
    }
  }
  async function end() {
    const id = sessionRef.current;
    if (!id) { setGeneration(value => value + 1); return; }
    setBusy(true);
    try { await request(`${BASE}/${id}`, { method: 'DELETE', signal: lifecycle.current.signal }); setGeneration(value => value + 1); }
    catch (error) { if (error.status === 404) setGeneration(value => value + 1); else { setError(error.message); setBusy(false); } }
  }
  const needsAttention = error || streamError;
  const waitingForPage = busy || (active?.url && active.url !== 'about:blank');

  return <section className="workspace-browser" aria-label="Workspace browser" onKeyDownCapture={shortcut}>
    <header className="workspace-browser-heading"><span className="workspace-browser-title">Browser</span>
    <span className="workspace-browser-ownership" role="status" title={agentHasControl ? `${state.control.label || 'An agent'} is controlling the browser` : undefined}>{agentHasControl ? `${state.control.label || 'Agent'} has control` : takeoverPending ? 'Takeover pending' : state.control?.owner === 'human' ? 'You have control' : <span className="workspace-browser-sr-only">Shared browser ready</span>}</span>
    <button type="button" className="workspace-browser-typing-toggle" aria-label={typingOpen ? 'Hide typing controls' : 'Show typing controls'} aria-expanded={typingOpen} aria-controls={typingId} onClick={() => setTypingOpen(value => !value)}>Typing</button>
    <details className="workspace-browser-actions" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
      <summary title="Browser actions"><span aria-hidden="true">⋯</span><span className="workspace-browser-sr-only">Browser actions</span></summary>
      <div className="workspace-browser-menu"><button type="button" disabled={!session || busy} onClick={end} title="Clear this browser session and its sign-ins">Reset</button><p>Clears all tabs and sign-ins in this shared browser.</p></div>
    </details>
    {onToggleExpanded && <button type="button" className="workspace-browser-icon" onClick={onToggleExpanded} aria-label={isExpanded ? 'Restore browser pane' : 'Expand browser pane'} title={isExpanded ? 'Restore browser pane' : 'Expand browser pane'}><PreviewIcon name={isExpanded ? 'restore' : 'expand'} /></button>}
    <button ref={closeRef} type="button" className="workspace-browser-icon" onClick={onClose} aria-label="Close browser pane" title="Close browser pane"><PreviewIcon name="close" /></button></header>
    {(agentHasControl || takeoverPending || state.control?.owner === 'human') && <div className="workspace-browser-control">
      <span>{takeoverPending ? state.keyboardRelease === 'unconfirmed' ? 'Keyboard release could not be confirmed. Reset the browser.' : 'Finishing the agent’s keyboard action' : agentHasControl ? 'Manual input is paused' : 'Agents are paused'}</span>
      {!takeoverPending && (agentHasControl ? <button type="button" onClick={() => control('human')}>Take control</button> : <button type="button" onClick={() => control('agents')}>Let agents control</button>)}
    </div>}
    {approvals.length > 0 && <div className="workspace-browser-approvals" aria-label="Browser action approvals">{approvals.map(row => {
      const info = getBrowserToolDisplayInfo(row.name, row.arguments || {});
      return <article key={row.id}>
      <strong>{info ? `${info.title}?` : `${row.label} requests ${row.name.replace(/^browser_/, '').replaceAll('_', ' ')}`}</strong>
      {info && <p>Requested by {row.label}</p>}
      {row.target?.url && <p>Page: {row.target.url}</p>}
      {info?.detail && <p className="workspace-browser-approval-arguments">{info.detail}</p>}
      <details><summary>Review exact action</summary><p>Tool: <code>{row.name}</code></p><pre>{JSON.stringify(row.arguments, null, 2)}</pre></details>
      <div><button type="button" disabled={deciding === row.id} onClick={() => decide(row.id, true)}>Allow once</button><button type="button" disabled={deciding === row.id} onClick={() => decide(row.id, false)}>Deny</button></div>
    </article>; })}</div>}
    <fieldset className="workspace-browser-navigation" disabled={inputBlocked}>
    <div className="workspace-browser-tabs" role="tablist" aria-label="Browser tabs">
      {state.tabs.map(tab => <div className="workspace-browser-tab" key={tab.id}>
        <button type="button" role="tab" aria-selected={tab.id === state.activeTabId} title={tab.title === 'about:blank' || !tab.title ? 'New tab' : tab.title} onClick={() => selectTab({ type: 'switchTab', id: tab.id })}>{tab.title === 'about:blank' || !tab.title ? 'New tab' : tab.title}</button>
        <button type="button" aria-label={`Close tab ${tab.title || 'New tab'}`} onClick={() => send({ type: 'closeTab', id: tab.id })}><PreviewIcon name="close" /></button>
      </div>)}
      <button type="button" aria-label="New browser tab" title="New browser tab" disabled={!session || state.tabs.length >= 8} onClick={() => selectTab({ type: 'newTab' })}><PreviewIcon name="plus" /></button>
    </div>
    <form className="workspace-browser-address" onSubmit={navigate}>
      <button type="button" aria-label="Browser back" disabled={!session || busy || active?.canGoBack !== true} onClick={() => send({ type: 'back' }, true)}><PreviewIcon name="back" /></button>
      <button type="button" aria-label="Browser forward" disabled={!session || busy || active?.canGoForward !== true} onClick={() => send({ type: 'forward' }, true)}><PreviewIcon name="forward" /></button>
      <button type="button" aria-label="Reload browser page" disabled={!session || busy} onClick={() => send({ type: 'reload' }, true)}><PreviewIcon name="reload" /></button>
      <input ref={addressRef} aria-label="Browser address" placeholder="Search or enter an address" value={address} onFocus={event => event.target.select()} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setAddress(active?.url === 'about:blank' ? '' : active?.url || ''); closeRef.current?.focus(); } }} autoComplete="off" autoCapitalize="none" spellCheck={false} />
      <button type="submit" disabled={!session || !address.trim() || busy}>Go</button>
    </form>
    </fieldset>
    {(error || streamError) && <div className="workspace-browser-error" role="alert"><span><strong>{session ? 'The browser needs attention.' : 'Couldn’t open the browser.'}</strong> {error || streamError}</span><button type="button" onClick={end}>Restart browser</button></div>}
    {state.dialog && <form className="workspace-browser-dialog" onSubmit={event => { event.preventDefault(); if (!agentHasControl) send({ type: 'dialog', dialogId: state.dialog.id, accept: true, text: prompt }); }}><span>{state.dialog.message}</span>{state.dialog.type === 'prompt' && <input aria-label="Browser dialog response" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={agentHasControl} />}<button type="submit" disabled={agentHasControl}>OK</button><button type="button" disabled={agentHasControl} onClick={() => send({ type: 'dialog', dialogId: state.dialog.id, accept: false })}>Cancel</button></form>}
    <div ref={surfaceRef} className="workspace-browser-surface" tabIndex={0} role="application" aria-label="Interactive browser page" aria-description="Tab moves between website controls. Press Control+L or Command+L to return to the browser address." aria-busy={busy || resizing} onKeyDown={key}
      onPaste={event => { event.preventDefault(); if (!inputBlocked && surfaceReady()) { const inputId = continuationIdentity(inputSequence); send({ type: 'text', text: event.clipboardData.getData('text/plain'), ...(inputId ? { inputId } : {}) }); } }}
      onPointerDown={event => point(event, 'down')} onPointerUp={event => point(event, 'up')}
      onPointerCancel={event => { if (dragging.current && event.pointerType !== 'touch') cancelGesture(pointerGesture.current); dragging.current = false; touch.current = null; }}
      onPointerMove={event => { if (dragging.current && Date.now() - lastMove.current > 60) { lastMove.current = Date.now(); point(event, 'move'); } }}
      onContextMenu={event => event.preventDefault()}
      onWheel={event => { if (!inputBlocked && surfaceReady()) { const scrollId = continuationIdentity(scrollSequence); send({ type: 'wheel', deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)), ...(scrollId ? { scrollId } : {}) }); } }}>
      {image && active?.url !== 'about:blank' ? <img src={image} alt="Live browser page" data-view-revision={size.revision} data-view-document={active?.documentId} data-view-tab={state.activeTabId} draggable={false} /> : <div className="workspace-browser-start"><h2>{needsAttention ? 'Browser unavailable' : !session ? 'Opening browser…' : resizing ? 'Resizing browser…' : waitingForPage ? 'Loading page…' : 'Where do you want to go?'}</h2><p role={resizing ? 'status' : undefined}>{needsAttention ? 'Review the message above, then try again.' : !session ? 'Your tabs will appear here shortly.' : resizing ? 'You can edit your draft. Page controls will return when the updated view is ready.' : waitingForPage ? 'Your page will appear here shortly.' : 'Search or enter an address above. Your tabs stay open when you close this pane.'}</p></div>}
    </div>
    <form id={typingId} hidden={!typingOpen} className="workspace-browser-input" onSubmit={typeText}>
      <input aria-label="Type into browser page" placeholder="Type into the selected page field" value={text} onChange={event => setText(event.target.value)} disabled={!session || inputBlocked} />
      <button type="submit" disabled={!session || !text || inputBlocked || typingPending || resizing}>Type</button><button type="button" disabled={!session || inputBlocked || typingPending || resizing} onClick={() => { if (surfaceReady()) { const inputId = continuationIdentity(inputSequence); send({ type: 'key', key: 'Enter', ...(inputId ? { inputId } : {}) }); } }}>Enter</button>
    </form>
  </section>;
}
