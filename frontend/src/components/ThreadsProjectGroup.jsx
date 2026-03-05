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

  // Don't render empty groups
  if (visibleSessions.length === 0) {
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
          {visibleSessions.map((session) => (
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

      <style>{`
        .threads-project-group {
          margin-bottom: 6px;
        }

        .threads-project-header {
          height: 34px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s ease;
          border-radius: 8px;
          margin: 2px 8px;
          color: var(--text-secondary, #a1a1aa);
          gap: 0;
        }

        .threads-project-header:hover {
          background: var(--bg-surface, #141416);
          color: var(--text-primary, #fafafa);
        }

        .threads-project-chevron {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          margin-right: 4px;
          opacity: 0.5;
        }

        .threads-project-chevron.expanded {
          transform: rotate(90deg);
        }

        .threads-project-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 8px;
          opacity: 0.7;
          color: var(--accent-primary, #f59e0b);
        }

        .threads-project-name {
          font-size: 12.5px;
          font-weight: 600;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .threads-project-count {
          min-width: 20px;
          height: 18px;
          padding: 0 6px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
          color: var(--text-muted, #94a3b8);
          background: rgba(15, 23, 42, 0.45);
          border: 1px solid rgba(148, 163, 184, 0.14);
        }

        .threads-project-content {
          padding: 2px 0 8px 14px;
        }

        @media (max-width: 768px) {
          .threads-project-header {
            height: 36px;
            margin: 2px 6px;
            padding: 0 8px;
          }

          .threads-project-name {
            font-size: 13px;
          }

          .threads-project-content {
            padding-left: 12px;
          }
        }
      `}</style>
    </div>
  );
}
