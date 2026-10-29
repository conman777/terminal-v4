import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ThreadsSessionItem from './ThreadsSessionItem';
import { useTheme } from '../contexts/ThemeContext';
import { apiFetch } from '../utils/api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { normalizeProjectPath } from '../utils/projectPaths';
import { useProjectBranches } from '../hooks/useProjectBranches';
import { projectNameFromPath } from '../utils/projectBadge';
import { isSettledThread, isSnoozedThread } from '../utils/threadLifecycle';
import { applyProjectOrder, moveRelative, stepTarget } from '../utils/threadOrder';
import { useThreadOrder } from '../hooks/useThreadOrder';
import { useSnoozeExpiry } from '../hooks/useSnoozeExpiry';
import ThreadLineageDialog from './ThreadLineageDialog';
import './ThreadRelations.css';
import './ThreadsSidebar.css';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';
import { ThreadsAppsMenu, ThreadsProjectFilter } from './ThreadsSidebarMenus';

function matchesSessionQuery(session, normalizedQuery) {
  if (!normalizedQuery) return true;

  const values = [
    session?.title,
    session?.thread?.topic,
    session?.thread?.projectPath,
    session?.cwd,
  ];

  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery));
}

function matchesGroupQuery(group, normalizedQuery) {
  if (!normalizedQuery) return true;

  return [group?.projectName, group?.projectPath]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery));
}

function sessionProjectPath(session) {
  return normalizeProjectPath(session.thread?.projectPath || session.groupPath || session.cwd);
}

function activityTime(session) {
  const value = Date.parse(session.thread?.lastActivityAt || session.updatedAt || session.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

const APP_ICONS = {
  Browser: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" /></svg>,
  Files: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>,
  Preview: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>,
  Notes: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>,
  Bookmarks: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>,
  Screenshots: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>,
};

export default function ThreadsSidebar({
  isCollapsed,
  workspacePath,
  onSelectHistorySession,
  onSelectHistoryResult,
  historyNavigationNotice,
  onOpenWorkspaceStart,
  onToggle,
  sessionsGroupedByProject,
  pinnedSessions,
  archivedSessions,
  sessionLoadError = false,
  sessionsLoading = false,
  activeSessionId,
  currentSessionId = activeSessionId,
  latestAssistantText,
  readLatestAssistantText,
  onInsertPrompt,
  onInsertContext = onInsertPrompt,
  onCreateTerminal,
  aiOptions,
  sessionActivity,
  onSelectSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
  onUnarchiveSession,
  onMarkUnread,
  onUpdateThreadMetadata,
  onTopicChange,
  onRenameSession,
  onCloseSession,
  onCreateSession,
  onCloseProject,
  projects,
  onAddProject,
  onOpenSettings,
  onOpenBookmarks,
  onOpenScreenshots,
  onOpenNotes,
  showPreview,
  onTogglePreview,
  showBrowser = false,
  onToggleBrowser,
  showFileManager,
  onToggleFileManager,
  serverControl = null,
  logout,
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState(null);
  const [historySearch, setHistorySearch] = useState({ rows: [], loading: false, error: '' });
  const accountMenuRef = useRef(null);
  const searchRef = useRef(null);
  const threadNodesRef = useRef(new Map());
  const restoreThreadFocusRef = useRef(null);
  useLayoutEffect(() => {
    const id = restoreThreadFocusRef.current;
    restoreThreadFocusRef.current = null;
    if (id && document.activeElement === document.body) {
      const target = threadNodesRef.current.get(id)?.querySelector('.threads-session-select');
      if (target) target.focus();
    }
  });
  useEffect(() => {
    const closeAccountMenu = event => {
      const menu = accountMenuRef.current;
      if (menu?.open && !menu.contains(event.target)) menu.open = false;
    };
    document.addEventListener('pointerdown', closeAccountMenu);
    return () => document.removeEventListener('pointerdown', closeAccountMenu);
  }, []);
  const { theme, toggleTheme } = useTheme();
  const threadOrder = useThreadOrder();
  const [relatedFor, setRelatedFor] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const projectGroups = useMemo(() => (
    sessionsGroupedByProject
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => !session.thread?.archived),
        allSessions: [...new Map([
          ...group.sessions,
          ...pinnedSessions.filter(session => sessionProjectPath(session) === normalizeProjectPath(group.projectPath)),
          ...archivedSessions.filter(session => sessionProjectPath(session) === normalizeProjectPath(group.projectPath)),
        ].map(session => [session.id, session])).values()],
      }))
      .filter((group) => group.allSessions.length > 0)
  ), [sessionsGroupedByProject, pinnedSessions, archivedSessions]);

  const visibleProjectGroups = useMemo(() => {
    const groupedPaths = new Set(
      projectGroups.map((group) => normalizeProjectPath(group.projectPath)).filter(Boolean)
    );

    const manualGroups = projects
      .filter((project) => !groupedPaths.has(normalizeProjectPath(project.path)))
      .map((project) => ({
        projectName: project.name,
        projectPath: project.path,
        sessions: [],
        allSessions: [...new Map([...pinnedSessions, ...archivedSessions]
          .filter(session => sessionProjectPath(session) === normalizeProjectPath(project.path))
          .map(session => [session.id, session])).values()],
      }));

    return [...manualGroups, ...projectGroups].map(group => ({ ...group, normalizedPath: normalizeProjectPath(group.projectPath) }));
  }, [projectGroups, projects, pinnedSessions, archivedSessions]);

  const historyPath = projectFilter ? visibleProjectGroups.find(group => group.normalizedPath === projectFilter)?.projectPath : '';
  useEffect(() => {
    if (!normalizedQuery || isCollapsed) {
      setHistorySearch({ rows: [], loading: false, error: '' });
      return undefined;
    }
    if (projectFilter && !historyPath) {
      setHistorySearch({ rows: [], loading: false, error: 'Selected project is no longer available' });
      return undefined;
    }
    const controller = new AbortController();
    const authScope = captureAuthScope();
    const environmentSignal = getEnvironmentSignal();
    const scopeCurrent = () => !controller.signal.aborted && !environmentSignal.aborted && isAuthScopeCurrent(authScope);
    const scopeChanged = () => {
      if (scopeCurrent()) return;
      controller.abort();
      setSearchQuery('');
      setHistorySearch({ rows: [], loading: false, error: '' });
    };
    const unsubscribeAuth = subscribeAuth(scopeChanged);
    const unsubscribeEnvironment = subscribeEnvironment(scopeChanged);
    setHistorySearch({ rows: [], loading: true, error: '' });
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ q: searchQuery.trim(), limit: '20' });
      if (historyPath) params.set('path', historyPath);
      try {
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
  }, [searchQuery, normalizedQuery, historyPath, projectFilter, isCollapsed]);

  const projectNames = useMemo(() => new Map(visibleProjectGroups.map(group => [group.normalizedPath, group.projectName])), [visibleProjectGroups]);
  const matchingProjects = useMemo(() => new Set(visibleProjectGroups.filter(group => normalizedQuery && matchesGroupQuery(group, normalizedQuery)).map(group => group.normalizedPath)), [normalizedQuery, visibleProjectGroups]);
  const isVisible = session => (!projectFilter || sessionProjectPath(session) === projectFilter)
    && (matchesSessionQuery(session, normalizedQuery) || matchingProjects.has(sessionProjectPath(session)));

  const pinnedIds = useMemo(() => new Set(pinnedSessions.map(session => session.id)), [pinnedSessions]);
  const activityOrderedSessions = useMemo(() => (
    visibleProjectGroups.flatMap(group => group.sessions)
      .filter(session => !pinnedIds.has(session.id) && isVisible(session))
      .sort((a, b) => activityTime(b) - activityTime(a))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [visibleProjectGroups, projectFilter, normalizedQuery, matchingProjects, pinnedIds]);
  const recentSessions = useMemo(() => applyProjectOrder(activityOrderedSessions, threadOrder.orders, sessionProjectPath), [activityOrderedSessions, threadOrder.orders]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredPinnedSessions = useMemo(() => applyProjectOrder(pinnedSessions.filter(isVisible), threadOrder.orders, sessionProjectPath), [pinnedSessions, projectFilter, normalizedQuery, matchingProjects, threadOrder.orders]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredArchivedSessions = useMemo(() => archivedSessions.filter(isVisible), [archivedSessions, projectFilter, normalizedQuery, matchingProjects]);
  useSnoozeExpiry([...filteredPinnedSessions, ...recentSessions]);
  const snoozedSessions = [...filteredPinnedSessions, ...recentSessions]
    .filter(session => isSnoozedThread(session, sessionActivity?.[session.id]));
  const snoozedIds = new Set(snoozedSessions.map(session => session.id));
  const settledSessions = [...filteredPinnedSessions, ...recentSessions]
    .filter(session => !sessionLoadError && !snoozedIds.has(session.id) && isSettledThread(session, sessionActivity?.[session.id]));
  const settledIds = new Set(settledSessions.map(session => session.id));
  const workingSessions = recentSessions.filter(session => {
    const activity = sessionActivity?.[session.id];
    const busy = typeof activity?.isBusy === 'boolean' ? activity.isBusy : session.isBusy === true;
    return !sessionLoadError && session.id !== activeSessionId && !snoozedIds.has(session.id) && !settledIds.has(session.id)
      && ['accepted', 'running'].includes(session.status) && busy
      && session.threadLifecycle?.supported === true && session.threadLifecycle.requiresAttention === false;
  });
  const workingIds = new Set(workingSessions.map(session => session.id));

  const branchPaths = useMemo(() => [...recentSessions, ...filteredPinnedSessions].map(session => session.cwd || session.thread?.projectPath), [recentSessions, filteredPinnedSessions]);
  const branches = useProjectBranches(branchPaths);

  const visibleSessionCount = new Set([...filteredPinnedSessions, ...recentSessions, ...filteredArchivedSessions].map(session => session.id)).size;
  const archivedExpanded = Boolean(normalizedQuery) || showArchived;
  const hasAnyThread = recentSessions.length + filteredPinnedSessions.length + filteredArchivedSessions.length > 0;

  const [archivedNotice, setArchivedNotice] = useState(null);
  useEffect(() => {
    if (!archivedNotice) return undefined;
    const timer = setTimeout(() => setArchivedNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [archivedNotice]);
  const handleArchive = async id => {
    const result = await onArchiveSession?.(id);
    if (result !== false) setArchivedNotice({ id });
    return result;
  };

  const allKnownSessions = useMemo(() => [...new Map([
    ...visibleProjectGroups.flatMap(group => group.allSessions), ...pinnedSessions, ...archivedSessions,
  ].map(session => [session.id, session])).values()], [visibleProjectGroups, pinnedSessions, archivedSessions]);

  const commitMove = (session, path, targetId, after) => {
    const current = applyProjectOrder(allKnownSessions.filter(item => !item.thread?.archived && sessionProjectPath(item) === path).sort((a, b) => activityTime(b) - activityTime(a)), threadOrder.orders, sessionProjectPath).map(item => item.id);
    const next = moveRelative(current, session.id, targetId, after);
    if (!next) return Promise.resolve({ ok: true });
    restoreThreadFocusRef.current = session.id;
    setMoveAnnouncement(`Moved ${session.thread?.topic || session.title || 'thread'} to position ${next.indexOf(session.id) + 1} of ${next.length}`);
    return threadOrder.reorder(path, next);
  };

  const reorderFor = (session, list) => {
    const path = sessionProjectPath(session);
    if (!threadOrder.ready || !path || session.thread?.archived) return null;
    const pinned = Boolean(session.thread?.pinned);
    const siblings = list.filter(other => sessionProjectPath(other) === path && Boolean(other.thread?.pinned) === pinned && !other.thread?.archived).map(other => other.id);
    if (siblings.length < 2) return null;
    const up = stepTarget(siblings, session.id, -1);
    const down = stepTarget(siblings, session.id, 1);
    const mark = dragState?.mark?.id === session.id ? (dragState.mark.after ? 'after' : 'before') : null;
    const accepts = Boolean(dragState && dragState.id !== session.id && dragState.siblings.includes(session.id));
    return {
      draggable: true,
      dragging: dragState?.id === session.id,
      dropMark: mark,
      canMoveUp: Boolean(up),
      canMoveDown: Boolean(down),
      onMove: delta => {
        const step = delta < 0 ? up : down;
        return step ? commitMove(session, path, step.targetId, step.after) : Promise.resolve({ ok: true });
      },
      onDragStart: event => {
        event.dataTransfer?.setData('text/plain', session.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        setDragState({ id: session.id, siblings, mark: null });
      },
      onDragOver: event => {
        if (!accepts) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const after = (Number.isFinite(event.clientY) ? event.clientY : 0) > rect.top + rect.height / 2;
        setDragState(current => (current?.mark?.id === session.id && current.mark.after === after ? current : { ...current, mark: { id: session.id, after } }));
      },
      onDragLeave: event => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setDragState(current => (current?.mark?.id === session.id ? { ...current, mark: null } : current));
      },
      onDrop: event => {
        if (!accepts) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const after = dragState.mark?.id === session.id ? dragState.mark.after : (Number.isFinite(event.clientY) ? event.clientY : 0) > rect.top + rect.height / 2;
        const dragged = allKnownSessions.find(item => item.id === dragState.id);
        setDragState(null);
        if (dragged) commitMove(dragged, path, session.id, after);
      },
      onDragEnd: () => setDragState(null),
    };
  };

  const renderCard = (session, _index, list = []) => {
    const path = sessionProjectPath(session);
    return (
      <ThreadsSessionItem
        key={session.id}
        onItemRef={node => {
          const previous = threadNodesRef.current.get(session.id);
          if (node) threadNodesRef.current.set(session.id, node);
          else {
            if (previous?.contains(document.activeElement)) restoreThreadFocusRef.current = session.id;
            threadNodesRef.current.delete(session.id);
          }
        }}
        session={session}
        projectName={projectNames.get(path) || projectNameFromPath(session.thread?.projectPath || session.cwd)}
        branch={branches[session.cwd] ?? branches[session.thread?.projectPath] ?? null}
        isBusy={Boolean(sessionActivity?.[session.id]?.isBusy)}
        isActive={session.id === activeSessionId}
        hasActivity={sessionActivity?.[session.id]?.needsAttention}
        onSelect={onSelectSession}
        onPin={onPinSession}
        onUnpin={onUnpinSession}
        onArchive={handleArchive}
        onUnarchive={onUnarchiveSession}
        onMarkUnread={onMarkUnread}
        onUpdateThreadMetadata={onUpdateThreadMetadata}
        onTopicChange={onTopicChange}
        onRenameSession={onRenameSession}
        onClose={onCloseSession}
        reorder={reorderFor(session, list)}
        onShowRelated={setRelatedFor}
      />
    );
  };

  const apps = [
    ...(onToggleBrowser ? [{ label: 'Browser', icon: APP_ICONS.Browser, active: showBrowser, onSelect: onToggleBrowser }] : []),
    { label: 'Files', icon: APP_ICONS.Files, active: showFileManager, onSelect: onToggleFileManager },
    { label: 'Preview', icon: APP_ICONS.Preview, active: showPreview, onSelect: onTogglePreview },
    { label: 'Notes', icon: APP_ICONS.Notes, onSelect: onOpenNotes },
    { label: 'Bookmarks', icon: APP_ICONS.Bookmarks, onSelect: onOpenBookmarks },
    ...(onOpenScreenshots ? [{ label: 'Screenshots', icon: APP_ICONS.Screenshots, onSelect: onOpenScreenshots }] : []),
  ];

  return (
    <aside className={`pro-sidebar threads-sidebar ${isCollapsed ? 'collapsed' : ''}`} aria-label="Threads">
      {archivedNotice && !isCollapsed && <div className="threads-undo" role="status">
        <span>Thread archived</span>
        <button type="button" onClick={() => { onUnarchiveSession?.(archivedNotice.id); setArchivedNotice(null); }}>Undo</button>
      </div>}
      {threadOrder.error && !isCollapsed && <div className="thread-reorder-notice" role="status">
        <span>{threadOrder.error}</span>
        <button type="button" onClick={threadOrder.clearError}>Dismiss</button>
      </div>}
      <div className="threads-sr-only" aria-live="polite">{moveAnnouncement}</div>
      {relatedFor && allKnownSessions.some(session => session.id === relatedFor) && <ThreadLineageDialog
        session={allKnownSessions.find(session => session.id === relatedFor)}
        sessions={allKnownSessions}
        onOpen={onSelectSession}
        onClose={() => { restoreThreadFocusRef.current = relatedFor; setRelatedFor(null); }}
      />}
      {!isCollapsed && (
        <div className="pro-sidebar-panel">
          <div className="pro-sidebar-header">
            <button className="pro-sidebar-brand" type="button" aria-label="Terminal v4 home" onClick={onOpenWorkspaceStart}>
              <span className="pro-sidebar-kicker">Terminal v4</span>
            </button>
            <div className="pro-sidebar-header-actions">
              {serverControl && <div className="pro-sidebar-server">{serverControl}</div>}
              <button className="pro-sidebar-minimize" type="button" onClick={onToggle} aria-label="Minimize sidebar" aria-expanded={true} title="Hide sidebar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line x1="9" y1="4" x2="9" y2="20" />
                </svg>
              </button>
            </div>
          </div>

          <div className="pro-sidebar-toolbar">
            <div className="pro-sidebar-search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                maxLength={256}
                value={searchQuery}
                onChange={(event) => { setSearchQuery(event.target.value); }}
                onKeyDown={event => { if (event.key === 'Escape') setSearchQuery(''); }}
                placeholder="Search"
                aria-label="Search threads"
              />
              {searchQuery && <button className="pro-sidebar-search-clear" type="button" aria-label="Clear search" title="Clear search" onClick={() => { setSearchQuery(''); searchRef.current?.focus(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>}
            </div>
            <ThreadsProjectFilter projects={visibleProjectGroups} selectedPath={projectFilter} onSelectPath={setProjectFilter}
              onCreateSession={onCreateSession} onCloseProject={onCloseProject} />
            {onAddProject && <button className="pro-toolbar-icon" type="button" onClick={onAddProject} title="Add project" aria-label="Add Project">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" /><path d="M12 11v5M9.5 13.5h5" /></svg>
            </button>}
            {onCreateTerminal && <button className="pro-toolbar-icon" type="button" onClick={onCreateTerminal} aria-label="New terminal" title="New terminal">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 6 6-6 6m9 1h7" /></svg>
            </button>}
            <button className="pro-toolbar-icon" type="button" onClick={() => (onOpenWorkspaceStart || onCreateSession)?.()} aria-label="New thread" title="New thread">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
          </div>

          <div className="pro-sidebar-tree threads-card-list" aria-label={sessionLoadError ? 'Thread list may be incomplete' : `${visibleSessionCount} ${visibleSessionCount === 1 ? 'thread' : 'threads'}`}>
            {historyNavigationNotice && <div className="threads-history-navigation-notice" role="status">{historyNavigationNotice}</div>}
            {sessionLoadError && <div className="pro-empty-state">Thread list may be incomplete</div>}
            {normalizedQuery && <section className="threads-history-results" aria-label="Saved conversation results">
              <div className="pro-section-title">Conversation content</div>
              {historySearch.loading && <div className="pro-empty-state" role="status">Searching saved conversations…</div>}
              {historySearch.error && <div className="pro-empty-state" role="alert">{historySearch.error}</div>}
              {!historySearch.loading && !historySearch.error && historySearch.rows.length === 0 && <div className="pro-empty-state">No saved conversation matches</div>}
              {historySearch.rows.map(row => <button className="threads-history-result" type="button" key={row.sessionId}
                disabled={!onSelectHistoryResult && !onSelectHistorySession && !onSelectSession}
                onClick={() => onSelectHistoryResult ? onSelectHistoryResult(row) : (onSelectHistorySession || onSelectSession)?.(row.sessionId)}>
                <strong>{row.title || 'Untitled conversation'}</strong>
                <span>{row.snippet || 'No saved messages yet.'}</span>
              </button>)}
            </section>}
            {filteredPinnedSessions.some(session => !snoozedIds.has(session.id) && !settledIds.has(session.id)) && (
              <div className="pro-tree-section threads-pinned">
                <div className="pro-section-title">Pinned</div>
                {filteredPinnedSessions.filter(session => !snoozedIds.has(session.id) && !settledIds.has(session.id)).map(renderCard)}
              </div>
            )}

            {workingSessions.length > 0 && <section className="pro-tree-section threads-working" aria-label="Working threads">
              <div className="pro-section-title">Working ({workingSessions.length})</div>
              {workingSessions.map(renderCard)}
            </section>}

            <div className="pro-tree-section threads-recent">
              {recentSessions.filter(session => !snoozedIds.has(session.id) && !settledIds.has(session.id) && !workingIds.has(session.id)).map(renderCard)}
              {!hasAnyThread && !sessionLoadError && sessionsLoading && <div className="pro-empty-state" role="status">Loading threads…</div>}
              {!hasAnyThread && !sessionLoadError && !sessionsLoading && <div className="pro-empty-state">{normalizedQuery ? 'No matching thread names or projects' : projectFilter ? 'No matching threads' : 'No threads yet'}</div>}
            </div>

            {snoozedSessions.length > 0 && <section className="pro-tree-section threads-snoozed" aria-label="Snoozed threads">
              <div className="pro-section-title">Snoozed</div>
              {snoozedSessions.map(renderCard)}
            </section>}

            {settledSessions.length > 0 && <section className="pro-tree-section threads-settled" aria-label="Settled threads">
              <div className="pro-section-title">Settled</div>
              {settledSessions.map(renderCard)}
            </section>}

            {filteredArchivedSessions.length > 0 && (
              <div className="pro-tree-section threads-archived">
                <button
                  className="pro-section-title pro-section-disclosure"
                  type="button"
                  aria-expanded={archivedExpanded}
                  onClick={() => setShowArchived((current) => !current)}
                >
                  <span className={`threads-project-chevron ${archivedExpanded ? 'expanded' : ''}`} aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m9 6 6 6-6 6" /></svg></span>
                  Archived ({filteredArchivedSessions.length})
                </button>
                {archivedExpanded && <div className="pro-archived-list">{filteredArchivedSessions.map(renderCard)}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {!isCollapsed && <footer className="pro-sidebar-footer">
        <button className="pro-sidebar-icon-btn" type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {workspacePath && <WorkspaceToolsButton iconOnly label="Project tools" workspacePath={workspacePath} currentSessionId={currentSessionId} latestAssistantText={latestAssistantText} readLatestAssistantText={readLatestAssistantText} onInsertPrompt={onInsertPrompt} onStartTask={onCreateSession} onSelectSession={onSelectHistorySession || onSelectSession} />}
        {workspacePath && <WorkspaceProfileButton iconOnly workspacePath={workspacePath} aiOptions={aiOptions} onInsertContext={onInsertContext} />}
        <ThreadsAppsMenu apps={apps} />
        <span className="pro-sidebar-footer-spacer" />
        <details className="pro-sidebar-more" ref={accountMenuRef} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary aria-label="More options" title="More options"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg></summary>
          <div className="pro-sidebar-account-menu">
            <button className="pro-sidebar-account-action" type="button" onClick={event => { event.currentTarget.closest('details').open = false; toggleTheme(); }} aria-label="Toggle Theme" title="Toggle Theme">
              {theme === 'dark' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
              <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <button className="pro-sidebar-account-action" type="button" onClick={event => { event.currentTarget.closest('details').open = false; logout(); }} aria-label="Logout" title="Logout">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>Sign out</span>
            </button>
          </div>
        </details>
      </footer>}
      {isCollapsed && (
        <div className="pro-sidebar-rail">
          <button className="pro-rail-brand" type="button" onClick={onOpenWorkspaceStart} aria-label="Terminal v4 home" title="Terminal v4">
            <span className="pro-rail-brand-text" aria-hidden="true">V4</span>
          </button>

          <button
            className="pro-rail-item"
            type="button"
            onClick={onToggle}
            aria-label={isCollapsed ? 'Show threads' : 'Hide threads'}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? 'Show threads' : 'Hide threads'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </svg>
          </button>

          <button
            className="pro-rail-item accent"
            type="button"
            onClick={() => (onOpenWorkspaceStart || onCreateSession)?.()}
            aria-label="New thread"
            title="New thread"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          <button
            className={`pro-rail-item ${showFileManager ? 'active' : ''}`}
            type="button"
            onClick={onToggleFileManager}
            aria-label="Files"
            aria-pressed={!!showFileManager}
            title="Files"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          <button
            className={`pro-rail-item ${showPreview ? 'active' : ''}`}
            type="button"
            onClick={onTogglePreview}
            aria-label="Preview"
            aria-pressed={!!showPreview}
            title="Preview"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>

          <button className="pro-rail-item" type="button" onClick={onOpenNotes} aria-label="Notes" title="Notes">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </button>

          <button className="pro-rail-item" type="button" onClick={onOpenBookmarks} aria-label="Bookmarks" title="Bookmarks">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          {onToggleBrowser && <button className={`pro-rail-item ${showBrowser ? 'active' : ''}`} type="button" onClick={onToggleBrowser} aria-label="Browser" aria-pressed={showBrowser} title="Browser">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" /></svg>
          </button>}
          <div className="pro-rail-spacer" />

          <button className="pro-rail-item" type="button" onClick={toggleTheme} aria-label="Toggle Theme" title="Toggle Theme">
            {theme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          <button className="pro-rail-item" type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          <button className="pro-rail-item" type="button" onClick={logout} aria-label="Logout" title="Logout">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      )}
    </aside>
  );
}
