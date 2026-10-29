import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { getCompactSessionSubtitle, getSessionDisplayInfo } from '../utils/sessionDisplay';
import { downloadProjectArchive } from '../utils/projectArchiveDownload';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { isSettledThread, isSnoozedThread } from '../utils/threadLifecycle';
import { useSnoozeExpiry } from '../hooks/useSnoozeExpiry';
import { applyProjectOrder, moveRelative, stepTarget } from '../utils/threadOrder';
import { normalizeProjectPath } from '../utils/projectPaths';
import { useThreadOrder } from '../hooks/useThreadOrder';
import { useTouchReorder } from '../hooks/useTouchReorder';
import ThreadLineageDialog from './ThreadLineageDialog';
import './MobileUI.css';
import './ThreadRelations.css';

function formatRelativeTime(timestamp) {
  if (!timestamp) return null;

  const now = Date.now();
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = now - time;

  if (!Number.isFinite(diff) || diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(days / 7)}w ago`;
}

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function DisclosureChevron({ expanded }) {
  return <span className={`collapsible-chevron-modern${expanded ? ' expanded' : ''}`} aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
  </span>;
}

function SessionStateIndicator({ isBusy, showReady, needsRecovery }) {
  if (needsRecovery) return <span className="mobile-session-state-indicator" aria-label="Needs attention" title="Needs attention">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--warning)" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 4.5v4.2M8 11v.2" strokeLinecap="round" /></svg>
  </span>;
  if (!isBusy && !showReady) return null;

  return (
    <span
      className={`mobile-session-state-indicator${isBusy ? ' busy' : ' ready'}`}
      aria-label={isBusy ? 'Working' : 'Ready to review'}
    >
      {isBusy ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="var(--border-default)" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="var(--accent-primary)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="mobile-session-state-dot" aria-hidden="true" />
      )}
    </span>
  );
}

export function MobileDrawer({
  isOpen,
  onClose,
  onCreateSession,
  onCreateTerminal,
  serverControl = null,
  newSessionLabel = 'New thread',
  workspaceActions = null,
  theme = 'dark',
  onToggleTheme,
  onOpenWorkspaceBrowser,
  chatMode = false,
  onToggleChatMode,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenBookmarks,
  onOpenNotes,
  onOpenProcessManager,
  onLogout,
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  currentPath,
  onAddScanFolder = null,
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  activeSessions = [],
  archivedSessions = [],
  sessionLoadError = false,
  sessionsLoading = false,
  onUnarchiveSession,
  activeSessionId,
  sessionActivity,
  onSelectSession,
  onSelectHistoryResult,
  sessionsGroupedByProject = [],
  showViewTabs = true
}) {
  const drawerSwipeRef = useRef(null);
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const threadSearchRef = useRef(null);
  const threadNodesRef = useRef(new Map());
  const restoreThreadFocusRef = useRef(null);
  const restoreRequestRef = useRef(null);
  const threadOrder = useThreadOrder({ enabled: isOpen });
  const [relatedFor, setRelatedFor] = useState(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  const [restorePendingId, setRestorePendingId] = useState(null);
  const [restoreError, setRestoreError] = useState(null);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [searchArchivedExpanded, setSearchArchivedExpanded] = useState(true);
  const overlayRef = useRef(null);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const searchingThreads = Boolean(threadSearch.trim());
  const showArchivedThreads = searchingThreads ? searchArchivedExpanded : archivedExpanded;
  const [historySearch, setHistorySearch] = useState({ rows: [], loading: false, error: '' });

  useEffect(() => {
    const query = threadSearch.trim();
    if (!isOpen || !query) {
      setHistorySearch({ rows: [], loading: false, error: '' });
      return undefined;
    }
    const controller = new AbortController();
    const authScope = captureAuthScope();
    const environmentSignal = getEnvironmentSignal();
    const scopeCurrent = () => !controller.signal.aborted && !environmentSignal.aborted && isAuthScopeCurrent(authScope);
    const scopeChanged = () => {
      if (scopeCurrent()) return;
      controller.abort();
      setThreadSearch('');
      setHistorySearch({ rows: [], loading: false, error: '' });
    };
    const unsubscribeAuth = subscribeAuth(scopeChanged);
    const unsubscribeEnvironment = subscribeEnvironment(scopeChanged);
    setHistorySearch({ rows: [], loading: true, error: '' });
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: '20' });
        const response = await apiFetch('/api/workspace/history?' + params, { signal: controller.signal });
        const rows = await response.json();
        if (!response.ok) throw new Error(rows?.error || 'Unable to search conversation content');
        if (!Array.isArray(rows)) throw new Error('Unable to read conversation results');
        if (scopeCurrent()) setHistorySearch({ rows, loading: false, error: '' });
      } catch (error) {
        if (scopeCurrent()) setHistorySearch({ rows: [], loading: false, error: error.message || 'Unable to search conversation content' });
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); unsubscribeAuth(); unsubscribeEnvironment(); };
  }, [isOpen, threadSearch]);

  const visibleThreadGroups = useMemo(() => {
    const groups = sessionsGroupedByProject?.length ? sessionsGroupedByProject : [{
      projectName: 'Threads',
      sessions: activeSessions,
    }];
    const query = threadSearch.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        sessions: applyProjectOrder((group.sessions || []).filter(session => !session.thread?.archived), threadOrder.orders, () => normalizeProjectPath(group.projectPath), { pinnedFirst: true }).filter((session) => {
          const display = getSessionDisplayInfo(session, 'Terminal');
          return !query || [group.projectName, group.projectPath, display.primaryLabel, display.secondaryLabel, display.projectPath, session.title]
            .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
        })
      }))
      .filter((group) => group.sessions.length > 0);
  }, [sessionsGroupedByProject, activeSessions, threadSearch, threadOrder.orders]);

  const projectIdsByKey = useMemo(() => {
    const ids = new Map();
    for (const group of sessionsGroupedByProject || []) {
      const key = normalizeProjectPath(group.projectPath);
      if (!key) continue;
      const live = (group.sessions || []).filter(session => !session.thread?.archived);
      ids.set(key, applyProjectOrder(live, threadOrder.orders, () => key, { pinnedFirst: true }).map(session => session.id));
    }
    return ids;
  }, [sessionsGroupedByProject, threadOrder.orders]);
  const allKnownSessions = useMemo(() => [...new Map([
    ...activeSessions, ...archivedSessions, ...(sessionsGroupedByProject || []).flatMap(group => group.sessions || []),
  ].map(session => [session.id, session])).values()], [activeSessions, archivedSessions, sessionsGroupedByProject]);
  const commitMove = (session, key, targetId, after) => {
    const next = moveRelative(projectIdsByKey.get(key) || [], session.id, targetId, after);
    if (!next) return Promise.resolve({ ok: true });
    restoreThreadFocusRef.current = session.id;
    setMoveAnnouncement(`Moved ${getSessionDisplayInfo(session, 'Terminal').primaryLabel} to position ${next.indexOf(session.id) + 1} of ${next.length}`);
    return threadOrder.reorder(key, next);
  };
  const reorderTargets = useRef({});
  const touchReorder = useTouchReorder({
    onDrop: (id, targetId, after) => {
      const entry = reorderTargets.current[id];
      if (entry) commitMove(entry.session, entry.key, targetId, after);
    },
  });

  const snoozeTick = useSnoozeExpiry(activeSessions);
  const { workingGroups, snoozedGroups, settledGroups, otherGroups, workingCount } = useMemo(() => {
    const workingGroups = [];
    const snoozedGroups = [];
    const settledGroups = [];
    const otherGroups = [];
    let workingCount = 0;
    for (const group of visibleThreadGroups) {
      const working = [];
      const snoozed = [];
      const settled = [];
      const other = [];
      for (const session of group.sessions) {
        const activity = sessionActivity?.[session.id];
        const isBusy = typeof activity?.isBusy === 'boolean' ? activity.isBusy : Boolean(session.isBusy);
        const needsRecovery = ['cleanup_required', 'reconciliation_required'].includes(session.status);
        if (!needsRecovery && isSnoozedThread(session, activity)) snoozed.push(session);
        else if (!sessionLoadError && !needsRecovery && isSettledThread(session, activity)) settled.push(session);
        else if (!sessionLoadError && isBusy && ['accepted', 'running'].includes(session.status) && !needsRecovery && session.threadLifecycle?.supported === true
          && session.threadLifecycle.requiresAttention === false && !session.thread?.pinned && session.id !== activeSessionId) working.push(session);
        else other.push(session);
      }
      if (working.length) { workingGroups.push({ ...group, sessions: working }); workingCount += working.length; }
      if (snoozed.length) snoozedGroups.push({ ...group, sessions: snoozed });
      if (settled.length) settledGroups.push({ ...group, sessions: settled });
      if (other.length) otherGroups.push({ ...group, sessions: other });
    }
    return { workingGroups, snoozedGroups, settledGroups, otherGroups, workingCount };
  }, [visibleThreadGroups, sessionActivity, activeSessionId, sessionLoadError, snoozeTick]);

  useLayoutEffect(() => {
    const id = restoreThreadFocusRef.current;
    restoreThreadFocusRef.current = null;
    if (!isOpen || !id || document.activeElement !== document.body) return;
    const target = threadNodesRef.current.get(id);
    if (target) target.focus();
  });

  const visibleArchived = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    return archivedSessions.filter(session => {
      if (!session.thread?.archived) return false;
      const display = getSessionDisplayInfo(session, 'Terminal');
      return !query || [display.primaryLabel, display.secondaryLabel, display.projectPath, session.title]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(query));
    });
  }, [archivedSessions, threadSearch]);

  useEffect(() => {
    const invalidate = () => { restoreRequestRef.current = null; setRestorePendingId(null); setRestoreError(null); };
    const scopeChanged = () => {
      const request = restoreRequestRef.current;
      if (!request || request.environment.aborted || !isAuthScopeCurrent(request.auth)) invalidate();
    };
    const unsubscribeAuth = subscribeAuth(scopeChanged);
    const unsubscribeEnvironment = subscribeEnvironment(scopeChanged);
    return () => { restoreRequestRef.current = null; unsubscribeAuth(); unsubscribeEnvironment(); };
  }, []);
  useEffect(() => {
    if (!isOpen) { restoreRequestRef.current = null; setRestorePendingId(null); setRestoreError(null); }
  }, [isOpen]);

  const restoreArchived = async sessionId => {
    if (!isOpen || restoreRequestRef.current || !onUnarchiveSession || !archivedSessions.some(session => session.id === sessionId && session.thread?.archived)) return;
    const request = { auth: captureAuthScope(), environment: getEnvironmentSignal() };
    const opener = document.activeElement;
    restoreRequestRef.current = request;
    setRestorePendingId(sessionId);
    setRestoreError(null);
    try {
      const result = await onUnarchiveSession(sessionId);
      if (result?.ok === false) throw result.error || new Error('Try again.');
    } catch (failure) {
      if (restoreRequestRef.current === request && !request.environment.aborted && isAuthScopeCurrent(request.auth)) setRestoreError({ sessionId, message: `Could not restore thread. ${failure?.message || 'Try again.'}` });
    } finally {
      if (restoreRequestRef.current === request) {
        restoreRequestRef.current = null;
        setRestorePendingId(null);
        requestAnimationFrame(() => {
          if (request.environment.aborted || !isAuthScopeCurrent(request.auth) || document.activeElement !== document.body || drawerRef.current?.getAttribute('aria-hidden') !== 'false') return;
          if (opener?.isConnected && opener !== document.body && !opener.disabled) opener.focus();
          else threadSearchRef.current?.focus();
        });
      }
    }
  };

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen || !drawerRef.current) return;
    const previousFocused = document.activeElement;
    const drawer = drawerRef.current;
    const inertElements = [];
    let current = drawer;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling !== current && sibling !== overlayRef.current && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          inertElements.push(sibling);
        }
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    closeButtonRef.current?.focus();
    let focusFrame;
    const focusAfterPaint = () => {
      if (document.activeElement === previousFocused || document.activeElement === document.body) {
        closeButtonRef.current?.focus();
      }
    };
    focusFrame = requestAnimationFrame(() => {
      focusAfterPaint();
      // Chromium can defer removing inertness until this frame's paint.
      focusFrame = requestAnimationFrame(focusAfterPaint);
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      for (const element of inertElements) element.removeAttribute('inert');
      const focusIsInDrawer = drawer.contains(document.activeElement);
      if ((focusIsInDrawer || document.activeElement === document.body) && previousFocused?.isConnected) {
        previousFocused.focus?.();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;

    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const handleKeyDown = (event) => {
      const targetDialog = event.target instanceof Element ? event.target.closest('[role="dialog"]') : null;
      if (targetDialog && targetDialog !== drawerRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const drawer = drawerRef.current;
      if (!drawer) return;

      const focusableElements = Array.from(drawer.querySelectorAll(focusableSelector)).filter(element => !element.closest('[hidden], [inert]'));
      if (focusableElements.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (!drawer.contains(activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
        return;
      }

      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const normalizePath = (value) => value?.toLowerCase().replace(/\/$/, '');
  const currentNormalized = normalizePath(currentPath);

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter((project) =>
      project.name.toLowerCase().includes(query)
      || project.path.toLowerCase().includes(query)
      || (project.branch || '').toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  const openAction = (callback) => {
    onClose();
    callback?.();
  };

  const handleViewChange = (view) => {
    onViewChange?.(view);
    onClose();
  };

  const handleSelectSession = (sessionId) => {
    onSelectSession?.(sessionId);
    onClose();
  };

  const renderThreadGroups = (groups) => groups.map((group) => (
    <div key={group.projectPath || group.projectName} className="mobile-drawer-project-modern">
      <div className="mobile-drawer-project-header-modern">
        <span className="mobile-drawer-project-icon-modern"><FolderGlyph /></span>
        <span className="mobile-drawer-project-name-modern">{group.projectName}</span>
        <span className="mobile-drawer-project-count-modern">{group.sessions.length}</span>
      </div>
      <div className="mobile-drawer-project-sessions-modern">
        {group.sessions.map((session) => {
          const key = normalizeProjectPath(group.projectPath);
          const pinned = Boolean(session.thread?.pinned);
          const siblings = group.sessions.filter(other => Boolean(other.thread?.pinned) === pinned).map(other => other.id);
          const canReorder = threadOrder.ready && Boolean(key) && siblings.length > 1;
          if (canReorder) reorderTargets.current[session.id] = { session, key };
          const armed = touchReorder.armedId === session.id;
          const mark = touchReorder.mark?.id === session.id ? (touchReorder.mark.after ? 'after' : 'before') : null;
          const up = canReorder ? stepTarget(siblings, session.id, -1) : null;
          const down = canReorder ? stepTarget(siblings, session.id, 1) : null;
          const display = getSessionDisplayInfo(session, 'Terminal');
          const subtitle = getCompactSessionSubtitle(session, 'Terminal');
          const lastActivity = sessionActivity?.[session.id]?.lastActivity || session.updatedAt;
          const relativeTime = formatRelativeTime(lastActivity);
          const isActive = session.id === activeSessionId;
          const hasAttention = Boolean(sessionActivity?.[session.id]?.needsAttention);
          const isBusy = typeof sessionActivity?.[session.id]?.isBusy === 'boolean' ? sessionActivity[session.id].isBusy : Boolean(session.isBusy);
          const needsRecovery = ['cleanup_required', 'reconciliation_required'].includes(session.status) || session.threadLifecycle?.requiresAttention === true;
          const title = display.primaryLabel;
          return <div key={session.id} className={`md-thread-row${armed ? ' thread-reorder-armed thread-reorder-active' : ''}${mark ? ` thread-reorder-over-${mark}` : ''}`} data-reorder-id={session.id} {...(canReorder ? touchReorder.bind(session.id, siblings) : {})}>
            <div className="md-thread-row-main"><button ref={node => {
            const previous = threadNodesRef.current.get(session.id);
            if (node) threadNodesRef.current.set(session.id, node);
            else {
              if (previous && document.activeElement === previous) restoreThreadFocusRef.current = session.id;
              threadNodesRef.current.delete(session.id);
            }
          }} type="button" className={`mobile-drawer-thread-item-modern${isActive ? ' active' : ''}`} aria-current={isActive ? 'true' : undefined} onClick={() => handleSelectSession(session.id)}>
            <div className="thread-item-main-modern">
              <span id={`md-thread-title-${session.id}`} className="thread-item-title-modern">{display.primaryLabel}</span>
              {subtitle && <span className="thread-item-subtitle-modern">{subtitle}</span>}
            </div>
            <div className="thread-item-meta-modern">
              {session.thread?.pinned && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Pinned thread"><title>Pinned thread</title><path d="m16 3 5 5-4 1-3 5v4l-3-3-6 6 6-6-3-3h4l5-3z" /></svg>}
              <SessionStateIndicator isBusy={isBusy} needsRecovery={needsRecovery} showReady={!isBusy && hasAttention && !isActive} />
              {relativeTime && <span className="thread-item-time-modern">{relativeTime}</span>}
            </div>
          </button>
            <button type="button" className="md-thread-related" aria-label="Thread options" aria-describedby={`md-thread-title-${session.id}`} aria-expanded={armed} onClick={() => (armed ? touchReorder.disarm() : touchReorder.arm(session.id))}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
            </button></div>
            {armed && <div className="thread-reorder-bar" role="group" aria-label={`Organize ${title}`}>
              {up && <button type="button" onClick={() => commitMove(session, key, up.targetId, up.after)}>Move up</button>}
              {down && <button type="button" onClick={() => commitMove(session, key, down.targetId, down.after)}>Move down</button>}
              <button type="button" onClick={() => { touchReorder.disarm(); setRelatedFor(session.id); }}>Related threads</button>
              <button type="button" onClick={touchReorder.disarm}>Done</button>
            </div>}
          </div>;
        })}
      </div>
    </div>
  ));

  const handleDrawerSwipeStart = (event) => {
    if (!isOpen) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    drawerSwipeRef.current = { x: touch.clientX, y: touch.clientY, startedAt: Date.now() };
  };

  const handleDrawerSwipeEnd = (event) => {
    const swipe = drawerSwipeRef.current;
    drawerSwipeRef.current = null;
    if (!swipe) return;

    const touch = event.changedTouches?.[0];
    if (!touch) return;

    const elapsed = Date.now() - swipe.startedAt;
    const deltaX = touch.clientX - swipe.x;
    const deltaY = touch.clientY - swipe.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (elapsed <= 700 && deltaX <= -56 && absX > absY + 16) {
      onClose();
    }
  };

  const viewTabs = [
    { key: 'terminal', label: 'Workspace' },
    { key: 'preview', label: 'Preview' }
  ];

  const menuItems = [
    {
      label: 'Process Manager',
      onClick: () => openAction(onOpenProcessManager),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )
    },
    {
      label: 'Bookmarks',
      onClick: () => openAction(onOpenBookmarks),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      )
    },
    {
      label: 'Notes',
      onClick: () => openAction(onOpenNotes),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      )
    },
  ];

  return (
    <>
      <div ref={overlayRef} className={`mobile-drawer-overlay-modern mobile-ui${isOpen ? ' open' : ''}`} onClick={() => onClose()} aria-hidden="true" />
      <div
        ref={drawerRef}
        className={`mobile-drawer-modern mobile-ui${isOpen ? ' open' : ''}`}
        aria-hidden={!isOpen}
        inert={!isOpen ? '' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile menu"
        tabIndex={-1}
        onTouchStart={handleDrawerSwipeStart}
        onTouchEnd={handleDrawerSwipeEnd}
        onTouchCancel={() => { drawerSwipeRef.current = null; }}
      >
        {/* Header */}
        <div className="mobile-drawer-header-modern">
          <div className="mobile-drawer-header-top">
            <div className="mobile-drawer-header-copy">
              <h2>Workspace</h2>
              <span>{sessionLoadError ? 'Load failed' : sessionsLoading && activeSessions.length === 0 ? 'Loading…' : `${activeSessions.length} active`}</span>
            </div>
            {serverControl && <div className="mobile-drawer-server-control">{serverControl}</div>}
            <button ref={closeButtonRef} className="mobile-drawer-close-modern" onClick={onClose} aria-label="Close menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mobile-drawer-content-modern">
          <div className="mobile-drawer-section-modern">
            <button
              type="button"
              className="md-new-session-btn"
              onClick={() => openAction(onCreateSession)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{newSessionLabel}</span>
            </button>
            <div className="mobile-drawer-section-title-modern">Threads</div>
            <div className="md-thread-search">
              <input ref={threadSearchRef} type="search" className="md-search-input" aria-label="Search threads" placeholder="Search threads" maxLength={256} value={threadSearch} onChange={event => { setThreadSearch(event.target.value); setSearchArchivedExpanded(true); }} />
              {threadSearch && <button type="button" className="md-clear-thread-search" aria-label="Clear thread search" onClick={() => { setThreadSearch(''); threadSearchRef.current?.focus(); }}>×</button>}
            </div>
            <div className="mobile-drawer-threads-modern">
              {threadOrder.error && <div className="thread-reorder-notice" role="status"><span>{threadOrder.error}</span><button type="button" onClick={threadOrder.clearError}>Dismiss</button></div>}
              <div className="threads-sr-only" aria-live="polite">{moveAnnouncement}</div>
              {sessionLoadError && <div className="md-empty-state">Thread list may be incomplete</div>}
              {threadSearch.trim() && <section aria-label="Saved conversation results" className="md-history-results">
                <div className="mobile-drawer-section-title-modern">Conversation content</div>
                {historySearch.loading && <div className="md-empty-state" role="status">Searching saved conversations…</div>}
                {historySearch.error && <div className="md-empty-state" role="alert">{historySearch.error}</div>}
                {!historySearch.loading && !historySearch.error && historySearch.rows.length === 0 && <div className="md-empty-state">No saved conversation matches</div>}
                {historySearch.rows.map(row => <button key={row.sessionId} type="button" className="mobile-drawer-thread-item-modern md-history-result" disabled={!onSelectHistoryResult} onClick={() => { onSelectHistoryResult?.(row); onClose(); }}>
                  <strong>{row.title || 'Untitled conversation'}</strong><span>{row.snippet || 'No saved messages yet.'}</span>
                </button>)}
              </section>}
              {renderThreadGroups(otherGroups)}
              {workingCount > 0 && <section aria-label="Working threads">
                <div className="mobile-drawer-section-collapsible-modern"><span className="collapsible-title-modern">Working ({workingCount})</span></div>
                {renderThreadGroups(workingGroups)}
              </section>}
              {snoozedGroups.length > 0 && <section aria-label="Snoozed threads">
                <div className="mobile-drawer-section-collapsible-modern"><span className="collapsible-title-modern">Snoozed</span></div>
                {renderThreadGroups(snoozedGroups)}
              </section>}
              {settledGroups.length > 0 && <section aria-label="Settled threads">
                <div className="mobile-drawer-section-collapsible-modern"><span className="collapsible-title-modern">Settled</span></div>
                {renderThreadGroups(settledGroups)}
              </section>}
              {visibleThreadGroups.length === 0 && !sessionLoadError && sessionsLoading && <div className="md-empty-state" role="status">Loading threads…</div>}
              {visibleThreadGroups.length === 0 && !sessionLoadError && !sessionsLoading && (
                <div className="md-empty-state">{threadSearch.trim() ? 'No matching active thread names or projects' : 'No active threads'}</div>
              )}
              {visibleArchived.length > 0 && <section aria-label="Archived threads">
                <button type="button" className="mobile-drawer-section-collapsible-modern" aria-expanded={showArchivedThreads} onClick={() => searchingThreads ? setSearchArchivedExpanded(value => !value) : setArchivedExpanded(value => !value)}>
                  <span className="collapsible-title-modern">Archived threads ({visibleArchived.length})</span>
                  <DisclosureChevron expanded={showArchivedThreads} />
                </button>
                {showArchivedThreads && visibleArchived.map(session => {
                  const title = getSessionDisplayInfo(session, 'Thread').primaryLabel;
                  return <div key={session.id}>
                    <button type="button" className="mobile-drawer-thread-item-modern" aria-label={`Restore ${title}`} disabled={Boolean(restorePendingId) || !onUnarchiveSession} onClick={() => restoreArchived(session.id)}>
                      <span className="thread-item-main-modern"><span className="thread-item-title-modern">{title}</span></span>
                      <span className="thread-item-meta-modern">{restorePendingId === session.id ? 'Restoring…' : 'Restore'}</span>
                    </button>
                    {restoreError?.sessionId === session.id && <p role="alert">{restoreError.message}</p>}
                  </div>;
                })}
              </section>}
            </div>
          </div>

          {showViewTabs ? (
            <div className="mobile-drawer-toolbar-modern">
              {viewTabs.map((tab) => {
                const icon = tab.key === 'terminal'
                  ? <TerminalGlyph />
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>;

                return (
                  <button
                    key={tab.key}
                    type="button"
                    className={`mobile-drawer-toolbar-btn-modern${mobileView === tab.key ? ' active' : ''}${tab.disabled ? ' disabled' : ''}`}
                    onClick={() => !tab.disabled && handleViewChange(tab.key)}
                    disabled={tab.disabled}
                    aria-pressed={mobileView === tab.key}
                  >
                    {icon}
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {(workspaceActions || onCreateTerminal) && (
            <section className="mobile-drawer-section-modern md-workspace-actions" aria-label="Project actions">
              <div className="mobile-drawer-section-title-modern">Project</div>
              {workspaceActions}
              {onCreateTerminal && <button type="button" className="md-action-item" onClick={() => openAction(onCreateTerminal)}><span aria-hidden="true">›_</span><span>New terminal</span></button>}
            </section>
          )}

          <section className="mobile-drawer-section-modern" aria-label="Workspace utilities">
            <div className="mobile-drawer-section-title-modern">Utilities</div>
            <div className="md-action-list">
              {onOpenWorkspaceBrowser && (
                <button type="button" className="md-action-item" onClick={() => openAction(onOpenWorkspaceBrowser)}>
                  <span>Browser</span>
                </button>
              )}
              {onToggleChatMode && mobileView !== 'preview' && (
                <button type="button" className="md-action-item" onClick={() => openAction(onToggleChatMode)}>
                  <span>{chatMode ? 'Terminal view' : 'Conversation view'}</span>
                </button>
              )}
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="md-action-item"
                  disabled={Boolean(getActiveEnvironment())}
                  title={getActiveEnvironment() ? "Available on the owning server directly" : undefined}
                  onClick={item.onClick}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="mobile-drawer-section-modern" aria-label="Application settings">
            <div className="mobile-drawer-section-title-modern">Settings</div>
            <div className="md-action-list">
              {onToggleTheme && (
                <button type="button" className="md-action-item" onClick={() => openAction(onToggleTheme)}>
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
              )}
              {onOpenBrowserSettings && (
                <button type="button" className="md-action-item" onClick={() => openAction(onOpenBrowserSettings)}>
                  <span>Browser settings</span>
                </button>
              )}
              {onOpenApiSettings && (
                <button type="button" className="md-action-item" onClick={() => openAction(onOpenApiSettings)}>
                  <span>API settings</span>
                </button>
              )}
              {onLogout && (
                <button type="button" className="md-action-item" onClick={() => openAction(onLogout)}>
                  <span>Sign out</span>
                </button>
              )}
            </div>
          </section>

          <div className="mobile-drawer-section-modern">
            <button className="mobile-drawer-section-collapsible-modern" aria-expanded={projectsExpanded} onClick={() => setProjectsExpanded(!projectsExpanded)} type="button">
              <div className="collapsible-icon-modern"><FolderGlyph /></div>
              <span className="collapsible-title-modern">Projects</span>
              <DisclosureChevron expanded={projectsExpanded} />
            </button>

            {projectsExpanded && (
              <div className="md-projects-body">
                {(projects.length > 0 || onAddScanFolder) && (
                  <div className="md-project-toolbar">
                    {projects.length > 0 && (
                      <div className="md-search-wrap">
                        <svg className="md-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                          type="text"
                          className="md-search-input"
                          placeholder="Search projects..."
                          aria-label="Search projects"
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                        />
                      </div>
                    )}
                    {onAddScanFolder && (
                      <button
                        type="button"
                        className="md-add-project-btn"
                        onClick={() => { onAddScanFolder?.(); onClose(); }}
                      >
                        Add project
                      </button>
                    )}
                  </div>
                )}

                <div className="md-projects-list">
                  {projectsLoading && projects.length === 0 ? (
                    <div className="md-empty-state">Scanning...</div>
                  ) : projects.length === 0 ? (
                    <div className="md-empty-state">No projects found</div>
                  ) : filteredProjects.length === 0 ? (
                    <div className="md-empty-state">No matches found</div>
                  ) : (
                    filteredProjects.map((project) => (
                      <div
                        key={project.path}
                        className={`md-project-row${normalizePath(project.path) === currentNormalized ? ' active' : ''}`}
                      >
                        <button
                          className={`md-project-item${normalizePath(project.path) === currentNormalized ? ' active' : ''}`}
                          onClick={() => { onFolderSelect(project.path); onClose(); }}
                          type="button"
                        >
                          <div className="md-project-info">
                            <span className="md-project-name">{project.name}</span>
                            <span className="md-project-path">{project.path}</span>
                          </div>
                          {project.branch && (
                            <div className="md-project-branch">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="6" y1="3" x2="6" y2="15" />
                                <circle cx="18" cy="6" r="3" />
                                <circle cx="6" cy="18" r="3" />
                                <path d="M18 9a9 9 0 0 1-9 9" />
                              </svg>
                              {project.branch}
                            </div>
                          )}
                        </button>
                        <button
                          type="button"
                          className="md-project-download-btn"
                          onClick={() => downloadProjectArchive(project.path)}
                          aria-label={`Zip and download ${project.name}`}
                          title="Zip and download project"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mobile-drawer-footer-modern">
          <button
            type="button"
            className="md-footer-settings-btn"
            onClick={() => openAction(onOpenSettings)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      </div>
      {relatedFor && allKnownSessions.some(session => session.id === relatedFor) && <ThreadLineageDialog
        session={allKnownSessions.find(session => session.id === relatedFor)}
        sessions={allKnownSessions}
        onOpen={handleSelectSession}
        onClose={() => { restoreThreadFocusRef.current = relatedFor; setRelatedFor(null); }}
      />}
    </>
  );
}
