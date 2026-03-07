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
  showArchived = false
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Filter out archived sessions unless showArchived is true
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((s) => !s.thread?.archived);

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

        {visibleSessions.length > 0 && (
          <span className="threads-project-count" aria-hidden="true">{visibleSessions.length}</span>
        )}
      </div>

      {isExpanded && (
        <div className="threads-project-content">
          {visibleSessions.length > 0 ? (
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
          ) : (
            <div className="threads-project-empty">No threads yet</div>
          )}
        </div>
      )}

      <style>{`
        .threads-project-group {
          margin-bottom: 2px;
        }

        .threads-project-header {
          height: 32px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          cursor: pointer;
          user-select: none;
          transition: background 0.12s ease;
          border-radius: 6px;
          margin: 1px 6px;
          color: var(--text-secondary, #a1a1aa);
          gap: 0;
        }

        .threads-project-header:hover {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text-primary, #fafafa);
        }

        .threads-project-chevron {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.15s ease;
          margin-right: 4px;
          opacity: 0.4;
        }

        .threads-project-chevron.expanded {
          transform: rotate(90deg);
        }

        .threads-project-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 8px;
          opacity: 0.5;
          color: var(--text-secondary, #a1a1aa);
        }

        .threads-project-name {
          font-size: 13px;
          font-weight: 500;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .threads-project-count {
          font-size: 12px;
          font-weight: 400;
          color: var(--text-muted, #636366);
        }

        .threads-project-content {
          padding: 2px 0 4px 10px;
        }

        .threads-project-empty {
          padding: 6px 20px;
          font-size: 12px;
          color: var(--text-muted, #636366);
          font-style: italic;
        }

        @media (max-width: 768px) {
          .threads-project-header {
            height: 36px;
            margin: 1px 4px;
            padding: 0 8px;
          }

          .threads-project-content {
            padding-left: 8px;
          }
        }
      `}</style>
    </div>
  );
}
