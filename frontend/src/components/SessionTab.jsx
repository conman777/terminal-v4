import { useCallback, useState, useRef, useEffect, memo } from 'react';
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
    isDragging && 'dragging',
    isDragOver && 'drag-over',
    aiType && `ai-${aiType}`,
  ].filter(Boolean).join(' ');
  const detectedAiType = inferSessionAiType(session, aiType);
  const providerLabel = getAiDisplayLabel(detectedAiType) || session.shell || 'Terminal';
  const statusClass = isBusy ? 'busy' : 'idle';
  const statusLabel = isBusy ? 'Busy' : 'Idle';

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
      <span className={`tab-status-dot-modern ${statusClass}`} />

      <div className="tab-copy-modern">
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
          <>
            <span className="tab-title-modern">{session.title}</span>
            <span className="tab-meta-modern">
              <span className={`tab-provider-label-modern${detectedAiType ? ` ai-${detectedAiType}` : ''}`}>
                {providerLabel}
              </span>
              {(showStatusLabels || isBusy) && (
                <span className={`tab-status-label-modern ${statusClass}`} aria-hidden="true">
                  {statusLabel}
                </span>
              )}
            </span>
          </>
        )}
      </div>

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
          gap: 6px;
          height: 100%;
          padding: 0 10px;
          background: transparent;
          border: none;
          border-bottom: 1px solid transparent;
          color: var(--text-muted, #71717a);
          font-family: "Cascadia Mono", "SFMono-Regular", "Fira Code", Consolas, monospace;
          font-size: 11px;
          font-weight: 400;
          white-space: nowrap;
          cursor: pointer;
          transition: color 0.1s ease;
          position: relative;
          user-select: none;
          overflow: hidden;
          flex-shrink: 0;
          margin-bottom: -1px;
        }

        .session-tab-item:hover:not(.active) {
          color: var(--text-primary, #fafafa);
        }

        .session-tab-item.active {
          color: var(--text-primary, #fafafa);
          border-bottom-color: var(--text-muted, #71717a);
        }

        .session-tab-item.ai-claude.active {
          border-bottom-color: #d4845a;
        }

        .session-tab-item.ai-codex.active {
          border-bottom-color: #7a9ec7;
        }

        .session-tab-item.ai-gemini.active {
          border-bottom-color: #6bab82;
        }

        .session-tab-item.ai-claude.drag-over,
        .session-tab-item.ai-codex.drag-over,
        .session-tab-item.ai-gemini.drag-over {
          color: var(--text-primary, #fafafa);
        }

        .session-tab-item.has-unread:not(.active) {
          color: var(--text-primary, #fafafa);
        }

        .session-tab-item.busy:not(.active) {
          color: var(--text-secondary, #a1a1aa);
        }

        .session-tab-item.busy.active {
          color: var(--text-primary, #fafafa);
        }

        .tab-status-dot-modern {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          flex-shrink: 0;
          transition: background 0.2s ease;
        }

        .tab-status-dot-modern.busy {
          background: #7a9ec7;
          animation: tabDotPulse 2s ease-in-out infinite;
        }

        @keyframes tabDotPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        .tab-status-dot-modern.idle {
          background: var(--text-muted, #52525b);
          opacity: 0.5;
        }

        .session-tab-item.ai-claude .tab-status-dot-modern.idle {
          background: #d4845a;
          opacity: 0.6;
        }

        .session-tab-item.ai-codex .tab-status-dot-modern.idle {
          background: #7a9ec7;
          opacity: 0.6;
        }

        .session-tab-item.ai-gemini .tab-status-dot-modern.idle {
          background: #6bab82;
          opacity: 0.6;
        }

        .tab-title-modern {
          min-width: 20px;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: inherit;
          font-size: 11px;
          font-weight: 400;
          color: inherit;
        }

        .tab-copy-modern {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
          flex: 1;
        }

        .tab-meta-modern {
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 0;
        }

        .tab-provider-label-modern {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: inherit;
          font-size: 9px;
          line-height: 1;
          color: var(--text-muted, #71717a);
        }

        .tab-provider-label-modern.ai-claude {
          color: #d4845a;
        }

        .tab-provider-label-modern.ai-codex {
          color: #7a9ec7;
        }

        .tab-provider-label-modern.ai-gemini {
          color: #6bab82;
        }

        .tab-status-label-modern {
          font-family: inherit;
          font-size: 9px;
          line-height: 1;
          color: var(--text-muted, #71717a);
          flex-shrink: 0;
        }

        .tab-status-label-modern.busy {
          color: #7a9ec7;
        }

        .tab-unread-dot-modern {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: var(--text-primary, #fafafa);
          flex-shrink: 0;
        }

        .tab-close-btn-modern {
          width: 16px;
          height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: inherit;
          opacity: 0;
          transition: opacity 0.1s ease, color 0.1s ease;
          cursor: pointer;
        }

        .session-tab-item:hover .tab-close-btn-modern {
          opacity: 0.4;
        }

        .tab-close-btn-modern:hover {
          opacity: 1 !important;
          color: var(--error, #f43f5e);
        }

        .tab-rename-input-modern {
          background: var(--bg-base, #09090b);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-primary, #fafafa);
          font-family: inherit;
          font-size: 11px;
          padding: 0 4px;
          height: 18px;
          width: 100px;
          outline: none;
        }

        .session-tab-item.dragging {
          opacity: 0.3;
        }

        .session-tab-item.drag-over {
          color: var(--text-primary, #fafafa);
          border-bottom-color: var(--text-muted, #71717a);
        }
      `}</style>
    </div>
  );
});
