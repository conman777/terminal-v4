import { useMemo, useState } from 'react';
import ThreadsProjectGroup from './ThreadsProjectGroup';
import ThreadsSessionItem from './ThreadsSessionItem';
import { useTheme } from '../contexts/ThemeContext';
import { normalizeProjectPath } from '../utils/projectPaths';
import './ThreadsSidebar.css';

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

export default function ThreadsSidebar({
  isCollapsed,
  onToggle,
  sessionsGroupedByProject,
  pinnedSessions,
  archivedSessions,
  activeSessionId,
  sessionActivity,
  onSelectSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
  onUnarchiveSession,
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
  onOpenNotes,
  showPreview,
  onTogglePreview,
  showFileManager,
  onToggleFileManager,
  logout,
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { theme, toggleTheme } = useTheme();
  const normalizedQuery = searchQuery.trim().toLowerCase();

  const projectGroups = useMemo(() => (
    sessionsGroupedByProject
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) => !session.thread?.archived),
      }))
      .filter((group) => group.sessions.length > 0)
  ), [sessionsGroupedByProject]);

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
      }));

    return [...manualGroups, ...projectGroups];
  }, [projectGroups, projects]);

  const filteredPinnedSessions = useMemo(
    () => pinnedSessions.filter((session) => matchesSessionQuery(session, normalizedQuery)),
    [normalizedQuery, pinnedSessions]
  );

  const filteredArchivedSessions = useMemo(
    () => archivedSessions.filter((session) => matchesSessionQuery(session, normalizedQuery)),
    [archivedSessions, normalizedQuery]
  );

  const filteredProjectGroups = useMemo(() => (
    visibleProjectGroups
      .map((group) => {
        if (matchesGroupQuery(group, normalizedQuery)) {
          return group;
        }

        const sessions = group.sessions.filter((session) => matchesSessionQuery(session, normalizedQuery));
        return sessions.length > 0 ? { ...group, sessions } : null;
      })
      .filter(Boolean)
  ), [normalizedQuery, visibleProjectGroups]);

  const visibleSessionCount = filteredPinnedSessions.length
    + filteredProjectGroups.reduce((total, group) => total + group.sessions.length, 0)
    + filteredArchivedSessions.length;

  return (
    <aside className={`pro-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="pro-sidebar-rail">
        <button className="pro-rail-brand" type="button" aria-label="Terminal v4 home" title="Terminal v4">
          <span className="pro-rail-brand-mark">&gt;_</span>
          <span className="pro-rail-brand-text">V4</span>
        </button>

        <button
          className="pro-rail-item"
          type="button"
          onClick={onToggle}
          aria-label={isCollapsed ? 'Show threads' : 'Hide threads'}
          title={isCollapsed ? 'Show threads' : 'Hide threads'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>

        <button
          className="pro-rail-item accent"
          type="button"
          onClick={() => onCreateSession?.()}
          aria-label="New"
          title="New"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        </button>

        <button className="pro-rail-item" type="button" onClick={onOpenNotes} aria-label="Notes" title="Notes">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </button>

        <button className="pro-rail-item" type="button" onClick={onOpenBookmarks} aria-label="Bookmarks" title="Bookmarks">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        <div className="pro-rail-spacer" />

        <button className="pro-rail-item" type="button" onClick={toggleTheme} aria-label="Toggle Theme" title="Toggle Theme">
          {theme === 'dark' ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>

        <button className="pro-rail-item" type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <button className="pro-rail-item" type="button" onClick={logout} aria-label="Logout" title="Logout">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>

      {!isCollapsed && (
        <div className="pro-sidebar-panel">
          <div className="pro-sidebar-header">
            <div className="pro-sidebar-brand">
              <span className="pro-sidebar-kicker">Workspace</span>
              <span>Threads</span>
            </div>
            <div className="pro-sidebar-count">{visibleSessionCount}</div>
          </div>

          <div className="pro-sidebar-toolbar">
            <button className="pro-toolbar-btn primary" type="button" onClick={() => onCreateSession?.()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New thread
            </button>

            {onAddProject && (
              <button className="pro-toolbar-btn" type="button" onClick={onAddProject} aria-label="Add workspace">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Add workspace
              </button>
            )}
          </div>

          <label className="pro-sidebar-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search threads"
              aria-label="Search threads"
            />
          </label>

          <div className="pro-sidebar-tree">
            {filteredPinnedSessions.length > 0 && (
              <div className="pro-tree-section">
                <div className="pro-section-title">PINNED</div>
                {filteredPinnedSessions.map((session) => (
                  <ThreadsSessionItem
                    key={session.id}
                    session={session}
                    isBusy={Boolean(sessionActivity?.[session.id]?.isBusy)}
                    isActive={session.id === activeSessionId}
                    hasActivity={sessionActivity?.[session.id]?.needsAttention}
                    onSelect={onSelectSession}
                    onPin={onPinSession}
                    onUnpin={onUnpinSession}
                    onArchive={onArchiveSession}
                    onUnarchive={onUnarchiveSession}
                    onUpdateThreadMetadata={onUpdateThreadMetadata}
                    onTopicChange={onTopicChange}
                    onRenameSession={onRenameSession}
                    onClose={onCloseSession}
                  />
                ))}
              </div>
            )}

            <div className="pro-tree-section">
              <div className="pro-section-title">
                PROJECTS
                {onAddProject && (
                  <button className="pro-add-project-icon" type="button" onClick={onAddProject} title="Add Project" aria-label="Add Project">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                )}
              </div>

              {filteredProjectGroups.length > 0 ? (
                filteredProjectGroups.map((group) => (
                  <ThreadsProjectGroup
                    key={group.projectPath || 'other'}
                    projectName={group.projectName}
                    projectPath={group.projectPath}
                    sessions={group.sessions}
                    activeSessionId={activeSessionId}
                    sessionActivity={sessionActivity}
                    onSelectSession={onSelectSession}
                    onPinSession={onPinSession}
                    onUnpinSession={onUnpinSession}
                    onArchiveSession={onArchiveSession}
                    onUnarchiveSession={onUnarchiveSession}
                    onUpdateThreadMetadata={onUpdateThreadMetadata}
                    onTopicChange={onTopicChange}
                    onRenameSession={onRenameSession}
                    onCloseSession={onCloseSession}
                    onCreateSession={onCreateSession}
                    onCloseProject={onCloseProject}
                    defaultExpanded={Boolean(normalizedQuery) || group.sessions.length > 0}
                  />
                ))
              ) : (
                <div className="pro-empty-state">No active projects</div>
              )}
            </div>

            {filteredArchivedSessions.length > 0 && (
              <div className="pro-tree-section">
                <div className="pro-section-title clickable" onClick={() => setShowArchived((current) => !current)}>
                  Archived ({filteredArchivedSessions.length})
                </div>
                {showArchived && (
                  <div className="pro-archived-list">
                    {filteredArchivedSessions.map((session) => (
                      <ThreadsSessionItem
                        key={session.id}
                        session={session}
                        isBusy={Boolean(sessionActivity?.[session.id]?.isBusy)}
                        isActive={session.id === activeSessionId}
                        hasActivity={sessionActivity?.[session.id]?.needsAttention}
                        onSelect={onSelectSession}
                        onPin={onPinSession}
                        onUnpin={onUnpinSession}
                        onArchive={onArchiveSession}
                        onUnarchive={onUnarchiveSession}
                        onUpdateThreadMetadata={onUpdateThreadMetadata}
                        onTopicChange={onTopicChange}
                        onRenameSession={onRenameSession}
                        onClose={onCloseSession}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
