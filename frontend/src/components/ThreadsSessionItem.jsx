import { useState, useCallback, useEffect } from 'react';
import { getAiDisplayLabel, inferSessionAiType } from '../utils/aiProviders';

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
  const detectedAiType = inferSessionAiType(session);
  const providerLabel = getAiDisplayLabel(detectedAiType) || session.shell || 'Terminal';
  const runtimeLabel = session.isBusy ? 'Responding' : hasActivity ? 'Updated' : formatRelativeTime(lastActivity);

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
          <>
            <span className="threads-session-topic">{topic}</span>
            <div className="threads-session-secondary">
              <span className={`threads-session-provider${detectedAiType ? ` ai-${detectedAiType}` : ''}`}>
                {providerLabel}
              </span>
              {gitStats && (gitStats.linesAdded > 0 || gitStats.linesRemoved > 0) && (
                <span className="threads-session-git-stats">
                  {gitStats.linesAdded > 0 && <span className="git-added">+{gitStats.linesAdded}</span>}
                  {gitStats.linesRemoved > 0 && <span className="git-removed">-{gitStats.linesRemoved}</span>}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Time and actions */}
      <div className="threads-session-meta">
        {!showActions && (
          <span className={`threads-session-time${session.isBusy ? ' busy' : hasActivity ? ' attention' : ''}`}>{runtimeLabel}</span>
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

      <style>{`
        .threads-session-item {
          min-height: 38px;
          display: flex;
          align-items: flex-start;
          padding: 0 12px;
          cursor: pointer;
          user-select: none;
          transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
          color: rgba(226, 232, 240, 0.76);
          position: relative;
          gap: 8px;
          margin: 2px 0;
          border-radius: 12px;
          border: 1px solid transparent;
          font-family: "Segoe UI Variable", "Segoe UI", Inter, system-ui, sans-serif;
        }

        .threads-session-item:hover {
          background: rgba(255, 255, 255, 0.045);
          color: #f8fafc;
        }

        .threads-session-item.active {
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.085), rgba(255, 255, 255, 0.065));
          color: #f8fafc;
          border-color: rgba(148, 163, 184, 0.14);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        }

        .threads-session-item.archived {
          opacity: 0.4;
        }

        .threads-session-content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
          padding: 8px 0;
        }

        .threads-session-topic {
          font-family: inherit;
          font-size: 14px;
          font-weight: 520;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.3;
          letter-spacing: -0.01em;
        }

        .threads-session-secondary {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .threads-session-provider {
          font-family: inherit;
          font-size: 11px;
          font-weight: 500;
          color: rgba(226, 232, 240, 0.42);
        }

        .threads-session-provider.ai-claude {
          color: #d4845a;
        }

        .threads-session-provider.ai-codex {
          color: #7a9ec7;
        }

        .threads-session-provider.ai-gemini {
          color: #6bab82;
        }

        .threads-session-edit {
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          background: rgba(8, 12, 20, 0.88);
          border: 1px solid rgba(148, 163, 184, 0.18);
          border-radius: 8px;
          padding: 4px 8px;
          color: var(--text-primary, #fafafa);
          outline: none;
          width: 100%;
        }

        .threads-session-git-stats {
          display: flex;
          gap: 4px;
          font-family: inherit;
          font-size: 10px;
          white-space: nowrap;
          opacity: 0.85;
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
          padding-top: 10px;
        }

        .threads-session-time {
          font-family: inherit;
          font-size: 12px;
          color: rgba(226, 232, 240, 0.42);
          white-space: nowrap;
          font-weight: 500;
        }

        .threads-session-time.busy {
          color: #7a9ec7;
        }

        .threads-session-time.attention {
          color: #d4a854;
        }

        .threads-session-actions {
          display: flex;
          align-items: center;
          gap: 3px;
        }

        .threads-action-btn {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: rgba(226, 232, 240, 0.42);
          cursor: pointer;
          transition: color 0.12s ease, background 0.12s ease;
          border-radius: 6px;
        }

        .threads-action-btn:hover {
          color: #fafafa;
          background: rgba(255, 255, 255, 0.06);
        }

        .threads-action-btn.active {
          color: rgba(248, 250, 252, 0.78);
        }

        .threads-action-btn.close:hover {
          color: var(--error, #f43f5e);
        }

        @media (max-width: 768px) {
          .threads-session-item {
            min-height: 36px;
            padding: 0 10px;
          }

          .threads-session-topic {
            font-size: 12px;
          }

          .threads-session-meta {
            min-width: 36px;
          }

          .threads-action-btn {
            width: 20px;
            height: 20px;
          }
        }
      `}</style>
    </div>
  );
}
