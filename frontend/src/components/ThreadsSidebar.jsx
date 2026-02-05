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
  onCreateSession
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
      <div className="threads-sidebar-header">
        {!isCollapsed && <h1 className="threads-sidebar-title">Threads</h1>}
        <div className="threads-header-actions">
          {!isCollapsed && (
            <button
              className="threads-new-btn"
              onClick={onCreateSession}
              title="New session"
              type="button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
          <button
            className="threads-toggle-btn"
            onClick={onToggle}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            type="button"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              {isCollapsed ? (
                <>
                  <polyline points="9 18 15 12 9 6" />
                  <line x1="3" y1="12" x2="3" y2="12" />
                </>
              ) : (
                <>
                  <polyline points="15 18 9 12 15 6" />
                  <line x1="21" y1="12" x2="21" y2="12" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

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

        .threads-sidebar-header {
          height: 52px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 14px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          flex-shrink: 0;
        }

        .threads-sidebar-title {
          font-size: 11.5px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 1px;
          margin: 0;
        }

        .threads-header-actions {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .threads-new-btn,
        .threads-toggle-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .threads-new-btn:hover,
        .threads-toggle-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .threads-sidebar-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
          padding-top: 10px;
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

          .threads-sidebar-header {
            height: 56px;
            padding: 0 16px;
          }

          .threads-sidebar-title {
            font-size: 12px;
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
