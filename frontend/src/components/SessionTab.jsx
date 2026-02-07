import { useCallback, useState, useRef, useEffect, memo } from 'react';

/**
 * Individual session tab with drag support and right-click menu.
 */
export const SessionTab = memo(function SessionTab({
  session,
  isActive,
  isBusy,
  isReady,
  onSelect,
  onClose,
  onRename,
  onCloseOthers,
  onDragStart,
  onDragEnd,
  onDrop,
  onContextMenu
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [isDragging, setIsDragging] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef(null);
  const tabRef = useRef(null);

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
    isBusy && 'busy',
    isReady && 'ready',
    isDragging && 'dragging',
    isDragOver && 'drag-over'
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
      title={`Session ID: ${session.id}`}
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
    >
      <span className={`tab-status-dot-modern ${isBusy ? 'busy' : 'ready'}`} />

      {isRenaming ? (
        <input
          ref={inputRef}
          className="tab-rename-input-modern"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
          maxLength={60}
        />
      ) : (
        <span className="tab-title-modern">{session.title}</span>
      )}

      <button
        type="button"
        className="tab-close-btn-modern"
        onClick={handleClose}
        aria-label={`Close ${session.title}`}
        tabIndex={-1}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <style jsx>{`
        .session-tab-item {
          display: flex;
          align-items: center;
          gap: 8px;
          height: 28px;
          padding: 0 10px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          border-radius: 6px;
          color: var(--text-secondary, #a1a1aa);
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          transition: all 0.2s ease;
          position: relative;
          user-select: none;
        }

        .session-tab-item:hover:not(.active) {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
          border-color: var(--border-default, #3f3f46);
        }

        .session-tab-item.active {
          background: rgba(59, 130, 246, 0.2);
          border-color: rgba(59, 130, 246, 0.7);
          color: #dbeafe;
          box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3), 0 0 12px rgba(59, 130, 246, 0.25);
          z-index: 5;
          font-weight: 600;
        }

        .session-tab-item.busy:not(.active) {
          border-color: rgba(59, 130, 246, 0.4);
          color: var(--text-primary, #fafafa);
        }

        .tab-status-dot-modern {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .tab-status-dot-modern.busy {
          background: #60a5fa;
          box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.35), 0 0 8px rgba(59, 130, 246, 0.35);
        }

        .tab-status-dot-modern.ready {
          background: #4ade80;
          box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35), 0 0 8px rgba(34, 197, 94, 0.3);
        }

        .tab-title-modern {
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tab-close-btn-modern {
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: inherit;
          border-radius: 4px;
          opacity: 0.5;
          transition: all 0.2s ease;
          margin-right: -4px;
        }

        .tab-close-btn-modern:hover {
          background: rgba(244, 63, 94, 0.15);
          color: var(--error, #f43f5e);
          opacity: 1;
        }

        .tab-rename-input-modern {
          background: var(--bg-primary, #09090b);
          border: 1px solid var(--accent-primary, #f59e0b);
          border-radius: 4px;
          color: var(--text-primary, #fafafa);
          font-size: 12px;
          padding: 0 6px;
          height: 20px;
          width: 120px;
          outline: none;
          box-shadow: 0 0 10px var(--accent-primary-dim);
        }

        .session-tab-item.dragging {
          opacity: 0.4;
          transform: scale(0.95);
        }

        .session-tab-item.drag-over {
          border-style: dashed;
          background: var(--accent-primary-dim);
          transform: scale(1.02);
        }
      `}</style>
    </div>
  );
});
