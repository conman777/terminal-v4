import { useState, useMemo } from 'react';
import ThreadsProjectGroup from './ThreadsProjectGroup';
import ThreadsSessionItem from './ThreadsSessionItem';
import { useTheme } from '../contexts/ThemeContext';
import { normalizeProjectPath } from '../utils/projectPaths';

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

  // Build project groups from auto-grouped sessions (grouped by individual project directory)
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
      projectGroups
        .map((group) => normalizeProjectPath(group.projectPath))
        .filter(Boolean)
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

  const heroStats = useMemo(() => ([
    { label: 'Projects', value: String(visibleProjectGroups.length) },
    { label: 'Pins', value: String(pinnedSessions.length) },
    { label: 'Archive', value: String(archivedSessions.length) },
  ]), [archivedSessions.length, pinnedSessions.length, visibleProjectGroups.length]);

  return (
    <aside className={`threads-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Top bar: title + collapse */}
      <div className="ts-topbar">
        {!isCollapsed && (
          <div className="ts-title" aria-label="V4 Terminal">
            <span className="ts-title-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
                <path d="M7 9.25 10.75 12 7 14.75" />
                <line x1="13.25" y1="15" x2="17.5" y2="15" />
              </svg>
            </span>
            <div className="ts-title-copy">
              <strong>V4</strong>
              <span>Terminal</span>
            </div>
          </div>
        )}
        <button
          className="ts-collapse-btn"
          onClick={onToggle}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={isCollapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
          </svg>
        </button>
      </div>

      {/* New thread button */}
      {!isCollapsed && (
        <div className="ts-new-thread-row">
          <section className="ts-hero-card" aria-label="V4 workspace overview">
            <div className="ts-hero-head">
              <span className="ts-hero-kicker">Command Surface</span>
              <span className={`ts-hero-state ${showPreview ? 'preview-open' : ''}`}>
                {showPreview ? 'Preview live' : 'Terminal focus'}
              </span>
            </div>
            <h2 className="ts-hero-brand">V4</h2>
            <p className="ts-hero-copy">A project-native terminal workspace built around threads, live preview, and fast context switching.</p>
            <div className="ts-hero-stats">
              {heroStats.map((stat) => (
                <div key={stat.label} className="ts-hero-stat">
                  <span>{stat.label}</span>
                  <strong>{stat.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <div className="ts-quick-actions">
            <button className="ts-quick-action-btn" type="button" onClick={onOpenBookmarks}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              <span>Bookmarks</span>
            </button>
            <button className="ts-quick-action-btn" type="button" onClick={onOpenNotes}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <span>Notes</span>
            </button>
            <button className={`ts-quick-action-btn ${showFileManager ? 'active' : ''}`} type="button" onClick={onToggleFileManager}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>{showFileManager ? 'Hide files' : 'Show files'}</span>
            </button>
            <button className={`ts-quick-action-btn ${showPreview ? 'active' : ''}`} type="button" onClick={onTogglePreview}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
              <span>{showPreview ? 'Hide preview window' : 'Preview window'}</span>
            </button>
          </div>
          <button
            className="ts-new-thread-btn"
            onClick={() => onCreateSession?.()}
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>New thread</span>
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div className="threads-sidebar-content">
          {/* Threads section header */}
          <div className="threads-section-label">
            <span>Threads</span>
          </div>

          {/* Pinned section */}
          {pinnedSessions.length > 0 && (
            <div className="threads-section">
              <div className="threads-section-header">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
                </svg>
                <span>Pinned</span>
              </div>
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

          {/* Project groups */}
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
            <div className="threads-empty">
              <p>No projects yet</p>
              <button className="threads-empty-btn" onClick={onAddProject}>
                + Add project
              </button>
            </div>
          )}

          {/* Add project button */}
          {visibleProjectGroups.length > 0 && onAddProject && (
            <button
              className="ts-add-project-btn"
              onClick={onAddProject}
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
              </svg>
              <span>Add project</span>
            </button>
          )}

          {/* Archived section */}
          {archivedSessions.length > 0 && (
            <div className="threads-section archived">
              <div
                className="threads-section-header clickable"
                onClick={() => setShowArchived(!showArchived)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5 8.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 8.25ZM2 2.75a.75.75 0 0 0-.75.75v1c0 .414.336.75.75.75h12a.75.75 0 0 0 .75-.75v-1a.75.75 0 0 0-.75-.75H2Zm-.5 5.75A1.5 1.5 0 0 1 3 7h10a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-4Z" />
                </svg>
                <span>Archived ({archivedSessions.length})</span>
                <svg
                  className={`threads-section-chevron ${showArchived ? 'expanded' : ''}`}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>
              {showArchived && (
                <div className="threads-section-content">
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

      {/* Settings footer - pinned at bottom */}
      {!isCollapsed && (
        <div className="ts-sidebar-footer">
          <button
            className="ts-settings-btn"
            onClick={onOpenSettings}
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
          <button
            className="ts-footer-icon-btn"
            onClick={toggleTheme}
            type="button"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            className="ts-footer-icon-btn"
            onClick={logout}
            type="button"
            aria-label="Logout"
            title="Logout"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      )}

      <style>{`
        .threads-sidebar {
          --sidebar-bg: rgba(8, 13, 24, 0.88);
          --sidebar-shell-bg: rgba(10, 16, 28, 0.86);
          --sidebar-content-bg: rgba(6, 11, 19, 0.72);
          --sidebar-hover: rgba(255, 255, 255, 0.06);
          --sidebar-active: rgba(248, 113, 113, 0.16);
          --sidebar-border: rgba(255, 255, 255, 0.08);
          --sidebar-text: #f4efe6;
          --sidebar-text-muted: #b8b0a2;
          --sidebar-cutout-bg: var(--bg-primary);
          --sidebar-theme-text: var(--text-primary);
          --sidebar-theme-muted: var(--text-muted);
          width: 332px;
          height: 100%;
          background:
            radial-gradient(circle at top left, rgba(244, 114, 182, 0.14), transparent 34%),
            radial-gradient(circle at 78% 18%, rgba(251, 191, 36, 0.16), transparent 28%),
            linear-gradient(180deg, rgba(18, 12, 16, 0.96) 0%, rgba(10, 13, 22, 0.96) 38%, rgba(6, 10, 18, 0.98) 100%);
          border: 1px solid var(--sidebar-border);
          border-radius: 30px;
          box-shadow: 0 30px 80px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.04);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease;
          flex-shrink: 0;
          z-index: 50;
          overflow: hidden;
        }

        html[data-window-active="false"] .threads-sidebar {
          --sidebar-bg: #0d121a;
          --sidebar-shell-bg: #0f1520;
          --sidebar-content-bg: #0c1118;
          --sidebar-hover: rgba(149, 175, 211, 0.06);
          --sidebar-active: rgba(36, 95, 153, 0.2);
          --sidebar-border: rgba(110, 132, 164, 0.18);
          --sidebar-text: #dbe5f2;
          --sidebar-text-muted: #91a1b8;
        }

        .threads-sidebar.collapsed {
          width: 68px;
        }

        /* ── Top bar ── */
        .ts-topbar {
          height: 72px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 16px 0 18px;
          flex-shrink: 0;
          background: transparent;
        }

        .threads-sidebar.collapsed .ts-topbar {
          justify-content: center;
          padding: 0;
        }

        .ts-title {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 12px;
          color: var(--sidebar-text);
        }

        .ts-title-mark {
          width: 40px;
          height: 40px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 14px;
          background: linear-gradient(135deg, rgba(250, 204, 21, 0.18), rgba(244, 114, 182, 0.16));
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #fff0d5;
        }

        .ts-title-copy {
          display: flex;
          flex-direction: column;
          line-height: 1;
          gap: 4px;
        }

        .ts-title-copy strong {
          font-family: 'Syne', var(--font-ui);
          font-size: 20px;
          font-weight: 700;
          letter-spacing: -0.04em;
        }

        .ts-title-copy span {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.22em;
          color: var(--sidebar-text-muted);
        }

        .ts-collapse-btn {
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--sidebar-text-muted);
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.12s ease;
          flex-shrink: 0;
        }

        .ts-collapse-btn:hover {
          background: var(--sidebar-hover);
          color: var(--sidebar-text);
        }

        /* ── New thread button ── */
        .ts-new-thread-row {
          padding: 0 14px 14px;
          flex-shrink: 0;
          background: transparent;
        }

        .ts-hero-card {
          position: relative;
          overflow: hidden;
          margin-bottom: 14px;
          padding: 16px;
          border-radius: 24px;
          background:
            radial-gradient(circle at top right, rgba(250, 204, 21, 0.2), transparent 30%),
            linear-gradient(145deg, rgba(76, 29, 149, 0.26), rgba(127, 29, 29, 0.18) 46%, rgba(17, 24, 39, 0.72));
          border: 1px solid rgba(255, 255, 255, 0.09);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }

        .ts-hero-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 14px;
        }

        .ts-hero-kicker,
        .ts-hero-state {
          display: inline-flex;
          align-items: center;
          min-height: 26px;
          padding: 0 10px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .ts-hero-kicker {
          color: #fff3d6;
          background: rgba(255, 255, 255, 0.07);
        }

        .ts-hero-state {
          color: #ffd6b8;
          background: rgba(255, 255, 255, 0.04);
        }

        .ts-hero-state.preview-open {
          color: #fff1cf;
          background: rgba(251, 191, 36, 0.14);
        }

        .ts-hero-brand {
          margin: 0;
          font-family: 'Syne', var(--font-ui);
          font-size: 60px;
          line-height: 0.88;
          letter-spacing: -0.08em;
          color: #fff7eb;
        }

        .ts-hero-copy {
          margin: 12px 0 0;
          color: rgba(244, 239, 230, 0.76);
          font-size: 13px;
          line-height: 1.55;
          max-width: 24ch;
        }

        .ts-hero-stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 16px;
        }

        .ts-hero-stat {
          padding: 10px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .ts-hero-stat span {
          display: block;
          margin-bottom: 8px;
          color: rgba(244, 239, 230, 0.58);
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .ts-hero-stat strong {
          display: block;
          color: #fff5e6;
          font-size: 22px;
          font-weight: 700;
        }

        .ts-quick-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-bottom: 12px;
        }

        .ts-quick-action-btn {
          width: 100%;
          min-height: 42px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--sidebar-text-muted);
          border-radius: 14px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          transition: all 0.12s ease;
        }

        .ts-quick-action-btn:hover {
          background: var(--sidebar-hover);
          color: var(--sidebar-text);
          border-color: color-mix(in srgb, var(--sidebar-border) 75%, white 25%);
        }

        .ts-quick-action-btn.active {
          background: color-mix(in srgb, var(--sidebar-active) 72%, transparent);
          color: var(--sidebar-text);
          border-color: color-mix(in srgb, var(--sidebar-border) 65%, var(--accent-primary) 35%);
        }

        .ts-new-thread-btn {
          width: 100%;
          height: 48px;
          display: flex;
          align-items: center;
          gap: 8px;
          justify-content: center;
          padding: 0 16px;
          background: linear-gradient(135deg, rgba(251, 191, 36, 0.88), rgba(244, 114, 182, 0.82));
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #1a1116;
          border-radius: 16px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          transition: all 0.12s ease;
          box-shadow: 0 14px 30px rgba(244, 114, 182, 0.14);
        }

        .ts-new-thread-btn:hover {
          transform: translateY(-1px);
          filter: brightness(1.02);
        }

        /* ── Content area ── */
        .threads-sidebar-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
          padding: 0 8px 0 10px;
          background: var(--sidebar-content-bg);
        }

        .threads-sidebar-content::-webkit-scrollbar {
          width: 4px;
        }

        .threads-sidebar-content::-webkit-scrollbar-thumb {
          background: var(--scrollbar-thumb);
          border-radius: 2px;
        }

        .threads-section-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 10px 8px;
          font-size: 11px;
          font-weight: 600;
          color: var(--sidebar-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .threads-section {
          margin-bottom: 8px;
        }

        .threads-section-header {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          font-size: 11px;
          font-weight: 600;
          color: var(--sidebar-text-muted);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .threads-section-header.clickable {
          cursor: pointer;
          transition: color 0.12s ease;
        }

        .threads-section-header.clickable:hover {
          color: var(--sidebar-text);
        }

        .threads-section-chevron {
          margin-left: auto;
          transition: transform 0.15s ease;
        }

        .threads-section-chevron.expanded {
          transform: rotate(90deg);
        }

        .threads-section.archived {
          margin-top: 8px;
        }

        .threads-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          color: var(--sidebar-text-muted);
          border: 1px dashed rgba(255, 255, 255, 0.08);
          border-radius: 18px;
          background: rgba(255, 255, 255, 0.03);
          margin: 8px 10px 12px;
        }

        .threads-empty p {
          margin: 0 0 12px;
          font-size: 13px;
        }

        .threads-empty-btn {
          background: color-mix(in srgb, var(--sidebar-hover) 72%, transparent);
          border: 1px solid var(--sidebar-border);
          color: var(--sidebar-text);
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 400;
          cursor: pointer;
          transition: all 0.12s ease;
        }

        .threads-empty-btn:hover {
          background: var(--sidebar-hover);
          color: #f8fbff;
        }

        /* ── Add project button ── */
        .ts-add-project-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          width: calc(100% - 20px);
          margin: 8px 10px;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--sidebar-text-muted);
          border-radius: 14px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          transition: all 0.12s ease;
        }

        .ts-add-project-btn:hover {
          background: var(--sidebar-hover);
          color: var(--sidebar-text);
        }

        .ts-add-project-btn svg {
          opacity: 0.6;
        }

        /* ── Settings footer ── */
        .ts-sidebar-footer {
          flex-shrink: 0;
          padding: 12px 14px 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          background: linear-gradient(180deg, rgba(8, 12, 21, 0.18), rgba(8, 12, 21, 0.54));
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .ts-settings-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          padding: 10px 12px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--sidebar-text-muted);
          border-radius: 14px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          transition: all 0.12s ease;
        }

        .ts-settings-btn:hover {
          background: var(--sidebar-hover);
          color: var(--sidebar-text);
        }

        .ts-footer-icon-btn {
          width: 42px;
          height: 42px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--sidebar-text-muted);
          border-radius: 14px;
          cursor: pointer;
          transition: all 0.12s ease;
          flex-shrink: 0;
        }

        .ts-footer-icon-btn:hover {
          background: var(--sidebar-hover);
          color: var(--sidebar-text);
        }

        @media (max-width: 768px) {
          .threads-sidebar {
            width: 100%;
            border-radius: 0;
            border-left: none;
            border-top: none;
            border-bottom: none;
          }

          .ts-topbar {
            height: 52px;
            padding: 0 12px;
          }

          .ts-hero-brand {
            font-size: 46px;
          }
        }
      `}</style>
    </aside>
  );
}
