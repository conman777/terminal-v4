import { useCallback, useState, useRef, useEffect, memo } from 'react';

/**
 * Individual session tab with drag support and right-click menu.
 */
export const SessionTab = memo(function SessionTab({
  session,
  isActive,
  hasUnread,
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
    hasUnread && 'unread',
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
      {hasUnread && <span className="tab-unread-dot" />}

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
        <span className="tab-title">{session.title}</span>
      )}

      <button
        type="button"
        className="tab-close-btn"
        onClick={handleClose}
        aria-label={`Close ${session.title}`}
        tabIndex={-1}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
});
