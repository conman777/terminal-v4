import { useState, useMemo } from 'react';
import ThreadsProjectGroup from './ThreadsProjectGroup';
import ThreadsSessionItem from './ThreadsSessionItem';

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
  onTopicChange,
  onCloseSession,
  onCreateSession,
  projects,
  onAddProject,
  onOpenSettings
}) {
  const [showArchived, setShowArchived] = useState(false);

  // Collect all non-archived sessions from groups
  const allSessions = useMemo(() => {
    const sessions = [];
    sessionsGroupedByProject.forEach((group) => {
      group.sessions.forEach((s) => {
        if (!s.thread?.archived) sessions.push(s);
      });
    });
    return sessions;
  }, [sessionsGroupedByProject]);

  // Normalize a path for comparison
  const normalizePath = (p) => {
    if (!p) return '';
    return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  };

  // Build project groups: user-added projects with matched sessions
  const projectGroups = useMemo(() => {
    if (!projects || projects.length === 0) {
      // No user-added projects — fall back to auto-grouped sessions
      return sessionsGroupedByProject
        .map((group) => ({
          ...group,
          sessions: group.sessions.filter((s) => !s.thread?.archived)
        }))
        .filter((group) => group.sessions.length > 0);
    }

    const matched = new Set();
    const groups = [];

    for (const project of projects) {
      const projPath = normalizePath(project.path);
      const matchedSessions = allSessions.filter((session) => {
        const sessionPath = normalizePath(
          session.thread?.projectPath || session.groupPath || session.cwd
        );
        return sessionPath && sessionPath.startsWith(projPath);
      });

      // Track matched session IDs
      matchedSessions.forEach((s) => matched.add(s.id));

      // Get project name from last path segment
      const name = project.name || projPath.split('/').filter(Boolean).pop() || 'Unknown';

      groups.push({
        projectPath: project.path,
        projectName: name,
        sessions: matchedSessions
      });
    }

    // Collect unmatched sessions into "Other"
    const unmatched = allSessions.filter((s) => !matched.has(s.id));
    if (unmatched.length > 0) {
      groups.push({
        projectPath: null,
        projectName: 'Other',
        sessions: unmatched
      });
    }

    // Sort: groups with recent activity first, empty groups last
    groups.sort((a, b) => {
      if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
      if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
      const aTime = Math.max(0, ...a.sessions.map((s) =>
        new Date(s.thread?.lastActivityAt || s.updatedAt || 0).getTime()
      ));
      const bTime = Math.max(0, ...b.sessions.map((s) =>
        new Date(s.thread?.lastActivityAt || s.updatedAt || 0).getTime()
      ));
      return bTime - aTime;
    });

    return groups;
  }, [projects, allSessions, sessionsGroupedByProject]);

  return (
    <aside className={`threads-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Top bar: title + collapse */}
      <div className="ts-topbar">
        {!isCollapsed && (
          <div className="ts-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Terminal</span>
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
          <button
            className="ts-new-thread-btn"
            onClick={onCreateSession}
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
                  isActive={session.id === activeSessionId}
                  hasActivity={sessionActivity?.[session.id]?.needsAttention}
                  onSelect={onSelectSession}
                  onPin={onPinSession}
                  onUnpin={onUnpinSession}
                  onArchive={onArchiveSession}
                  onUnarchive={onUnarchiveSession}
                  onTopicChange={onTopicChange}
                  onClose={onCloseSession}
                />
              ))}
            </div>
          )}

          {/* Project groups */}
          {projectGroups.length > 0 ? (
            projectGroups.map((group) => (
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
                onTopicChange={onTopicChange}
                onCloseSession={onCloseSession}
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
          {projectGroups.length > 0 && onAddProject && (
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
                      isActive={session.id === activeSessionId}
                      hasActivity={sessionActivity?.[session.id]?.needsAttention}
                      onSelect={onSelectSession}
                      onPin={onPinSession}
                      onUnpin={onUnpinSession}
                      onArchive={onArchiveSession}
                      onUnarchive={onUnarchiveSession}
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
        </div>
      )}

      <style>{`
        .threads-sidebar {
          width: 260px;
          height: 100%;
          background: #0a0a0a;
          border-right: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease;
          flex-shrink: 0;
          z-index: 50;
        }

        .threads-sidebar.collapsed {
          width: 48px;
        }

        /* ── Top bar ── */
        .ts-topbar {
          height: 48px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 12px;
          flex-shrink: 0;
        }

        .threads-sidebar.collapsed .ts-topbar {
          justify-content: center;
          padding: 0;
        }

        .ts-title {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-primary, #fafafa);
          font-size: 14px;
          font-weight: 600;
        }

        .ts-title svg {
          opacity: 0.6;
        }

        .ts-collapse-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #636366);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.12s ease;
          flex-shrink: 0;
        }

        .ts-collapse-btn:hover {
          background: rgba(255, 255, 255, 0.06);
          color: var(--text-primary, #fafafa);
        }

        /* ── New thread button ── */
        .ts-new-thread-row {
          padding: 4px 10px 8px;
          flex-shrink: 0;
        }

        .ts-new-thread-btn {
          width: 100%;
          height: 32px;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-secondary, #a1a1aa);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          transition: all 0.12s ease;
        }

        .ts-new-thread-btn:hover {
          background: rgba(255, 255, 255, 0.07);
          border-color: rgba(255, 255, 255, 0.12);
          color: var(--text-primary, #fafafa);
        }

        /* ── Content area ── */
        .threads-sidebar-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
          padding: 0;
        }

        .threads-sidebar-content::-webkit-scrollbar {
          width: 4px;
        }

        .threads-sidebar-content::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
        }

        .threads-section-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 6px;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted, #636366);
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
          padding: 6px 14px;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted, #636366);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .threads-section-header.clickable {
          cursor: pointer;
          transition: color 0.12s ease;
        }

        .threads-section-header.clickable:hover {
          color: var(--text-secondary, #a1a1aa);
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
          color: var(--text-muted, #636366);
        }

        .threads-empty p {
          margin: 0 0 12px;
          font-size: 13px;
        }

        .threads-empty-btn {
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: var(--text-secondary, #a1a1aa);
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 400;
          cursor: pointer;
          transition: all 0.12s ease;
        }

        .threads-empty-btn:hover {
          background: rgba(255, 255, 255, 0.07);
          color: var(--text-primary, #fafafa);
        }

        /* ── Add project button ── */
        .ts-add-project-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          width: calc(100% - 20px);
          margin: 6px 10px;
          padding: 8px 10px;
          background: transparent;
          border: none;
          color: var(--text-muted, #636366);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          transition: all 0.12s ease;
        }

        .ts-add-project-btn:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-secondary, #a1a1aa);
        }

        .ts-add-project-btn svg {
          opacity: 0.6;
        }

        /* ── Settings footer ── */
        .ts-sidebar-footer {
          flex-shrink: 0;
          padding: 6px 10px 10px;
          border-top: 1px solid rgba(255, 255, 255, 0.04);
        }

        .ts-settings-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 10px;
          background: transparent;
          border: none;
          color: var(--text-muted, #636366);
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 400;
          transition: all 0.12s ease;
        }

        .ts-settings-btn:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-secondary, #a1a1aa);
        }

        @media (max-width: 768px) {
          .threads-sidebar {
            width: 100%;
          }

          .ts-topbar {
            height: 52px;
            padding: 0 12px;
          }
        }
      `}</style>
    </aside>
  );
}
