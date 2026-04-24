import { useState, useCallback, useEffect } from 'react';
import { ContextMenu } from './ContextMenu';
import { getPreferredSessionTopic } from '../utils/sessionTopic';

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
  isBusy,
  isActive,
  hasActivity,
  onSelect,
  onPin,
  onUnpin,
  onArchive,
  onUnarchive,
  onUpdateThreadMetadata,
  onTopicChange,
  onRenameSession,
  onClose
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isTouch, setIsTouch] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);

  const thread = session.thread || {};
  const topic = getPreferredSessionTopic(thread.topic, session.title || 'New session');
  const isPinned = thread.pinned || false;
  const isArchived = thread.archived || false;
  const effectiveSandboxMode = session.sandbox?.mode ?? 'off';
  const requestedSandboxMode = thread.sandboxMode ?? effectiveSandboxMode;
  const isSandboxed = requestedSandboxMode !== 'off' || effectiveSandboxMode !== 'off';
  const sandboxChangePending = requestedSandboxMode !== effectiveSandboxMode;
  const sessionAge = formatRelativeTime(session.createdAt);
  const resolvedIsBusy = typeof isBusy === 'boolean' ? isBusy : Boolean(session.isBusy);
  const showReadyIndicator = !resolvedIsBusy && Boolean(hasActivity) && !isActive;

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
      if (onRenameSession) {
        onRenameSession(session.id, trimmed);
      } else {
        onTopicChange?.(session.id, trimmed);
      }
    }
    setIsEditing(false);
  }, [editValue, onRenameSession, topic, session.id, onTopicChange]);

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

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const contextMenuItems = contextMenu ? [
    {
      label: 'Rename',
      onClick: () => { setEditValue(topic); setIsEditing(true); }
    },
    {
      label: isPinned ? 'Unpin' : 'Pin',
      onClick: () => isPinned ? onUnpin?.(session.id) : onPin?.(session.id)
    },
    {
      label: isArchived ? 'Unarchive' : 'Archive',
      onClick: () => isArchived ? onUnarchive?.(session.id) : onArchive?.(session.id)
    },
    {
      label: 'Close',
      danger: true,
      onClick: () => onClose?.(session.id)
    }
  ] : [];

  return (
    <div
      className={`threads-session-item ${isActive ? 'active' : ''} ${isArchived ? 'archived' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={undefined}
    >
      {(resolvedIsBusy || showReadyIndicator) && (
        <div
          className={`threads-session-indicator ${resolvedIsBusy ? 'busy' : 'ready'}`}
          aria-label={resolvedIsBusy ? 'Working' : 'Ready to review'}
        >
          {resolvedIsBusy ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
              <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <span className="threads-session-ready-dot" aria-hidden="true" />
          )}
        </div>
      )}

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
            {isSandboxed && (
              <span
                className={`threads-session-sandbox-badge${sandboxChangePending ? ' pending' : ''}`}
                title={sandboxChangePending ? 'Sandbox setting will apply next launch' : 'Sandbox copy enabled'}
              >
                SBX
              </span>
            )}
          </>
        )}
      </div>

      {/* Session age and actions */}
      <div className="threads-session-meta">
        {!showActions && sessionAge && (
          <span className="threads-session-time">{sessionAge}</span>
        )}

        {showActions && (
          <div className="threads-session-actions">
            <button
              type="button"
              className="threads-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                setEditValue(topic);
                setIsEditing(true);
              }}
              title="Rename session"
              aria-label="Rename session"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
