import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { SessionTab } from './SessionTab';
import { ContextMenu } from './ContextMenu';

/**
 * Format a timestamp as relative time (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return null;

  const now = Date.now();
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = now - time;

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(days / 7)}w ago`;
}

/**
 * Horizontal tab bar for session management.
 * Features: drag reorder, right-click menu, new tab button, activity indicators,
 * scroll buttons for overflow, and dropdown menu for quick navigation.
 */
export function SessionTabBar({
  sessions,
  activeSessionId,
  sessionActivity,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onRenameSession,
  onReorderSessions
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [showOverflow, setShowOverflow] = useState(false);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabBarRef = useRef(null);
  const overflowRef = useRef(null);

  // Check if scroll buttons should be visible
  const updateScrollState = useCallback(() => {
    const el = tabBarRef.current;
    if (!el) return;

    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  // Update scroll state on mount and when sessions change
  useEffect(() => {
    updateScrollState();
    const el = tabBarRef.current;
    if (el) {
      el.addEventListener('scroll', updateScrollState);
      window.addEventListener('resize', updateScrollState);
      return () => {
        el.removeEventListener('scroll', updateScrollState);
        window.removeEventListener('resize', updateScrollState);
      };
    }
  }, [sessions, updateScrollState]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (tabBarRef.current) {
      const activeTab = tabBarRef.current.querySelector('.session-tab-item.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
      }
    }
    // Update scroll state after scrolling
    setTimeout(updateScrollState, 50);
  }, [activeSessionId, updateScrollState]);

  // Close overflow menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target)) {
        setShowOverflow(false);
      }
    };
    if (showOverflow) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showOverflow]);

  const handleScroll = useCallback((direction) => {
    const el = tabBarRef.current;
    if (!el) return;

    const scrollAmount = 200;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    });
  }, []);

  const handleContextMenu = useCallback((e, sessionId) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      sessionId
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleCloseOthers = useCallback((sessionId) => {
    sessions.forEach(session => {
      if (session.id !== sessionId) {
        onCloseSession(session.id);
      }
    });
  }, [sessions, onCloseSession]);

  const handleDragStart = useCallback((sessionId) => {
    setDraggedId(sessionId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
  }, []);

  const handleDrop = useCallback((draggedId, targetId) => {
    if (!onReorderSessions) return;

    const draggedIndex = sessions.findIndex(s => s.id === draggedId);
    const targetIndex = sessions.findIndex(s => s.id === targetId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      const newOrder = [...sessions];
      const [removed] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(targetIndex, 0, removed);
      onReorderSessions(newOrder.map(s => s.id));
    }
  }, [sessions, onReorderSessions]);

  const handleOverflowSelect = useCallback((sessionId) => {
    onSelectSession(sessionId);
    setShowOverflow(false);
  }, [onSelectSession]);

  const getContextMenuItems = useCallback((sessionId) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return [];

    return [
      {
        label: 'Rename',
        onClick: () => {
          // Trigger rename mode in the tab
          const tabEl = tabBarRef.current?.querySelector(`[data-session-id="${sessionId}"]`);
          if (tabEl) {
            tabEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          }
        }
      },
      { separator: true },
      {
        label: 'Close',
        onClick: () => onCloseSession(sessionId),
        shortcut: 'Cmd+W'
      },
      {
        label: 'Close Others',
        onClick: () => handleCloseOthers(sessionId),
        disabled: sessions.length <= 1
      },
      {
        label: 'Close All',
        onClick: () => sessions.forEach(s => onCloseSession(s.id)),
        danger: true
      }
    ];
  }, [sessions, onCloseSession, handleCloseOthers]);

  const hasOverflow = canScrollLeft || canScrollRight;

  return (
    <div className="session-tab-bar-container-modern">
      {/* Left scroll button */}
      {canScrollLeft && (
        <button
          type="button"
          className="session-tab-scroll-btn-modern left"
          onClick={() => handleScroll('left')}
          aria-label="Scroll tabs left"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      <div
        ref={tabBarRef}
        className="session-tab-bar-modern"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {sessions.map(session => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            hasUnread={sessionActivity?.[session.id]?.hasUnread}
            isCompleted={session.id !== activeSessionId && !sessionActivity?.[session.id]?.hasUnread}
            onSelect={onSelectSession}
            onClose={onCloseSession}
            onRename={onRenameSession}
            onCloseOthers={handleCloseOthers}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
            onContextMenu={handleContextMenu}
          />
        ))}

        <button
          type="button"
          className="session-tab-new-modern"
          onClick={onCreateSession}
          aria-label="New terminal"
          title="New terminal (Cmd+T)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Right scroll button */}
      {canScrollRight && (
        <button
          type="button"
          className="session-tab-scroll-btn-modern right"
          onClick={() => handleScroll('right')}
          aria-label="Scroll tabs right"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* All terminals dropdown menu - always visible */}
      {sessions.length > 0 && (
        <div className="session-tab-overflow-modern" ref={overflowRef}>
          <button
            type="button"
            className="session-tab-overflow-btn-modern"
            onClick={() => setShowOverflow(!showOverflow)}
            aria-label={`Show all ${sessions.length} terminals`}
            title={`Show all ${sessions.length} terminals`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span className="session-tab-count-modern">{sessions.length}</span>
          </button>

          {showOverflow && (
            <div className="session-tab-overflow-menu-modern">
              <div className="session-tab-overflow-header-modern">
                All Terminals ({sessions.length})
              </div>
              <div className="session-tab-overflow-list-modern">
                {sessions.map(session => {
                  const lastActivity = sessionActivity?.[session.id]?.lastActivity || session.updatedAt;
                  const relativeTime = formatRelativeTime(lastActivity);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={`session-tab-overflow-item-modern ${session.id === activeSessionId ? 'active' : ''}`}
                      onClick={() => handleOverflowSelect(session.id)}
                    >
                      {sessionActivity?.[session.id]?.hasUnread && (
                        <span className="overflow-unread-dot-modern" />
                      )}
                      <span className="overflow-item-title-modern">{session.title}</span>
                      {relativeTime && (
                        <span className="overflow-item-time-modern">{relativeTime}</span>
                      )}
                      {session.id === activeSessionId && (
                        <svg className="overflow-check-modern" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.sessionId)}
          onClose={handleCloseContextMenu}
        />
      )}

      <style jsx>{`
        .session-tab-bar-container-modern {
          display: flex;
          align-items: center;
          background: var(--bg-primary, #09090b);
          border-bottom: 1px solid var(--border-subtle, #27272a);
          padding: 0 4px;
          height: 38px;
          flex-shrink: 0;
          position: relative;
        }

        .session-tab-bar-modern {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 1;
          overflow-x: auto;
          scrollbar-width: none;
          height: 100%;
          padding: 0 4px;
        }

        .session-tab-bar-modern::-webkit-scrollbar {
          display: none;
        }

        .session-tab-scroll-btn-modern {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          z-index: 10;
          transition: all 0.2s ease;
        }

        .session-tab-scroll-btn-modern:hover {
          color: var(--text-primary, #fafafa);
          background: var(--bg-elevated, #27272a);
        }

        .session-tab-new-modern {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          margin-left: 4px;
        }

        .session-tab-new-modern:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .session-tab-overflow-modern {
          position: relative;
          margin-left: 4px;
        }

        .session-tab-overflow-btn-modern {
          display: flex;
          align-items: center;
          gap: 6px;
          height: 28px;
          padding: 0 10px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          color: var(--text-secondary, #a1a1aa);
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .session-tab-overflow-btn-modern:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .session-tab-overflow-menu-modern {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 200px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-default, #3f3f46);
          border-radius: 8px;
          box-shadow: var(--shadow-lg);
          z-index: 1000;
          padding: 6px;
          animation: dropdownFadeIn 0.2s ease-out;
        }

        @keyframes dropdownFadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .session-tab-overflow-header-modern {
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          margin-bottom: 4px;
        }

        .session-tab-overflow-list-modern {
          max-height: 300px;
          overflow-y: auto;
        }

        .session-tab-overflow-item-modern {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          background: transparent;
          border: none;
          color: var(--text-primary, #fafafa);
          font-size: 13px;
          text-align: left;
          border-radius: 4px;
          cursor: pointer;
          transition: background 0.15s ease;
        }

        .session-tab-overflow-item-modern:hover {
          background: var(--bg-elevated, #27272a);
        }

        .session-tab-overflow-item-modern.active {
          color: var(--accent-primary, #f59e0b);
          background: var(--accent-primary-dim);
        }

        .overflow-unread-dot-modern {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent-primary, #f59e0b);
          box-shadow: var(--shadow-glow);
        }

        .overflow-item-title-modern {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .overflow-item-time-modern {
          font-size: 11px;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
          flex-shrink: 0;
        }

        .session-tab-overflow-item-modern.active .overflow-item-time-modern {
          color: var(--accent-primary, #f59e0b);
          opacity: 0.7;
        }

        .overflow-check-modern {
          opacity: 0.8;
        }
      `}</style>
    </div>
  );
}
