import { useCallback, useState, useRef, useEffect, memo } from 'react';

/**
 * Individual session tab with drag support and right-click menu.
 */
export const SessionTab = memo(function SessionTab({
  session,
  isActive,
  hasUnread,
  isBusy,
  isReady,
  isDone,
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
    hasUnread && !isActive && 'has-unread',
    isBusy && 'busy',
    isReady && 'ready',
    isDone && !isBusy && !isActive && 'done',
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

      {hasUnread && !isActive && (
        <span className="tab-unread-dot-modern" aria-hidden="true" />
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

      <style>{`
        .session-tab-item {
          display: flex;
          align-items: center;
          gap: 8px;
          height: 30px;
          padding: 0 12px;
          background: transparent;
          border: none;
          border-top: 2px solid transparent;
          border-radius: 8px 8px 0 0;
          color: var(--text-muted, #71717a);
          font-size: 13px;
          font-weight: 400;
          white-space: nowrap;
          cursor: pointer;
          transition: all 0.2s ease;
          position: relative;
          user-select: none;
          overflow: hidden;
        }

        .session-tab-item:hover:not(.active) {
          background: rgba(255, 255, 255, 0.04);
          color: var(--text-primary, #fafafa);
        }

        .session-tab-item.active {
          background: rgba(245, 158, 11, 0.08);
          border-top-color: var(--accent-primary, #f59e0b);
          color: var(--text-primary, #fafafa);
          box-shadow: var(--tab-active-shadow, 0 0 0 1px rgba(245, 158, 11, 0.4), 0 0 12px rgba(245, 158, 11, 0.25));
          z-index: 5;
          font-weight: 600;
        }

        .session-tab-item.busy:not(.active)::before {
          content: '';
          position: absolute;
          top: 0;
          bottom: 0;
          left: -140%;
          width: 55%;
          background: linear-gradient(100deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0));
          pointer-events: none;
          animation: busy-tab-beam 1.8s linear 5;
        }

        @keyframes busy-tab-beam {
          0% { transform: translateX(0); opacity: 0; }
          12% { opacity: 0.9; }
          65% { opacity: 0.35; }
          100% { transform: translateX(520%); opacity: 0; }
        }

        .session-tab-item.done:not(.active) {
          background: var(--tab-done-bg, rgba(34, 197, 94, 0.24));
          border-top-color: var(--success, #10b981);
          color: var(--tab-done-text, #ecfdf5);
          box-shadow: var(--tab-done-shadow, 0 0 0 1px rgba(34, 197, 94, 0.42), 0 0 14px rgba(34, 197, 94, 0.24));
          font-weight: 600;
        }

        .session-tab-item.has-unread:not(.active) {
          color: var(--text-primary, #fafafa);
        }

        .session-tab-item.busy {
          background: var(--tab-busy-bg, rgba(59, 130, 246, 0.16));
          border-top-color: var(--tab-dot-busy, #60a5fa);
          color: var(--tab-busy-text, var(--text-primary, #fafafa));
          box-shadow: var(--tab-busy-shadow-soft, 0 0 0 1px rgba(59, 130, 246, 0.35), 0 0 10px rgba(59, 130, 246, 0.2));
        }

        .session-tab-item.busy.active {
          background: rgba(245, 158, 11, 0.08);
          color: var(--tab-active-text, var(--text-primary, #fafafa));
          border-top-color: var(--accent-primary, #f59e0b);
          box-shadow: var(--tab-active-shadow, 0 0 0 1px rgba(245, 158, 11, 0.4), 0 0 12px rgba(245, 158, 11, 0.25));
          animation: none;
        }

        @keyframes session-tab-busy-pulse {
          0%, 100% { box-shadow: var(--tab-busy-shadow, 0 0 0 1px rgba(59, 130, 246, 0.5), 0 0 16px rgba(59, 130, 246, 0.3)); }
          50% { box-shadow: var(--tab-busy-shadow-peak, 0 0 0 1px rgba(96, 165, 250, 0.6), 0 0 22px rgba(59, 130, 246, 0.4)); }
        }

        .tab-status-dot-modern {
          width: 3px;
          height: 14px;
          border-radius: 2px;
          flex-shrink: 0;
          margin-left: -6px;
          transition: background 0.3s ease, box-shadow 0.3s ease;
        }

        .tab-status-dot-modern.busy {
          background: var(--tab-dot-busy, #60a5fa);
          box-shadow: 0 0 0 1.5px rgba(59, 130, 246, 0.4), 0 0 10px rgba(59, 130, 246, 0.4);
          animation: session-tab-dot-busy-pulse 1.5s ease-in-out infinite;
        }

        @keyframes session-tab-dot-busy-pulse {
          0%, 100% { box-shadow: 0 0 0 1.5px rgba(59, 130, 246, 0.4), 0 0 10px rgba(59, 130, 246, 0.4); }
          50% { box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.5), 0 0 14px rgba(59, 130, 246, 0.5); }
        }

        .tab-status-dot-modern.ready {
          background: var(--tab-dot-ready-active, #4ade80);
          box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.3), 0 0 6px rgba(34, 197, 94, 0.25);
        }

        .session-tab-item:not(.active) .tab-status-dot-modern.ready {
          background: var(--tab-dot-ready-inactive, #52525b);
          box-shadow: none;
        }

        .session-tab-item.done:not(.active) .tab-status-dot-modern.ready {
          background: var(--tab-dot-ready-active, #4ade80);
          box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35), 0 0 8px rgba(34, 197, 94, 0.25);
        }

        .tab-title-modern {
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .tab-unread-dot-modern {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.4), 0 0 8px rgba(245, 158, 11, 0.4);
          flex-shrink: 0;
          margin-left: 2px;
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
          background: var(--bg-primary, #0a0a0c);
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
          transform: scale(0.97);
          box-shadow: var(--shadow-md);
        }

        .session-tab-item.drag-over {
          background: var(--accent-primary-dim);
          border-top-color: var(--accent-primary);
        }
      `}</style>
    </div>
  );
});
