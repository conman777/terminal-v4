import { useState, useMemo } from 'react';
import ThreadsProjectGroup from './ThreadsProjectGroup';

export default function ThreadsSidebar({
  isCollapsed,
  onToggle,
  sessionsGroupedByProject,
  projects = [],
  projectsLoading = false,
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
  onAddProject = null,
  onOpenSettings = null,
  onToggleSidebarMode
}) {
  const [showArchived, setShowArchived] = useState(false);

  const normalizeProjectPath = (path) => (
    typeof path === 'string' && path.trim()
      ? path.trim().replace(/[\\/]+$/, '').toLowerCase()
      : null
  );

  const getProjectName = (project) => {
    if (typeof project === 'string') {
      const normalized = project.replace(/[\\/]+$/, '');
      const parts = normalized.split(/[/\\]/).filter(Boolean);
      return parts[parts.length - 1] || normalized;
    }
    return project?.name || project?.path || 'Unknown';
  };

  const visibleSessionGroups = useMemo(() => {
    return sessionsGroupedByProject.map((group) => ({
      ...group,
      sessions: group.sessions.filter((s) => !s.thread?.archived)
    })).filter((group) => group.sessions.length > 0);
  }, [sessionsGroupedByProject]);

  const folderGroups = useMemo(() => {
    const merged = [];
    const seen = new Set();
    const sessionGroupsByPath = new Map();

    visibleSessionGroups.forEach((group) => {
      const key = normalizeProjectPath(group.projectPath) || `session:${group.projectName}`;
      sessionGroupsByPath.set(key, group);
    });

    projects.forEach((project) => {
      const projectPath = typeof project === 'string' ? project : project?.path;
      const projectName = getProjectName(project);
      const key = normalizeProjectPath(projectPath) || `project:${projectName}`;
      const matchedGroup = sessionGroupsByPath.get(key);

      merged.push({
        projectName,
        projectPath: projectPath || matchedGroup?.projectPath || projectName,
        sessions: matchedGroup?.sessions || []
      });
      seen.add(key);
    });

    visibleSessionGroups.forEach((group) => {
      const key = normalizeProjectPath(group.projectPath) || `session:${group.projectName}`;
      if (seen.has(key)) return;
      merged.push(group);
    });

    return merged;
  }, [projects, visibleSessionGroups]);

  return (
    <aside className={`threads-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Top bar: title + collapse */}
      <div className="ts-topbar">
        {!isCollapsed && (
          <div className="ts-title">
            <span>Codex</span>
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

      {/* Toolbar: app actions */}
      {!isCollapsed && (
        <div className="ts-toolbar">
          <button className="ts-nav-item primary" onClick={onCreateSession} type="button">
            <span className="ts-nav-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </span>
            <span>New thread</span>
          </button>
          <button className="ts-nav-item" type="button" disabled title="Coming soon">
            <span className="ts-nav-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </svg>
            </span>
            <span>Automations</span>
          </button>
          <button className="ts-nav-item" type="button" disabled title="Coming soon">
            <span className="ts-nav-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="2" />
                <circle cx="16" cy="8" r="2" />
                <circle cx="8" cy="16" r="2" />
                <circle cx="16" cy="16" r="2" />
              </svg>
            </span>
            <span>Skills</span>
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div className="threads-sidebar-content">
          <div className="threads-section-heading">
            <span>Threads</span>
            {onAddProject && (
              <button
                type="button"
                className="threads-add-project-btn"
                onClick={onAddProject}
                aria-label="Add project"
                title="Add project"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </div>

          {/* Project groups */}
          {folderGroups.length > 0 ? (
            folderGroups.map((group) => (
              <ThreadsProjectGroup
                key={group.projectPath || 'unknown'}
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
                allowEmpty
              />
            ))
          ) : projectsLoading ? (
            <div className="threads-empty">
              <p>Scanning projects...</p>
            </div>
          ) : (
            <div className="threads-empty">
              <p>No projects yet</p>
              <button className="threads-empty-btn" onClick={onAddProject || onCreateSession}>
                {onAddProject ? '+ Add project' : '+ New terminal'}
              </button>
            </div>
          )}

          {/* Archived section */}
          {archivedSessions.length > 0 && (
            <div className="threads-section archived">
              <div
                className="threads-section-header clickable"
                onClick={() => setShowArchived(!showArchived)}
              >
                <span>archived ({archivedSessions.length})</span>
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

      {!isCollapsed && onOpenSettings && (
        <div className="threads-sidebar-footer">
          <button className="ts-nav-item footer" type="button" onClick={onOpenSettings}>
            <span className="ts-nav-icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-.33-1 1.65 1.65 0 0 0-1-.6 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.33H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1-.33 1.65 1.65 0 0 0 .6-1 1.65 1.65 0 0 0-.33-1.82L4.3 6.46a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6c.39-.23.84-.35 1.29-.33H10.4a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1V2a2 2 0 0 1 4 0v.09c-.02.45.1.9.33 1.29.23.39.59.7 1 .93.39.23.84.35 1.29.33H19a2 2 0 0 1 0 4h-.09c-.45-.02-.9.1-1.29.33-.39.23-.7.59-.93 1-.23.39-.35.84-.33 1.29V11c-.02.45.1.9.33 1.29.23.39.59.7 1 .93.39.23.84.35 1.29.33H19a2 2 0 0 1 .4 1.45Z" />
              </svg>
            </span>
            <span>Settings</span>
          </button>
        </div>
      )}

      <style>{`
        .threads-sidebar {
          width: 294px;
          height: 100%;
          background:
            radial-gradient(circle at 18% 100%, rgba(98, 36, 96, 0.26), transparent 32%),
            radial-gradient(circle at 0% 0%, rgba(46, 95, 168, 0.16), transparent 24%),
            linear-gradient(180deg, rgba(22, 27, 45, 0.985), rgba(18, 20, 33, 0.985));
          border-right: 1px solid rgba(148, 163, 184, 0.12);
          box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.03);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease, box-shadow 0.2s ease;
          flex-shrink: 0;
          z-index: 50;
          font-family: "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif;
        }

        .threads-sidebar.collapsed {
          width: 52px;
        }

        .ts-topbar {
          height: 46px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 14px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.09);
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
          gap: 6px;
          color: #f5f7fd;
          font-size: 15px;
          font-weight: 630;
          letter-spacing: -0.01em;
        }

        .ts-title svg {
          opacity: 0.5;
          width: 12px;
          height: 12px;
        }

        .ts-collapse-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: rgba(226, 232, 240, 0.62);
          cursor: pointer;
          transition: color 0.12s ease, background 0.12s ease, transform 0.12s ease;
          flex-shrink: 0;
          border-radius: 9px;
        }

        .ts-collapse-btn:hover {
          color: #fafafa;
          background: rgba(255, 255, 255, 0.065);
          transform: translateX(-1px);
        }

        .ts-toolbar {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 2px;
          padding: 12px 10px 8px;
          flex-shrink: 0;
        }

        .ts-nav-item {
          min-height: 36px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 12px;
          background: transparent;
          border: none;
          color: rgba(226, 232, 240, 0.78);
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.12s ease, background 0.12s ease, transform 0.12s ease;
          border-radius: 12px;
          text-align: left;
        }

        .ts-nav-item:hover:not(:disabled) {
          color: #fafafa;
          background: rgba(255, 255, 255, 0.055);
        }

        .ts-nav-item:disabled {
          opacity: 0.7;
          cursor: default;
        }

        .ts-nav-item.primary {
          background: rgba(255, 255, 255, 0.04);
        }

        .ts-nav-item.footer {
          color: rgba(226, 232, 240, 0.7);
        }

        .ts-nav-icon {
          width: 18px;
          height: 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: rgba(226, 232, 240, 0.68);
          flex-shrink: 0;
        }

        .ts-nav-item:hover:not(:disabled) .ts-nav-icon,
        .ts-nav-item.primary .ts-nav-icon {
          color: #f4f7fb;
        }

        .threads-sidebar-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: rgba(148, 163, 184, 0.32) transparent;
          padding: 12px 0 16px;
        }

        .threads-section-heading {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 2px 16px 12px;
          color: rgba(226, 232, 240, 0.44);
          font-size: 11px;
          font-weight: 650;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .threads-add-project-btn {
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          border-radius: 9px;
          color: rgba(226, 232, 240, 0.6);
          cursor: pointer;
          transition: color 0.12s ease, background 0.12s ease;
        }

        .threads-add-project-btn:hover {
          color: #fafafa;
          background: rgba(255, 255, 255, 0.065);
        }

        .threads-sidebar-content::-webkit-scrollbar {
          width: 3px;
        }

        .threads-sidebar-content::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.2);
          border-radius: 999px;
        }

        .threads-section {
          margin: 14px 0 0;
        }

        .threads-section-header {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 16px;
          font-family: inherit;
          font-size: 11px;
          font-weight: 580;
          color: rgba(226, 232, 240, 0.45);
        }

        .threads-section-header.clickable {
          cursor: pointer;
          transition: color 0.1s ease;
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
          border-top: 1px solid rgba(148, 163, 184, 0.1);
          padding-top: 10px;
          margin: 14px 12px 0;
        }

        .threads-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          color: rgba(226, 232, 240, 0.56);
          font-family: inherit;
        }

        .threads-empty p {
          margin: 0 0 8px;
          font-size: 13px;
        }

        .threads-empty-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(148, 163, 184, 0.18);
          color: rgba(248, 250, 252, 0.84);
          padding: 8px 12px;
          border-radius: 10px;
          font-family: inherit;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: color 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        .threads-empty-btn:hover {
          border-color: rgba(255, 255, 255, 0.22);
          background: rgba(255, 255, 255, 0.08);
          color: #fafafa;
        }

        .threads-sidebar-footer {
          margin-top: auto;
          padding: 10px 10px 14px;
          border-top: 1px solid rgba(148, 163, 184, 0.08);
        }

        @media (max-width: 768px) {
          .threads-sidebar {
            width: 100%;
            border-right: none;
          }

          .ts-topbar {
            height: 36px;
            padding: 0 10px;
          }

          .ts-toolbar {
            height: 28px;
            padding: 0 10px;
          }

          .threads-section-header {
            padding: 4px 10px;
          }
        }
      `}</style>
    </aside>
  );
}
