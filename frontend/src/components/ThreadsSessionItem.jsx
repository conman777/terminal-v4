import { useState, useCallback, useEffect } from 'react';

/**
 * Format a relative time string (e.g., "9m", "2h", "3d")
 */
function formatRelativeTime(isoString) {
  if (!isoString) return '';

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMinutes > 0) return `${diffMinutes}m`;
  return 'now';
}

export default function ThreadsSessionItem({
  session,
  isActive,
  hasActivity,
  onSelect,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onTopicChange,
  onClose
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isTouch, setIsTouch] = useState(false);

  const thread = session.thread || {};
  const topic = thread.topic || session.title || 'New session';
  const isPinned = thread.pinned || false;
  const isArchived = thread.archived || false;
  const gitStats = thread.gitStats;
  const lastActivity = thread.lastActivityAt || session.updatedAt;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(hover: none)');
    const update = () => setIsTouch(Boolean(media.matches));
    update();
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  const showActions = isHovered || (isTouch && isActive);

  const handleClick = useCallback(() => {
    onSelect?.(session.id);
  }, [session.id, onSelect]);

  const handleDoubleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setEditValue(topic);
    setIsEditing(true);
  }, [topic]);

  const handleEditSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== topic) {
      onTopicChange?.(session.id, trimmed);
    }
    setIsEditing(false);
  }, [editValue, topic, session.id, onTopicChange]);

  const handleEditKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      handleEditSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  }, [handleEditSubmit]);

  const handlePinClick = useCallback((e) => {
    e.stopPropagation();
    if (isPinned) {
      onUnpin?.(session.id);
    } else {
      onPin?.(session.id);
    }
  }, [isPinned, session.id, onPin, onUnpin]);

  const handleArchiveClick = useCallback((e) => {
    e.stopPropagation();
    if (isArchived) {
      onUnarchive?.(session.id);
    } else {
      onArchive?.(session.id);
    }
  }, [isArchived, session.id, onArchive, onUnarchive]);

  const handleCloseClick = useCallback((e) => {
    e.stopPropagation();
    onClose?.(session.id);
  }, [session.id, onClose]);

  return (
    <div
      className={`threads-session-item ${isActive ? 'active' : ''} ${isArchived ? 'archived' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={undefined}
    >
      {/* Topic/title */}
      <div className="threads-session-content">
        {isEditing ? (
          <input
            type="text"
            className="threads-session-edit"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleEditSubmit}
            onKeyDown={handleEditKeyDown}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="threads-session-topic">{topic}</span>
        )}

        {/* Git stats */}
        {gitStats && (gitStats.linesAdded > 0 || gitStats.linesRemoved > 0) && (
          <span className="threads-session-git-stats">
            {gitStats.linesAdded > 0 && <span className="git-added">+{gitStats.linesAdded}</span>}
            {gitStats.linesRemoved > 0 && <span className="git-removed">-{gitStats.linesRemoved}</span>}
          </span>
        )}
      </div>

      {/* Time and actions */}
      <div className="threads-session-meta">
        {!showActions && (
          <span className="threads-session-time">{formatRelativeTime(lastActivity)}</span>
        )}

        {showActions && (
          <div className="threads-session-actions">
            <button
              type="button"
              className={`threads-action-btn ${isPinned ? 'active' : ''}`}
              onClick={handlePinClick}
              title={isPinned ? 'Unpin' : 'Pin'}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
              </svg>
            </button>
            <button
              type="button"
              className={`threads-action-btn ${isArchived ? 'active' : ''}`}
              onClick={handleArchiveClick}
              title={isArchived ? 'Unarchive' : 'Archive'}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 8.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 8.25ZM2 2.75a.75.75 0 0 0-.75.75v1c0 .414.336.75.75.75h12a.75.75 0 0 0 .75-.75v-1a.75.75 0 0 0-.75-.75H2Zm-.5 5.75A1.5 1.5 0 0 1 3 7h10a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-4Z" />
              </svg>
            </button>
            <button
              type="button"
              className="threads-action-btn close"
              onClick={handleCloseClick}
              title="Close session"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
        )}
      </div>

      <style jsx>{`
        .threads-session-item {
          height: 34px;
          display: flex;
          align-items: center;
          padding: 0 10px 0 12px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s ease;
          color: var(--text-secondary, #a1a1aa);
          position: relative;
          gap: 8px;
          margin: 1px 8px;
          border-radius: 8px;
        }

        .threads-session-item:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .threads-session-item.active {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .threads-session-item.archived {
          opacity: 0.5;
        }

        .threads-session-content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .threads-session-topic {
          font-size: 12.5px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.2;
        }

        .threads-session-edit {
          font-size: 12px;
          font-weight: 500;
          background: var(--bg-elevated, #27272a);
          border: 1px solid var(--accent-primary, #f59e0b);
          border-radius: 3px;
          padding: 2px 6px;
          color: var(--text-primary, #fafafa);
          outline: none;
          width: 100%;
        }

        .threads-session-git-stats {
          display: flex;
          gap: 6px;
          font-size: 10px;
          font-family: 'JetBrains Mono', monospace;
        }

        .git-added {
          color: var(--success, #10b981);
        }

        .git-removed {
          color: var(--error, #f43f5e);
        }

        .threads-session-meta {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          min-width: 44px;
          justify-content: flex-end;
        }

        .threads-session-time {
          font-size: 11px;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
        }

        .threads-session-actions {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .threads-action-btn {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .threads-action-btn:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .threads-action-btn.active {
          color: var(--accent-primary, #f59e0b);
        }

        .threads-action-btn.close:hover {
          background: rgba(244, 63, 94, 0.15);
          color: var(--error, #f43f5e);
        }

        @media (max-width: 768px) {
          .threads-session-item {
            height: 40px;
            margin: 2px 6px;
            padding: 0 8px 0 10px;
          }

          .threads-session-topic {
            font-size: 13px;
          }

          .threads-session-meta {
            min-width: 38px;
          }

          .threads-action-btn {
            width: 22px;
            height: 22px;
          }
        }
      `}</style>
    </div>
  );
}
