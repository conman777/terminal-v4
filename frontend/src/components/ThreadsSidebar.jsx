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
  onToggleSidebarMode
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

      {/* Toolbar: view toggle + new session */}
      {!isCollapsed && (
        <div className="ts-toolbar">
          <div className="ts-toolbar-left">
            {onToggleSidebarMode ? (
              <div className="ts-mode-toggle">
                <button
                  className="ts-mode-btn active"
                  type="button"
                >Threads</button>
                <button
                  className="ts-mode-btn"
                  onClick={onToggleSidebarMode}
                  type="button"
                >Explorer</button>
              </div>
            ) : (
              <span className="ts-toolbar-label">Threads</span>
            )}
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
          width: 256px;
          height: 100%;
          background: var(--bg-primary, #0a0a0c);
          border-right: none;
          display: flex;
          flex-direction: column;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
          z-index: 50;
          position: relative;
        }

        .threads-sidebar::after {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: 1px;
          background: linear-gradient(180deg, var(--accent-primary, #f59e0b) 0%, rgba(245, 158, 11, 0.3) 30%, transparent 100%);
          opacity: 0.4;
          pointer-events: none;
        }

        .threads-sidebar.collapsed::after {
          opacity: 0.2;
        }

        .threads-sidebar.collapsed {
          width: 48px;
        }

        /* ── Top bar: mode switch + collapse ── */
        .ts-topbar {
          height: 44px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 8px;
          border-bottom: none;
          box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03);
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
          color: var(--accent-primary, #f59e0b);
          font-size: 13px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .ts-title svg {
          opacity: 0.8;
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
          background: var(--bg-surface, #141416);
          color: var(--text-primary, #fafafa);
        }

        /* ── Toolbar: view toggle + new ── */
        .ts-toolbar {
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 10px 0 12px;
          border-bottom: none;
          box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03);
          flex-shrink: 0;
        }

        .ts-toolbar-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .ts-mode-toggle {
          display: flex;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          border-radius: 6px;
          padding: 2px;
          gap: 1px;
        }

        .ts-mode-btn {
          height: 22px;
          padding: 0 10px;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.3px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .ts-mode-btn:hover:not(.active) {
          color: var(--text-primary, #fafafa);
          background: rgba(255, 255, 255, 0.04);
        }

        .ts-mode-btn.active {
          background: var(--bg-elevated, #1e1e21);
          color: var(--accent-primary, #f59e0b);
          cursor: default;
        }

        .ts-toolbar-label {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 1px;
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
          background: var(--bg-surface, #141416);
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
          background: var(--border-default, #2a2a2e);
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
          border-top: none;
          box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.03);
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
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-secondary, #a1a1aa);
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .threads-empty-btn:hover {
          background: var(--bg-elevated, #1e1e21);
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
