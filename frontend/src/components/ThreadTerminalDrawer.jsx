import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalWithAddToChat } from './composer-context/TerminalWithAddToChat';
import { PaneSeparator } from './PaneSeparator';
import { ThreadTerminalTabs, terminalPanelId, terminalTabId } from './ThreadTerminalTabs';
import { useThreadDrawerLayout } from '../hooks/useThreadDrawerLayout';
import { MIN_DRAWER_HEIGHT, resolveSplitPartner } from '../utils/threadDrawerLayout';
import './ThreadTerminalDrawer.css';

const maxDrawerHeight = () => Math.max(MIN_DRAWER_HEIGHT, Math.floor((typeof window === 'undefined' ? 900 : window.innerHeight) * 0.7));

export function ThreadTerminalDrawer(props) {
  const { threadId, drawer, terminalInputAllowed, sessionCwd, fontSize, webglEnabled, isActive, fitSignal, owner = null, onRequestClose, onRequestReopen, authLifecycle, strictReady } = props;
  const strictProps = Object.hasOwn(props, 'authLifecycle') ? { authLifecycle, strictReady } : {};
  const { layout, setSplit, setDirection, setRatio, setHeight } = useThreadDrawerLayout(threadId);
  const [confirmClose, setConfirmClose] = useState(null);
  const [fitTick, setFitTick] = useState(0);
  const drawerRef = useRef(null);
  const panesRef = useRef(null);
  const keepButton = useRef(null);
  const live = useRef({ mounted: true, threadId });
  live.current.threadId = threadId;
  useEffect(() => {
    live.current.mounted = true;
    return () => { live.current.mounted = false; };
  }, []);
  const ids = drawer.terminals.map(terminal => terminal.id);
  const primaryId = drawer.terminalId;
  const partnerId = resolveSplitPartner(layout, ids, primaryId);
  const nameOf = id => `Terminal ${ids.indexOf(id) + 1}`;
  const ratioPercent = Math.round(layout.ratio * 100);
  const stacked = layout.direction === 'stacked';
  const height = Math.min(layout.height, maxDrawerHeight());

  useEffect(() => {
    const timer = window.setTimeout(() => setFitTick(tick => tick + 1), 80);
    return () => window.clearTimeout(timer);
  }, [layout.ratio, layout.direction, height, partnerId]);
  useEffect(() => { if (confirmClose) keepButton.current?.focus(); }, [confirmClose]);
  useEffect(() => { if (confirmClose && !ids.includes(confirmClose)) setConfirmClose(null); }, [confirmClose, ids]);

  const split = useCallback(async () => {
    if (!primaryId || partnerId) return;
    const created = await drawer.addTerminal({ select: false });
    if (created) setSplit(created);
  }, [drawer, partnerId, primaryId, setSplit]);

  const selectTab = id => {
    if (id === partnerId) setSplit(primaryId);
    drawer.select(id);
  };

  async function closeTerminal(id) {
    setConfirmClose(null);
    const last = ids.length === 1;
    const requestedFor = threadId;
    if (last) onRequestClose?.();
    const closed = await drawer.closeTerminal(id);
    if (!live.current.mounted || live.current.threadId !== requestedFor) return;
    if (!closed) { if (last) onRequestReopen?.(); return; }
    if (partnerId) {
      setSplit(null);
      drawer.select(id === primaryId ? partnerId : primaryId);
    }
  }
  const showAlone = id => { setSplit(null); drawer.select(id); };
  const toggleDirection = () => {
    if (!stacked && height < 360) setHeight(360, maxDrawerHeight());
    setDirection(stacked ? 'side-by-side' : 'stacked');
  };
  const fit = `${fitSignal ?? ''}:${fitTick}`;
  const chat = id => <TerminalWithAddToChat {...strictProps} key={id} owner={owner} label="Thread terminal" surface="desktop" sessionId={id} fontSize={fontSize} webglEnabled={webglEnabled}
    filePreviewThreadId={threadId} filePreviewRoot={sessionCwd} viewMode="terminal" inputEnabled={terminalInputAllowed} isPrimary={isActive} fitSignal={fit} />;

  function pane(id, { tabbed }) {
    const label = nameOf(id);
    return <div key={id} className="thread-terminal-pane" role={tabbed ? 'tabpanel' : 'group'}
      id={tabbed ? terminalPanelId(id) : undefined} aria-labelledby={tabbed ? terminalTabId(id) : undefined} aria-label={tabbed ? undefined : `${label}, split pane`}
      style={partnerId ? { flexBasis: `${id === primaryId ? ratioPercent : 100 - ratioPercent}%` } : undefined}>
      {partnerId && <div className="thread-terminal-pane-header">
        <span>{label}</span>
        <button type="button" aria-label={`Show ${label} alone`} onClick={() => showAlone(id)}>Expand</button>
        <button type="button" aria-label={`Close ${label}`} onClick={() => setConfirmClose(id)}>×</button>
      </div>}
      {chat(id)}
    </div>;
  }

  let body;
  if (!terminalInputAllowed) body = <p role="status" className="thread-terminal-drawer-status">Terminal access is unavailable for this environment.</p>;
  else if (!sessionCwd) body = <p role="status" className="thread-terminal-drawer-status">This conversation has no workspace folder for a terminal.</p>;
  else if (drawer.error) body = <div className="thread-terminal-drawer-error"><p role="alert">{drawer.error}</p>
    {drawer.canRetry && <button type="button" disabled={!terminalInputAllowed} onClick={() => drawer.retry()}>Retry opening terminal</button>}
    {!primaryId && drawer.canStartAgainAfterReview && <button type="button" disabled={!terminalInputAllowed} onClick={() => drawer.startAgainAfterReview()}>I checked the list; start another</button>}</div>;
  else if (primaryId) body = <div className={`thread-terminal-panes${partnerId && stacked ? ' thread-terminal-panes-stacked' : ''}`} ref={panesRef}>
    {pane(primaryId, { tabbed: true })}
    {partnerId && <PaneSeparator orientation={stacked ? 'horizontal' : 'vertical'} reverseKeyboard={stacked} label="Resize terminal split" value={ratioPercent} min={20} max={80} step={5} largeStep={10}
      format={value => `${value}% and ${100 - value}%`} onChange={value => setRatio(value / 100)}
      measure={event => { const rect = panesRef.current?.getBoundingClientRect(); return stacked
        ? rect?.height ? ((event.clientY - rect.top) / rect.height) * 100 : NaN
        : rect?.width ? ((event.clientX - rect.left) / rect.width) * 100 : NaN; }} />}
    {partnerId && pane(partnerId, { tabbed: false })}
  </div>;
  else body = <p role="status" className="thread-terminal-drawer-status">Opening a terminal in this thread's folder…</p>;

  return <section className="thread-terminal-drawer" aria-label="Thread terminal" ref={drawerRef} style={{ flexBasis: `${height}px` }}>
    <PaneSeparator orientation="horizontal" label="Resize terminal drawer" value={height} min={MIN_DRAWER_HEIGHT} max={maxDrawerHeight()} step={24} largeStep={96}
      format={value => `${value} pixels tall`} onChange={value => setHeight(value, maxDrawerHeight())}
      measure={event => { const rect = drawerRef.current?.getBoundingClientRect(); return rect ? rect.bottom - event.clientY : NaN; }} />
    {drawer.terminals.length > 0 && <ThreadTerminalTabs terminals={drawer.terminals} selectedId={primaryId} onSelect={selectTab}
      onAdd={() => drawer.addTerminal()} onSplit={partnerId ? null : split} onClose={partnerId ? null : id => setConfirmClose(id)}
      onToggleSplitDirection={partnerId ? toggleDirection : null} splitDirection={layout.direction} disabled={!terminalInputAllowed} />}
    {confirmClose && <div className="thread-terminal-confirm" role="group" aria-label={`Confirm closing ${nameOf(confirmClose)}`}>
      <p>{`Close ${nameOf(confirmClose)}? Anything running in it will stop.`}</p>
      <button type="button" ref={keepButton} onClick={() => setConfirmClose(null)}>Keep open</button>
      <button type="button" onClick={() => closeTerminal(confirmClose)}>{`Close ${nameOf(confirmClose)}`}</button>
    </div>}
    {drawer.closeError && <div className="thread-terminal-drawer-error"><p role="alert">{drawer.closeError}</p>
      <button type="button" aria-label="Dismiss close error" onClick={() => drawer.dismissCloseError()}>Dismiss</button></div>}
    {drawer.createError && <div className="thread-terminal-drawer-error"><p role="alert">{drawer.createError}</p>
      {drawer.canRetryCreate && <button type="button" aria-label="Retry adding terminal" disabled={!terminalInputAllowed} onClick={() => drawer.retryCreate()}>Retry</button>}
      <button type="button" aria-label="Dismiss terminal error" onClick={() => drawer.dismissCreateError()}>Dismiss</button>
      {drawer.canStartAgainAfterReview && <button type="button" disabled={!terminalInputAllowed} onClick={() => drawer.startAgainAfterReview()}>I checked the list; start another</button>}
    </div>}
    {body}
  </section>;
}
