import { useCallback, useState, useRef, useEffect, useMemo, memo } from 'react';
import { getAiDisplayLabel, inferSessionAiType } from '../utils/aiProviders';

/**
 * Individual session tab with drag support and right-click menu.
 */
export const SessionTab = memo(function SessionTab({
  session,
  isActive,
  hasUnread,
  isBusy,
  isReady,
  showStatusLabels = false,
  onSelect,
  onClose,
  onRename,
  onCloseOthers,
  onDragStart,
  onDragEnd,
  onDrop,
  onContextMenu,
  aiType,
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [isDragging, setIsDragging] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef(null);
  const tabRef = useRef(null);
  const resolvedAiType = useMemo(
    () => aiType ?? inferSessionAiType(session),
    [aiType, session]
  );
  const providerLabel = useMemo(
    () => (resolvedAiType ? getAiDisplayLabel(resolvedAiType) ?? resolvedAiType : null),
    [resolvedAiType]
  );
  const statusLabel = isBusy ? 'Busy' : 'Idle';
  const showUnreadDot = hasUnread && !isActive;

  // Focus input when renaming starts
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleClick = useCallback((e) => {
    if (isRenaming) return;
    onSelect(session.id);
  }, [isRenaming, onSelect, session.id]);

  const handleClose = useCallback((e) => {
    e.stopPropagation();
    onClose(session.id);
  }, [onClose, session.id]);

  const handleDoubleClick = useCallback((e) => {
    e.stopPropagation();
    setRenameValue(session.title);
    setIsRenaming(true);
  }, [session.title]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(session.id, trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, session.id, session.title, onRename]);

  const handleRenameKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
      setRenameValue(session.title);
    }
  }, [handleRenameSubmit, session.title]);

  // Drag handlers
  const handleDragStart = useCallback((e) => {
    setIsDragging(true);
    e.dataTransfer.setData('session-id', session.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(session.id);
  }, [session.id, onDragStart]);

  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
    onDragEnd?.();
  }, [onDragEnd]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const draggedId = e.dataTransfer.getData('session-id');
    if (draggedId && draggedId !== session.id) {
      onDrop?.(draggedId, session.id);
    }
  }, [session.id, onDrop]);

  // Context menu handler
  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    if (onContextMenu) {
      onContextMenu(e, session.id);
    }
  }, [onContextMenu, session.id]);

  const tabClasses = [
    'session-tab-item',
    isActive && 'active',
    hasUnread && !isActive && 'has-unread',
    isBusy && 'busy',
    isDragging && 'dragging',
    isDragOver && 'drag-over',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={tabRef}
      className={tabClasses}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      draggable={!isRenaming}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-session-id={session.id}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
    >
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tab-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
          maxLength={60}
        />
      ) : (
        <div className="tab-copy">
          <div className="tab-title-row">
            <span className="tab-title">{session.title}</span>
            {showUnreadDot ? (
              <span
                className="tab-unread-dot-modern"
                aria-label="Unread activity"
                title="Unread activity"
              />
            ) : null}
          </div>
          <div className="tab-meta-row">
            <span
              className={`tab-status-dot-modern ${isBusy ? 'busy' : 'idle'}`}
              aria-hidden="true"
            />
            {showStatusLabels ? (
              <span className="tab-status-label-modern">{statusLabel}</span>
            ) : null}
            {providerLabel ? (
              <span className="tab-provider-label-modern">{providerLabel}</span>
            ) : null}
          </div>
        </div>
      )}

      <button
        type="button"
        className="tab-close-btn"
        onClick={handleClose}
        aria-label={`Close ${session.title}`}
        tabIndex={-1}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <style>{`
        .session-tab-item {
          display: flex;
          align-items: center;
          gap: 6px;
          height: 100%;
          padding: 0 14px;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--text-muted);
          font-family: var(--font-ui);
          font-size: 12px;
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
          position: relative;
          user-select: none;
          flex-shrink: 0;
          margin-bottom: -1px;
        }

        .session-tab-item:hover:not(.active) {
          color: var(--text-primary);
          background: color-mix(in srgb, var(--bg-hover) 45%, transparent);
        }

        .session-tab-item.active {
          color: var(--text-primary);
          border-bottom-color: var(--accent-primary);
        }

        .session-tab-item.has-unread:not(.active) {
          color: var(--text-primary);
        }

        .session-tab-item.has-unread:not(.active)::before {
          content: '';
          position: absolute;
          left: 4px;
          top: 50%;
          transform: translateY(-50%);
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent-primary);
        }

        .session-tab-item.drag-over {
          color: var(--text-primary);
          border-bottom-color: var(--accent-primary-light);
        }

        .session-tab-item.dragging {
          opacity: 0.3;
        }

        .tab-title {
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: inherit;
          font-size: inherit;
          font-weight: inherit;
          color: inherit;
        }

        .tab-copy {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-width: 0;
          gap: 2px;
        }

        .tab-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .tab-meta-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          color: var(--text-muted, #71717a);
          font-size: 10px;
          line-height: 1;
        }

        .tab-unread-dot-modern,
        .tab-status-dot-modern {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          flex-shrink: 0;
        }

        .tab-unread-dot-modern {
          background: var(--accent-primary, #38bdf8);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary, #38bdf8) 26%, transparent);
        }

        .tab-status-dot-modern.busy {
          background: var(--warning, #f59e0b);
        }

        .tab-status-dot-modern.idle {
          background: color-mix(in srgb, var(--text-muted, #71717a) 88%, transparent);
        }

        .tab-status-label-modern,
        .tab-provider-label-modern {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .tab-provider-label-modern {
          color: color-mix(in srgb, var(--text-secondary, #a1a1aa) 92%, transparent);
        }

        .tab-close-btn {
          width: 16px;
          height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: inherit;
          opacity: 0;
          border-radius: 3px;
          transition: opacity 0.1s ease, background 0.1s ease;
          cursor: pointer;
        }

        .session-tab-item:hover .tab-close-btn {
          opacity: 0.35;
        }

        .tab-close-btn:hover {
          opacity: 1 !important;
          background: color-mix(in srgb, var(--error) 12%, transparent);
          color: var(--error);
        }

        .tab-rename-input {
          background: var(--bg-base, #09090b);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-primary, #fafafa);
          font-family: inherit;
          font-size: 12px;
          padding: 1px 6px;
          height: 20px;
          width: 120px;
          outline: none;
          border-radius: 3px;
        }
      `}</style>
    </div>
  );
});
