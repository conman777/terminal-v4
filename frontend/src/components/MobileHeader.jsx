import { useState, useRef, useEffect, useLayoutEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { MobileDrawer } from './MobileDrawer';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { useTheme } from '../contexts/ThemeContext';
import { getSessionDisplayInfo } from '../utils/sessionDisplay';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import './MobileUI.css';

const EDGE_SWIPE_ZONE_PX = 28;
const HORIZONTAL_SWIPE_THRESHOLD_PX = 56;
const VERTICAL_SWIPE_THRESHOLD_PX = 64;
const SWIPE_AXIS_BIAS_PX = 18;
const MAX_GESTURE_DURATION_MS = 700;

function isInteractiveGestureTarget(target) {
  return target instanceof Element && Boolean(
    target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="menuitemradio"]')
  );
}

function MobileThreadRenameDialog({sessionId, initialTitle, pending, onSave, onClose}) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const mountedRef = useRef(false);
  const submittingRef = useRef(false);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  useBodyScrollLock(true);

  useEffect(() => {
    mountedRef.current = true;
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    const overlay = dialog.parentElement;
    const inertElements = [...document.body.children].filter(element => element !== overlay && !element.hasAttribute('inert'));
    for (const element of inertElements) element.setAttribute('inert', '');
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      mountedRef.current = false;
      for (const element of inertElements) element.removeAttribute('inert');
      if ((dialog.contains(document.activeElement) || document.activeElement === document.body) && opener?.isConnected) {
        opener.focus();
        requestAnimationFrame(() => {
          if (document.activeElement === document.body && opener.isConnected) opener.focus();
        });
      }
    };
  }, []);

  const handleSubmit = async event => {
    event.preventDefault();
    if (submittingRef.current || pending) return;
    const trimmed = title.trim();
    if (!trimmed || Array.from(trimmed).length > 60) {
      setError(!trimmed ? 'Enter a thread title.' : 'Use 60 characters or fewer.');
      return;
    }
    submittingRef.current = true;
    setError(null);
    try {
      const result = await onSave(sessionId, trimmed);
      if (result?.ok === false) throw result.error || new Error('Try again.');
      if (mountedRef.current) onClose();
    } catch (failure) {
      if (mountedRef.current) setError(`Could not rename thread. ${failure?.message || 'Try again.'}`);
    } finally {
      submittingRef.current = false;
    }
  };

  return createPortal(
    <div className="mobile-header-rename-overlay mobile-ui">
      <form
        ref={dialogRef}
        className="mobile-header-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={pending}
        onSubmit={handleSubmit}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
          if (event.key !== 'Tab') return;
          const controls = [...event.currentTarget.querySelectorAll('input, button:not(:disabled)')];
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}
      >
        <h2 id={titleId}>Rename thread</h2>
        <label htmlFor={inputId}>Thread title</label>
        <input ref={inputRef} id={inputId} type="text" value={title} readOnly={pending} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={event => { setTitle(event.target.value); setError(null); }} />
        {error && <p id={errorId} className="mobile-header-rename-error" role="alert">{error}</p>}
        {pending && <p role="status">A rename is in progress. Wait for it to finish.</p>}
        <div className="mobile-header-rename-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={pending || !title.trim()}> {pending ? 'Saving…' : 'Save'} </button>
        </div>
      </form>
    </div>, document.body
  );
}

export function MobileHeader({
  activeSessions = [],
  sessionLoadError = false,
  activeSessionId,
  onSelectSession,
  onSelectHistoryResult,
  onCreateSession,
  newSessionLabel = 'New thread',
  onRenameSession,
  onCloseSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
  onUnarchiveSession,
  onUpdateThreadMetadata,
  archivedSessions = [],
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenWorkspaceBrowser,
  onOpenBookmarks,
  onOpenNotes,
  onOpenProcessManager,
  onLogout,
  keybarOpen,
  onToggleKeybar,
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  currentPath,
  onAddScanFolder = null,
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  showFileManager,
  onToggleFileManager,
  onOpenGit,
  gitControl = null,
  onCreateTerminal,
  onToggleThreadTerminal,
  onFindInThread,
  threadTerminalOpen = false,
  serverControl = null,
  workspaceActions = null,
  activeTitle = null,
  isWorkspaceStart = false,
  isNavCollapsed = false,
  sessionActivity,
  sessionsGroupedByProject,
  chatMode = false,
  onToggleChatMode,
  showPreviewNavigation = true,
  showConversationToggle = true,
  showDrawerViewTabs = true,
  compactForTextEntry = false,
}) {
  const { theme, toggleTheme } = useTheme();
  const visibleActiveSessions = activeSessions.filter((session) => !session.thread?.archived);
  const activeVisibleSession = isWorkspaceStart ? null : activeSessions.find((session) => session.id === activeSessionId) || null;
  const activeSessionDisplay = getSessionDisplayInfo(activeVisibleSession, 'New terminal');
  const title = activeTitle ?? (mobileView === 'preview' ? 'Preview' : activeVisibleSession ? activeSessionDisplay.primaryLabel : 'New thread');
  const [showDrawer, setShowDrawer] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showTitle, setShowTitle] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [renamePending, setRenamePending] = useState(false);
  const renameRequestRef = useRef(null);
  const [closeFeedback, setCloseFeedback] = useState(null);
  const [closePending, setClosePending] = useState(false);
  const closeRequestRef = useRef(null);
  const closeScopeRef = useRef(null);
  const [pinFeedback, setPinFeedback] = useState(null);
  const [pinPending, setPinPending] = useState(false);
  const pinRequestRef = useRef(null);
  const pinScopeRef = useRef(null);
  const [archiveFeedback, setArchiveFeedback] = useState(null);
  const [archivePending, setArchivePending] = useState(false);
  const archiveRequestRef = useRef(null);
  const archiveScopeRef = useRef(null);
  const [snoozeFeedback, setSnoozeFeedback] = useState(null);
  const [snoozePending, setSnoozePending] = useState(false);
  const snoozeRequestRef = useRef(null);
  const snoozeScopeRef = useRef(null);
  const overflowId = useId();
  const titlePanelId = useId();
  const titleTriggerRef = useRef(null);
  const titlePanelRef = useRef(null);
  const overflowRef = useRef(null);
  const overflowTriggerRef = useRef(null);
  const headerRef = useRef(null);
  const topRowGestureRef = useRef(null);
  const isPreviewView = mobileView === 'preview';
  const terminalAvailable = Boolean(activeVisibleSession && !isStructuredSessionId(activeVisibleSession.id));
  const threadTerminalAvailable = Boolean(activeVisibleSession && isStructuredSessionId(activeVisibleSession.id) && onToggleThreadTerminal);
  const terminalLabel = threadTerminalAvailable ? (threadTerminalOpen && !isPreviewView ? 'Hide thread terminal' : 'Show thread terminal') : terminalAvailable ? 'Show terminal' : onCreateTerminal ? 'New terminal' : 'No terminal selected';
  const projectLabel = typeof currentPath === 'string' ? currentPath.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() : '';
  const isKeyboardCompact = compactForTextEntry && !isPreviewView;

  useLayoutEffect(() => {
    if (!headerRef.current) return;
    const height = Math.round(headerRef.current.getBoundingClientRect().height || 0);
    if (height > 0) {
      document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;

    const updateHeight = () => {
      if (headerRef.current) {
        const height = Math.round(headerRef.current.getBoundingClientRect().height || headerRef.current.offsetHeight || 0);
        if (height > 0) document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
      }
    };

    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(headerRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;
    const raf = requestAnimationFrame(() => {
      const height = Math.round(headerRef.current?.getBoundingClientRect().height || 0);
      if (height > 0) document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    });
    return () => cancelAnimationFrame(raf);
  }, [mobileView, title, isNavCollapsed, isKeyboardCompact]);

  const handleStartRename = useCallback((sessionId) => {
    const session = visibleActiveSessions.find((item) => item.id === sessionId);
    if (!session || !onRenameSession) return;
    setRenameTarget({sessionId, title: getSessionDisplayInfo(session, 'New terminal').primaryLabel});
  }, [onRenameSession, visibleActiveSessions]);

  const closeRename = useCallback(() => setRenameTarget(null), []);
  const renameIsCurrent = Boolean(renameTarget && activeVisibleSession?.id === renameTarget.sessionId && !activeVisibleSession.thread?.archived && !isPreviewView && !showDrawer);
  useEffect(() => { if (!renameIsCurrent) setRenameTarget(null); }, [renameIsCurrent]);
  useEffect(() => () => { renameRequestRef.current = null; }, []);

  const handleSaveRename = async (sessionId, nextTitle) => {
    if (!renameIsCurrent || renameTarget.sessionId !== sessionId) return {ok: false, error: new Error('The selected thread changed. Open Rename again.')};
    if (renameRequestRef.current) return {ok: false, error: new Error('A rename is already in progress.')};
    const request = {};
    renameRequestRef.current = request;
    setRenamePending(true);
    try {
      return await onRenameSession(sessionId, nextTitle);
    } finally {
      if (renameRequestRef.current === request) {
        renameRequestRef.current = null;
        setRenamePending(false);
      }
    }
  };

  useLayoutEffect(() => {
    closeScopeRef.current = {};
    setCloseFeedback(null);
  }, [activeSessionId, activeVisibleSession?.id, activeVisibleSession?.thread?.archived, mobileView, isWorkspaceStart, showDrawer]);
  useEffect(() => () => { closeRequestRef.current = null; }, []);

  useLayoutEffect(() => {
    pinScopeRef.current = {};
    setPinFeedback(null);
  }, [activeSessionId, activeVisibleSession?.id, activeVisibleSession?.thread?.archived, mobileView, isWorkspaceStart, showDrawer]);
  useEffect(() => () => { pinRequestRef.current = null; }, []);
  useEffect(() => {
    if (pinFeedback && Boolean(activeVisibleSession?.thread?.pinned) !== pinFeedback.pinned) setPinFeedback(null);
  }, [activeVisibleSession?.thread?.pinned, pinFeedback]);

  const handlePinFromMenu = async (sessionId, pinned) => {
    const action = pinned ? onUnpinSession : onPinSession;
    if (pinRequestRef.current || archiveRequestRef.current || !action || activeVisibleSession?.id !== sessionId || activeVisibleSession.thread?.archived || Boolean(activeVisibleSession.thread?.pinned) !== pinned || isPreviewView || showDrawer) return;
    const scope = pinScopeRef.current;
    const request = {};
    pinRequestRef.current = request;
    setPinPending(true);
    setPinFeedback({ sessionId, pinned, error: null });
    try {
      const result = await action(sessionId);
      if (result?.ok === false) throw result.error || new Error('Try again.');
      if (pinRequestRef.current === request && pinScopeRef.current === scope) setPinFeedback(null);
    } catch (failure) {
      if (pinRequestRef.current === request && pinScopeRef.current === scope) setPinFeedback({ sessionId, pinned, error: `Could not ${pinned ? 'unpin' : 'pin'} thread. ${failure?.message || 'Try again.'}` });
    } finally {
      if (pinRequestRef.current === request) { pinRequestRef.current = null; setPinPending(false); }
    }
  };

  useLayoutEffect(() => {
    archiveScopeRef.current = {};
    setArchiveFeedback(null);
  }, [activeSessionId, activeVisibleSession?.id, activeVisibleSession?.thread?.archived, mobileView, isWorkspaceStart, showDrawer]);
  useEffect(() => () => { archiveRequestRef.current = null; }, []);
  useEffect(() => {
    const scopeChanged = () => {
      const request = archiveRequestRef.current;
      if (!request || request.environment.aborted || !isAuthScopeCurrent(request.auth)) {
        archiveRequestRef.current = null;
        archiveScopeRef.current = {};
        setArchivePending(false);
        setArchiveFeedback(null);
      }
    };
    const unsubscribeAuth = subscribeAuth(scopeChanged);
    const unsubscribeEnvironment = subscribeEnvironment(scopeChanged);
    return () => { unsubscribeAuth(); unsubscribeEnvironment(); };
  }, []);

  const handleArchiveFromMenu = async (sessionId, archived) => {
    const action = archived ? onUnarchiveSession : onArchiveSession;
    if (archiveRequestRef.current || pinRequestRef.current || !action || activeVisibleSession?.id !== sessionId || Boolean(activeVisibleSession.thread?.archived) !== archived || isPreviewView || showDrawer) return;
    const scope = archiveScopeRef.current;
    const request = { auth: captureAuthScope(), environment: getEnvironmentSignal() };
    archiveRequestRef.current = request;
    setArchivePending(true);
    setArchiveFeedback({ sessionId, archived, error: null });
    try {
      const result = await action(sessionId);
      if (result?.ok === false) throw result.error || new Error('Try again.');
      if (archiveRequestRef.current === request && archiveScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setArchiveFeedback(null);
    } catch (failure) {
      if (archiveRequestRef.current === request && archiveScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setArchiveFeedback({ sessionId, archived, error: `Could not ${archived ? 'restore' : 'archive'} thread. ${failure?.message || 'Try again.'}` });
    } finally {
      if (archiveRequestRef.current === request) { archiveRequestRef.current = null; setArchivePending(false); }
    }
  };

  useLayoutEffect(() => {
    snoozeScopeRef.current = {};
    setSnoozeFeedback(null);
  }, [activeSessionId, activeVisibleSession?.id, activeVisibleSession?.thread?.archived, mobileView, isWorkspaceStart, showDrawer]);
  useEffect(() => {
    const scopeChanged = () => {
      const request = snoozeRequestRef.current;
      if (!request || request.environment.aborted || !isAuthScopeCurrent(request.auth)) {
        snoozeRequestRef.current = null;
        snoozeScopeRef.current = {};
        setSnoozePending(false);
        setSnoozeFeedback(null);
      }
    };
    const unsubscribeAuth = subscribeAuth(scopeChanged);
    const unsubscribeEnvironment = subscribeEnvironment(scopeChanged);
    return () => { snoozeRequestRef.current = null; unsubscribeAuth(); unsubscribeEnvironment(); };
  }, []);
  const handleSnoozeFromMenu = async (sessionId, snoozed) => {
    const lifecycle = activeVisibleSession?.threadLifecycle;
    if (snoozeRequestRef.current || !onUpdateThreadMetadata || activeVisibleSession?.id !== sessionId
      || activeVisibleSession.thread?.archived || lifecycle?.supported !== true
      || Boolean(lifecycle.snoozed) !== snoozed || (!snoozed && lifecycle.requiresAttention)
      || isPreviewView || showDrawer) return;
    const scope = snoozeScopeRef.current;
    const request = { auth: captureAuthScope(), environment: getEnvironmentSignal() };
    snoozeRequestRef.current = request;
    setSnoozePending(true);
    setSnoozeFeedback({ sessionId, snoozed, error: null });
    try {
      await onUpdateThreadMetadata(sessionId, snoozed ? { wakeSnooze: true } : { snoozeForSeconds: 3600 });
      if (snoozeRequestRef.current === request && snoozeScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setSnoozeFeedback(null);
    } catch (failure) {
      if (snoozeRequestRef.current === request && snoozeScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setSnoozeFeedback({ sessionId, snoozed, error: `Could not ${snoozed ? 'wake' : 'snooze'} thread. ${failure?.message || 'Try again.'}` });
    } finally {
      if (snoozeRequestRef.current === request) { snoozeRequestRef.current = null; setSnoozePending(false); }
    }
  };

  const handleSettlementFromMenu = async (sessionId, settled) => {
    const lifecycle = activeVisibleSession?.threadLifecycle;
    if (snoozeRequestRef.current || !onUpdateThreadMetadata || activeVisibleSession?.id !== sessionId
      || activeVisibleSession.runtime !== 'v4' || activeVisibleSession.thread?.archived
      || lifecycle?.settlementSupported !== true || lifecycle.requiresAttention !== false
      || Boolean(lifecycle.settled) !== settled || (!settled && lifecycle.canSettle !== true)
      || isPreviewView || showDrawer) return;
    const scope = snoozeScopeRef.current;
    const request = { auth: captureAuthScope(), environment: getEnvironmentSignal() };
    snoozeRequestRef.current = request;
    setSnoozePending(true);
    setSnoozeFeedback({ sessionId, kind: 'settlement', settled, error: null });
    try {
      await onUpdateThreadMetadata(sessionId, { settled: !settled });
      if (snoozeRequestRef.current === request && snoozeScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setSnoozeFeedback(null);
    } catch (failure) {
      if (snoozeRequestRef.current === request && snoozeScopeRef.current === scope && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setSnoozeFeedback({ sessionId, kind: 'settlement', settled, error: `Could not ${settled ? 'un-settle' : 'settle'} thread. ${failure?.message || 'Try again.'}` });
    } finally {
      if (snoozeRequestRef.current === request) { snoozeRequestRef.current = null; setSnoozePending(false); }
    }
  };

  const handleCloseFromMenu = async (sessionId) => {
    if (closeRequestRef.current || !onCloseSession || activeVisibleSession?.id !== sessionId || activeVisibleSession.thread?.archived || isPreviewView || showDrawer) return;
    const scope = closeScopeRef.current;
    const request = {};
    const sessionTitle = getSessionDisplayInfo(activeVisibleSession, 'Thread').primaryLabel;
    closeRequestRef.current = request;
    setClosePending(true);
    setCloseFeedback({sessionId, title: sessionTitle, error: null});
    try {
      const result = await onCloseSession(sessionId);
      if (result?.ok === false) throw result.error || new Error('Try again.');
      if (closeRequestRef.current === request && closeScopeRef.current === scope) setCloseFeedback(null);
    } catch (failure) {
      if (closeRequestRef.current === request && closeScopeRef.current === scope) {
        setCloseFeedback({sessionId, title: sessionTitle, error: `Could not close ${sessionTitle}. ${failure?.message || 'Try again.'}`});
      }
    } finally {
      if (closeRequestRef.current === request) {
        closeRequestRef.current = null;
        setClosePending(false);
      }
    }
  };

  const handleTopRowTouchStart = useCallback((event) => {
    if (isInteractiveGestureTarget(event.target)) {
      topRowGestureRef.current = null;
      return;
    }
    const touch = event.touches?.[0];
    if (!touch) return;
    topRowGestureRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      startedAt: Date.now()
    };
  }, []);

  const handleTopRowTouchEnd = useCallback((event) => {
    const gesture = topRowGestureRef.current;
    topRowGestureRef.current = null;
    if (!gesture) return;

    const touch = event.changedTouches?.[0];
    if (!touch) return;

    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Date.now() - gesture.startedAt;
    if (elapsed > MAX_GESTURE_DURATION_MS) return;

    const horizontalSwipe = absX >= HORIZONTAL_SWIPE_THRESHOLD_PX && absX > absY + SWIPE_AXIS_BIAS_PX;
    if (horizontalSwipe) {
      const fromLeftEdge = gesture.x <= EDGE_SWIPE_ZONE_PX;
      if (!showDrawer && fromLeftEdge && deltaX > 0) {
        setShowDrawer(true);
      }
      return;
    }

    if (mobileView === 'preview' || chatMode) {
      return;
    }

    const verticalSwipe = absY >= VERTICAL_SWIPE_THRESHOLD_PX && absY > absX + SWIPE_AXIS_BIAS_PX;
    if (!verticalSwipe) return;

    if (deltaY > 0 && !keybarOpen) {
      onToggleKeybar?.();
      return;
    }
    if (deltaY < 0 && keybarOpen) {
      onToggleKeybar?.();
    }
  }, [chatMode, keybarOpen, mobileView, onToggleKeybar, showDrawer]);

  const handleTopRowTouchCancel = useCallback(() => {
    topRowGestureRef.current = null;
  }, []);

  useEffect(() => {
    if (!showOverflow) return;
    overflowRef.current?.querySelector('button:not(:disabled)')?.focus();
    const handlePointerDown = (event) => {
      if (!overflowRef.current?.contains(event.target) && !overflowTriggerRef.current?.contains(event.target)) setShowOverflow(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowOverflow(false);
        overflowTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showOverflow]);

  useEffect(() => { setShowOverflow(false); }, [mobileView, activeSessionId, isWorkspaceStart, showDrawer]);

  useEffect(() => {
    if (!showTitle) return;
    titlePanelRef.current?.querySelector('button')?.focus();
    const onPointerDown = event => {
      if (!titlePanelRef.current?.contains(event.target) && !titleTriggerRef.current?.contains(event.target)) setShowTitle(false);
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setShowTitle(false);
      titleTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [showTitle]);
  useEffect(() => { setShowTitle(false); }, [mobileView, activeSessionId, isWorkspaceStart, showDrawer]);

  const overflowItems = [
    { label: newSessionLabel, onClick: () => onCreateSession?.() },
    activeVisibleSession && isStructuredSessionId(activeVisibleSession.id) && !isPreviewView && onFindInThread ? {
      label: 'Find in thread',
      onClick: onFindInThread,
    } : null,
    activeVisibleSession && !activeVisibleSession.thread?.archived && !isPreviewView ? {
      label: 'Rename thread',
      disabled: !onRenameSession,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      ),
      onClick: () => handleStartRename(activeSessionId)
    } : null,
    activeVisibleSession && !activeVisibleSession.thread?.archived && !isPreviewView && (onPinSession || onUnpinSession) ? {
      label: activeVisibleSession.thread?.pinned ? 'Unpin thread' : 'Pin thread',
      disabled: pinPending || archivePending || !(activeVisibleSession.thread?.pinned ? onUnpinSession : onPinSession),
      onClick: () => handlePinFromMenu(activeVisibleSession.id, Boolean(activeVisibleSession.thread?.pinned)),
    } : null,
    activeVisibleSession && !isPreviewView && (onArchiveSession || onUnarchiveSession) ? {
      label: activeVisibleSession.thread?.archived ? 'Restore thread' : 'Archive thread',
      disabled: archivePending || pinPending || !(activeVisibleSession.thread?.archived ? onUnarchiveSession : onArchiveSession),
      onClick: () => handleArchiveFromMenu(activeVisibleSession.id, Boolean(activeVisibleSession.thread?.archived)),
    } : null,
    activeVisibleSession && isStructuredSessionId(activeVisibleSession.id) && !activeVisibleSession.thread?.archived && !isPreviewView
      && onUpdateThreadMetadata && activeVisibleSession.threadLifecycle?.supported === true
      && (activeVisibleSession.threadLifecycle.snoozed || !activeVisibleSession.threadLifecycle.requiresAttention) ? {
      label: activeVisibleSession.threadLifecycle.snoozed ? 'Wake thread' : 'Snooze for one hour',
      disabled: snoozePending,
      onClick: () => handleSnoozeFromMenu(activeVisibleSession.id, Boolean(activeVisibleSession.threadLifecycle.snoozed)),
    } : null,
    activeVisibleSession?.runtime === 'v4' && !activeVisibleSession.thread?.archived && !isPreviewView
      && onUpdateThreadMetadata && activeVisibleSession.threadLifecycle?.settlementSupported === true
      && activeVisibleSession.threadLifecycle.requiresAttention === false
      && (activeVisibleSession.threadLifecycle.settled || activeVisibleSession.threadLifecycle.canSettle === true) ? {
      label: activeVisibleSession.threadLifecycle.settled ? 'Un-settle thread' : 'Settle thread',
      disabled: snoozePending,
      onClick: () => handleSettlementFromMenu(activeVisibleSession.id, Boolean(activeVisibleSession.threadLifecycle.settled)),
    } : null,
    activeVisibleSession && !activeVisibleSession.thread?.archived && !isPreviewView ? {
      label: 'Close thread',
      disabled: closePending || !onCloseSession,
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
      danger: true,
      onClick: () => handleCloseFromMenu(activeSessionId)
    } : null,
    activeVisibleSession && !isStructuredSessionId(activeVisibleSession.id) && !isPreviewView && !chatMode ? {
      label: keybarOpen ? 'Hide keyboard bar' : 'Show keyboard bar',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
          <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
        </svg>
      ),
      onClick: () => onToggleKeybar?.(),
      active: keybarOpen
    } : null,
  ].filter(Boolean);

  return (
    <>
      <header
        ref={headerRef}
        className={`mobile-header mobile-ui${isNavCollapsed ? ' nav-collapsed' : ''}${isPreviewView ? ' preview-mode' : ''}${isKeyboardCompact ? ' keyboard-compact' : ''} single-row`}
      >
        <div
          className="mobile-header-top-row"
          onTouchStart={handleTopRowTouchStart}
          onTouchEnd={handleTopRowTouchEnd}
          onTouchCancel={handleTopRowTouchCancel}
        >
          <button
            className="mobile-header-btn-modern"
            onClick={() => setShowDrawer(true)}
            aria-label="Menu"
            aria-expanded={showDrawer}
            aria-haspopup="dialog"
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          {activeVisibleSession && !isPreviewView ? <button ref={titleTriggerRef} type="button" className="mobile-header-title-block mobile-header-title-trigger"
            aria-label={`Show full thread title: ${title}`} aria-expanded={showTitle} aria-haspopup="dialog" aria-controls={showTitle ? titlePanelId : undefined}
            onClick={() => setShowTitle(open => !open)}>
            <span className="mobile-header-title-line"><span className="mobile-header-current-thread" title={title}>{title}</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></span>
            {(projectLabel || activeVisibleSession?.thread?.archived) && <span className="mobile-header-project-context" title={activeVisibleSession?.thread?.archived ? `${currentPath ? `${currentPath} · ` : ''}Archived` : currentPath} aria-label={activeVisibleSession?.thread?.archived ? `${projectLabel ? `${projectLabel}, ` : ''}Archived thread` : undefined}>{projectLabel}{projectLabel && activeVisibleSession?.thread?.archived ? ' · ' : ''}{activeVisibleSession?.thread?.archived ? 'Archived' : ''}</span>}
          </button> : <div className="mobile-header-title-block"><span className="mobile-header-current-thread" title={title}>{title}</span>
            {(projectLabel || activeVisibleSession?.thread?.archived) && <span className="mobile-header-project-context" title={activeVisibleSession?.thread?.archived ? `${currentPath ? `${currentPath} · ` : ''}Archived` : currentPath} aria-label={activeVisibleSession?.thread?.archived ? `${projectLabel ? `${projectLabel}, ` : ''}Archived thread` : undefined}>{projectLabel}{projectLabel && activeVisibleSession?.thread?.archived ? ' · ' : ''}{activeVisibleSession?.thread?.archived ? 'Archived' : ''}</span>}
          </div>}

          <div className="mobile-header-actions-right">
            <button
              type="button"
              className="mobile-header-btn-modern"
              aria-label={terminalLabel}
              title={terminalLabel}
              aria-pressed={threadTerminalAvailable ? Boolean(threadTerminalOpen && !isPreviewView) : undefined}
              disabled={threadTerminalAvailable ? false : terminalAvailable ? !onViewChange : !onCreateTerminal}
              onClick={() => threadTerminalAvailable ? onToggleThreadTerminal() : terminalAvailable ? onViewChange?.('terminal') : onCreateTerminal?.()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
            </button>
            <button
              type="button"
              className={`mobile-header-btn-modern${showFileManager ? ' active' : ''}`}
              aria-label="Files"
              title="Files"
              aria-pressed={Boolean(showFileManager)}
              disabled={!onToggleFileManager}
              onClick={() => onToggleFileManager?.()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            </button>
            {gitControl || <button
              type="button"
              className="mobile-header-btn-modern"
              aria-label="Git"
              title="Git"
              onClick={() => onOpenGit?.()}
              disabled={!onOpenGit}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            </button>}
            <div className="mobile-header-overflow">
              <button
                ref={overflowTriggerRef}
                className="mobile-header-btn-modern"
                type="button"
                aria-label="More actions"
                aria-expanded={showOverflow}
                aria-controls={showOverflow ? overflowId : undefined}
                onClick={() => setShowOverflow(open => !open)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
              {showOverflow && (
                <div
                  ref={overflowRef}
                  id={overflowId}
                  className="mobile-header-overflow-panel"
                  role="group"
                  aria-label="More actions"
                  onBlur={event => {
                    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== overflowTriggerRef.current) setShowOverflow(false);
                  }}
                >
                  {overflowItems.map((item) => (
                    <button
                      aria-pressed={item.label === 'Files' ? Boolean(showFileManager) : undefined}
                      key={item.label}
                      type="button"
                      disabled={item.disabled}
                      title={item.title}
                      className={`mobile-header-overflow-item${item.active ? ' active' : ''}${item.danger ? ' danger' : ''}`}
                      onClick={() => {
                        setShowOverflow(false);
                        overflowTriggerRef.current?.focus();
                        item.onClick?.();
                      }}
                    >
                      {item.icon && <span aria-hidden="true">{item.icon}</span>}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {showTitle && activeVisibleSession && !isPreviewView && <div ref={titlePanelRef} id={titlePanelId} className="mobile-header-title-panel" role="dialog" aria-label="Thread title"
          onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== titleTriggerRef.current) setShowTitle(false); }}>
          <p className="mobile-header-title-full">{title}</p>
          {currentPath && <p className="mobile-header-title-path">{currentPath}</p>}
          <button type="button" onClick={() => { setShowTitle(false); titleTriggerRef.current?.focus(); }}>Close</button>
        </div>}
        {closeFeedback && closeFeedback.sessionId === activeVisibleSession?.id && !isPreviewView && !showDrawer && (
          <div className="mobile-header-close-feedback" role="group" aria-label="Thread close status" aria-busy={closePending}>
            {closeFeedback.error ? <>
              <p role="alert">{closeFeedback.error}</p>
              <button type="button" onClick={() => { overflowTriggerRef.current?.focus(); handleCloseFromMenu(closeFeedback.sessionId); }}>Retry</button>
              <button type="button" aria-label="Dismiss close error" onClick={() => { setCloseFeedback(null); overflowTriggerRef.current?.focus(); }}>Dismiss</button>
            </> : <p role="status">Closing {closeFeedback.title}…</p>}
          </div>
        )}
        {pinFeedback && pinFeedback.sessionId === activeVisibleSession?.id && !isPreviewView && !showDrawer && (
          <div className="mobile-header-close-feedback" role="group" aria-label="Thread pin status" aria-busy={pinPending}>
            {pinFeedback.error ? <>
              <p role="alert">{pinFeedback.error}</p>
              <button type="button" aria-label="Retry pin" onClick={() => { overflowTriggerRef.current?.focus(); handlePinFromMenu(pinFeedback.sessionId, pinFeedback.pinned); }}>Retry</button>
              <button type="button" aria-label="Dismiss pin error" onClick={() => { setPinFeedback(null); overflowTriggerRef.current?.focus(); }}>Dismiss</button>
            </> : <p role="status">{pinFeedback.pinned ? 'Unpinning' : 'Pinning'} thread…</p>}
          </div>
        )}
        {archiveFeedback && archiveFeedback.sessionId === activeVisibleSession?.id && !isPreviewView && !showDrawer && (
          <div className="mobile-header-close-feedback" role="group" aria-label="Thread archive status" aria-busy={archivePending}>
            {archiveFeedback.error ? <>
              <p role="alert">{archiveFeedback.error}</p>
              <button type="button" aria-label="Retry archive" onClick={() => { overflowTriggerRef.current?.focus(); handleArchiveFromMenu(archiveFeedback.sessionId, archiveFeedback.archived); }}>Retry</button>
              <button type="button" aria-label="Dismiss archive error" onClick={() => { setArchiveFeedback(null); overflowTriggerRef.current?.focus(); }}>Dismiss</button>
            </> : <p role="status">{archiveFeedback.archived ? 'Restoring' : 'Archiving'} thread…</p>}
          </div>
        )}
        {snoozeFeedback && snoozeFeedback.sessionId === activeVisibleSession?.id && !isPreviewView && !showDrawer && (
          <div className="mobile-header-close-feedback" role="group" aria-label={snoozeFeedback.kind === 'settlement' ? 'Thread settlement status' : 'Thread snooze status'} aria-busy={snoozePending}>
            {snoozeFeedback.error ? <>
              <p role="alert">{snoozeFeedback.error}</p>
              <button type="button" aria-label={snoozeFeedback.kind === 'settlement' ? 'Retry settlement change' : 'Retry snooze change'} onClick={() => snoozeFeedback.kind === 'settlement' ? handleSettlementFromMenu(snoozeFeedback.sessionId, snoozeFeedback.settled) : handleSnoozeFromMenu(snoozeFeedback.sessionId, snoozeFeedback.snoozed)}>Retry</button>
              <button type="button" aria-label={snoozeFeedback.kind === 'settlement' ? 'Dismiss settlement error' : 'Dismiss snooze error'} onClick={() => setSnoozeFeedback(null)}>Dismiss</button>
            </> : <p role="status">{snoozeFeedback.kind === 'settlement' ? (snoozeFeedback.settled ? 'Un-settling' : 'Settling') : (snoozeFeedback.snoozed ? 'Waking' : 'Snoozing')} thread…</p>}
          </div>
        )}
      </header>

      {renameIsCurrent && <MobileThreadRenameDialog sessionId={renameTarget.sessionId} initialTitle={renameTarget.title} pending={renamePending} onSave={handleSaveRename} onClose={closeRename} />}

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onCreateTerminal={onCreateTerminal}
        serverControl={serverControl}
        newSessionLabel={newSessionLabel}
        workspaceActions={workspaceActions}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenWorkspaceBrowser={onOpenWorkspaceBrowser}
        chatMode={chatMode}
        onToggleChatMode={showConversationToggle ? onToggleChatMode : undefined}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
        onOpenBrowserSettings={onOpenBrowserSettings}
        onOpenBookmarks={onOpenBookmarks}
        onOpenNotes={onOpenNotes}
        onOpenProcessManager={onOpenProcessManager}
        onLogout={onLogout}
        projects={projects}
        projectsLoading={projectsLoading}
        onFolderSelect={onFolderSelect}
        currentPath={currentPath}
        onAddScanFolder={onAddScanFolder}
        mobileView={mobileView}
        onViewChange={onViewChange}
        previewUrl={previewUrl}
        activeSessions={visibleActiveSessions}
        sessionLoadError={sessionLoadError}
        archivedSessions={archivedSessions}
        onUnarchiveSession={onUnarchiveSession}
        activeSessionId={isWorkspaceStart ? null : activeSessionId}
        sessionActivity={sessionActivity}
        onSelectSession={onSelectSession}
        onSelectHistoryResult={onSelectHistoryResult}
        sessionsGroupedByProject={sessionsGroupedByProject}
        showViewTabs={showDrawerViewTabs && showPreviewNavigation}
      />
    </>
  );
}
