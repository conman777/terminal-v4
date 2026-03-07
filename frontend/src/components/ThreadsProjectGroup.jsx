import { useState } from 'react';
import ThreadsSessionItem from './ThreadsSessionItem';

export default function ThreadsProjectGroup({
  projectName,
  projectPath,
  sessions,
  activeSessionId,
  sessionActivity,
  onSelectSession,
  onPinSession,
  onUnpinSession,
  onArchiveSession,
  onUnarchiveSession,
  onTopicChange,
  onCloseSession,
  defaultExpanded = true,
  showArchived = false,
  allowEmpty = false
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Filter out archived sessions unless showArchived is true
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((s) => !s.thread?.archived);

  // Don't render empty groups
  if (!allowEmpty && visibleSessions.length === 0) {
    return null;
  }

  return (
    <div className="threads-project-group">
      <div
        className={`threads-project-header ${isExpanded ? 'expanded' : ''}`}
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <span className={`threads-project-chevron ${isExpanded ? 'expanded' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>

        <span className="threads-project-icon">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
        </span>

        <span className="threads-project-name">{projectName}</span>

        <span className="threads-project-count" aria-hidden="true">{visibleSessions.length}</span>
      </div>

      {isExpanded && (
        <div className="threads-project-content">
          {visibleSessions.length === 0 ? (
            <div className="threads-project-empty">No terminals yet</div>
          ) : (
            visibleSessions.map((session) => (
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
            ))
          )}
        </div>
      )}

      <style>{`
        .threads-project-group {
          margin: 0 8px 6px;
        }

        .threads-project-header {
          min-height: 32px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          cursor: pointer;
          user-select: none;
          transition: color 0.12s ease, background 0.12s ease;
          margin: 0;
          color: rgba(226, 232, 240, 0.7);
          gap: 0;
          border-radius: 12px;
          font-family: "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif;
        }

        .threads-project-header:hover {
          color: #f8fafc;
          background: rgba(255, 255, 255, 0.045);
        }

        .threads-project-chevron {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.15s ease;
          margin-right: 6px;
          opacity: 0.42;
        }

        .threads-project-chevron.expanded {
          transform: rotate(90deg);
        }

        .threads-project-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          margin-right: 8px;
          opacity: 0.8;
          color: rgba(244, 247, 251, 0.82);
        }

        .threads-project-name {
          font-family: inherit;
          font-size: 14px;
          font-weight: 560;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          letter-spacing: -0.01em;
        }

        .threads-project-count {
          font-family: inherit;
          font-size: 10px;
          font-weight: 650;
          color: rgba(226, 232, 240, 0.55);
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(148, 163, 184, 0.1);
          min-width: 18px;
          height: 18px;
          line-height: 16px;
          text-align: center;
          border-radius: 999px;
          padding: 0 5px;
        }

        .threads-project-content {
          padding: 4px 0 8px 28px;
        }

        .threads-project-empty {
          padding: 8px 12px 6px;
          color: rgba(226, 232, 240, 0.42);
          font-size: 11px;
          opacity: 1;
        }

        @media (max-width: 768px) {
          .threads-project-header {
            height: 28px;
            padding: 0 10px;
          }

          .threads-project-name {
            font-size: 12px;
          }

          .threads-project-content {
            padding-left: 8px;
          }
        }
      `}</style>
    </div>
  );
}
