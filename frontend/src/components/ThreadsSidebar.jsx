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
  sidebarMode,
  onToggleSidebarMode,
  leftPanelMode,
  onSetLeftPanelMode
}) {
  const [showArchived, setShowArchived] = useState(false);

  // Filter out archived sessions from groups for display
  const visibleGroups = useMemo(() => {
    return sessionsGroupedByProject.map((group) => ({
      ...group,
      sessions: group.sessions.filter((s) => !s.thread?.archived)
    })).filter((group) => group.sessions.length > 0);
  }, [sessionsGroupedByProject]);

  // Count total visible sessions
  const totalSessions = useMemo(() => {
    return visibleGroups.reduce((acc, group) => acc + group.sessions.length, 0);
  }, [visibleGroups]);

  return (
    <aside className={`threads-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Top bar: mode switch + collapse */}
      <div className="ts-topbar">
        {!isCollapsed ? (
          <>
            <div className="ts-mode-switch">
              <button
                className={`ts-mode-option ${leftPanelMode === 'terminal' ? 'active' : ''}`}
                onClick={() => onSetLeftPanelMode('terminal')}
                type="button"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                Terminal
              </button>
              <button
                className={`ts-mode-option ${leftPanelMode === 'claude-code' ? 'active' : ''}`}
                onClick={() => onSetLeftPanelMode('claude-code')}
                type="button"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
                Claude
              </button>
            </div>
            <button
              className="ts-collapse-btn"
              onClick={onToggle}
              title="Collapse sidebar"
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          </>
        ) : (
          <button
            className="ts-collapse-btn"
            onClick={onToggle}
            title="Expand sidebar"
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      {/* Toolbar: view toggle + new session */}
      {!isCollapsed && (
        <div className="ts-toolbar">
          <div className="ts-toolbar-left">
            {onToggleSidebarMode && (
              <button
                className={`ts-view-toggle ${sidebarMode === 'threads' ? 'active' : ''}`}
                onClick={onToggleSidebarMode}
                title={sidebarMode === 'threads' ? 'Switch to Explorer' : 'Switch to Threads'}
                type="button"
              >
                {sidebarMode === 'threads' ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                  </svg>
                )}
              </button>
            )}
            <span className="ts-toolbar-label">
              {sidebarMode === 'threads' ? 'Threads' : 'Explorer'}
            </span>
          </div>
          <button
            className="ts-new-btn"
            onClick={onCreateSession}
            title="New session"
            type="button"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div className="threads-sidebar-content">
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
          {visibleGroups.length > 0 ? (
            visibleGroups.map((group) => (
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
              />
            ))
          ) : (
            <div className="threads-empty">
              <p>No sessions</p>
              <button className="threads-empty-btn" onClick={onCreateSession}>
                + New Session
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

      <style jsx>{`
        .threads-sidebar {
          width: 272px;
          height: 100%;
          background: var(--bg-primary, #09090b);
          border-right: 1px solid var(--border-default, #3f3f46);
          display: flex;
          flex-direction: column;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
          z-index: 50;
        }

        .threads-sidebar.collapsed {
          width: 48px;
        }

        /* ── Top bar: mode switch + collapse ── */
        .ts-topbar {
          height: 48px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 8px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          flex-shrink: 0;
        }

        .threads-sidebar.collapsed .ts-topbar {
          justify-content: center;
          padding: 0;
        }

        .ts-mode-switch {
          flex: 1;
          display: flex;
          background: var(--bg-surface, #18181b);
          border-radius: 8px;
          padding: 3px;
          gap: 2px;
        }

        .ts-mode-option {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          height: 30px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text-muted, #71717a);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          white-space: nowrap;
        }

        .ts-mode-option:hover:not(.active) {
          color: var(--text-secondary, #a1a1aa);
          background: rgba(255, 255, 255, 0.03);
        }

        .ts-mode-option.active {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        }

        .ts-mode-option svg {
          opacity: 0.6;
          flex-shrink: 0;
        }

        .ts-mode-option.active svg {
          opacity: 1;
          color: var(--accent-primary, #f59e0b);
        }

        .ts-collapse-btn {
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }

        .ts-collapse-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        /* ── Toolbar: view toggle + new ── */
        .ts-toolbar {
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 10px 0 12px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          flex-shrink: 0;
        }

        .ts-toolbar-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .ts-view-toggle {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 5px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .ts-view-toggle:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .ts-view-toggle.active {
          color: var(--accent-primary, #f59e0b);
        }

        .ts-toolbar-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .ts-new-btn {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 5px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .ts-new-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        /* ── Content area ── */
        .threads-sidebar-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
          padding-top: 4px;
        }

        .threads-sidebar-content::-webkit-scrollbar {
          width: 4px;
        }

        .threads-sidebar-content::-webkit-scrollbar-thumb {
          background: var(--border-default, #3f3f46);
          border-radius: 2px;
        }

        .threads-section {
          margin-bottom: 10px;
        }

        .threads-section-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 16px;
          font-size: 10px;
          font-weight: 600;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .threads-section-header.clickable {
          cursor: pointer;
          transition: color 0.15s ease;
        }

        .threads-section-header.clickable:hover {
          color: var(--text-secondary, #a1a1aa);
        }

        .threads-section-chevron {
          margin-left: auto;
          transition: transform 0.2s ease;
        }

        .threads-section-chevron.expanded {
          transform: rotate(90deg);
        }

        .threads-section.archived {
          border-top: 1px solid var(--border-subtle, #27272a);
          padding-top: 8px;
          margin-top: 8px;
        }

        .threads-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px 20px;
          color: var(--text-muted, #71717a);
        }

        .threads-empty p {
          margin: 0 0 12px;
          font-size: 13px;
        }

        .threads-empty-btn {
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-default, #3f3f46);
          color: var(--text-secondary, #a1a1aa);
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .threads-empty-btn:hover {
          background: var(--bg-elevated, #27272a);
          border-color: var(--accent-primary, #f59e0b);
          color: var(--text-primary, #fafafa);
        }

        @media (max-width: 768px) {
          .threads-sidebar {
            width: 100%;
            border-right: none;
          }

          .ts-topbar {
            height: 52px;
            padding: 0 12px;
          }

          .ts-toolbar {
            height: 38px;
            padding: 0 14px;
          }

          .threads-section-header {
            padding: 6px 14px;
            font-size: 10.5px;
          }
        }
      `}</style>
    </aside>
  );
}
