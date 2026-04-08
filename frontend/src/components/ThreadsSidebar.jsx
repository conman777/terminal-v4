import { useState, useMemo } from 'react';
import ThreadsProjectGroup from './ThreadsProjectGroup';
import ThreadsSessionItem from './ThreadsSessionItem';
import { useTheme } from '../contexts/ThemeContext';
import { normalizeProjectPath } from '../utils/projectPaths';
import './ThreadsSidebar.css';

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
  logout
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const projectGroups = useMemo(() => {
    return sessionsGroupedByProject
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((s) => !s.thread?.archived)
      }))
      .filter((group) => group.sessions.length > 0);
  }, [sessionsGroupedByProject]);

  const visibleProjectGroups = useMemo(() => {
    const groupedPaths = new Set(
      projectGroups.map((group) => normalizeProjectPath(group.projectPath)).filter(Boolean)
    );

    const manualGroups = projects
      .filter((project) => !groupedPaths.has(normalizeProjectPath(project.path)))
      .map((project) => ({
        projectName: project.name,
        projectPath: project.path,
        sessions: []
      }));

    return [...manualGroups, ...projectGroups];
  }, [projectGroups, projects]);

  return (
    <aside className={`pro-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* 1. COMPACT HEADER */}
      <div className="pro-sidebar-header">
        {!isCollapsed && (
          <div className="pro-sidebar-brand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8l4 4-4 4" />
              <line x1="12" y1="16" x2="18" y2="16" />
            </svg>
            <span>V4 WORKSPACE</span>
          </div>
        )}
        <button className="pro-icon-btn" onClick={onToggle} title={isCollapsed ? 'Expand' : 'Collapse'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>

      {/* 2. QUICK TOOLBAR (replaces Hero Card) */}
      {!isCollapsed && (
        <div className="pro-sidebar-toolbar">
          <button className="pro-toolbar-btn" onClick={() => onCreateSession?.()} title="New Terminal">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            New
          </button>
          <div className="pro-toolbar-divider" />
          <button className={`pro-icon-btn ${showFileManager ? 'active' : ''}`} onClick={onToggleFileManager} title="Files">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          </button>
          <button className={`pro-icon-btn ${showPreview ? 'active' : ''}`} onClick={onTogglePreview} title="Preview">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>
          </button>
          <button className="pro-icon-btn" onClick={onOpenNotes} title="Notes">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
          </button>
          <button className="pro-icon-btn" onClick={onOpenBookmarks} title="Bookmarks">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
          </button>
        </div>
      )}

      {/* 3. TREE VIEW CONTENT */}
      {!isCollapsed && (
        <div className="pro-sidebar-tree">
          {/* Pinned Section */}
          {pinnedSessions.length > 0 && (
            <div className="pro-tree-section">
              <div className="pro-section-title">PINNED</div>
              {pinnedSessions.map((session) => (
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
                  onClose={onCloseSession}
                />
              ))}
            </div>
          )}

          {/* Projects Section */}
          <div className="pro-tree-section">
            <div className="pro-section-title">
              PROJECTS
              {onAddProject && (
                <button className="pro-add-project-icon" onClick={onAddProject} title="Add Project">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                </button>
              )}
            </div>
            {visibleProjectGroups.length > 0 ? (
              visibleProjectGroups.map((group) => (
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
                  defaultExpanded={group.sessions.length > 0}
                />
              ))
            ) : (
              <div className="pro-empty-state">No active projects</div>
            )}
          </div>

          {/* Archived Section */}
          {archivedSessions.length > 0 && (
            <div className="pro-tree-section">
              <div className="pro-section-title clickable" onClick={() => setShowArchived(!showArchived)}>
                ARCHIVED ({archivedSessions.length})
              </div>
              {showArchived && (
                <div className="pro-archived-list">
                  {archivedSessions.map((session) => (
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
                      onClose={onCloseSession}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 4. COMPACT FOOTER */}
      {!isCollapsed && (
        <div className="pro-sidebar-footer">
          <button className="pro-footer-item" onClick={onOpenSettings} title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            <span>Settings</span>
          </button>
          <div className="pro-footer-actions">
            <button className="pro-icon-btn" onClick={toggleTheme} title="Toggle Theme">
              {theme === 'dark' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              )}
            </button>
            <button className="pro-icon-btn" onClick={logout} title="Logout">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
