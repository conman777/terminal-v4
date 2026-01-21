import { useCallback, useState, useRef, useEffect } from 'react';
import { SessionTab } from './SessionTab';
import { ContextMenu } from './ContextMenu';

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
    <div className="session-tab-bar-container">
      {/* Left scroll button */}
      {canScrollLeft && (
        <button
          type="button"
          className="session-tab-scroll-btn left"
          onClick={() => handleScroll('left')}
          aria-label="Scroll tabs left"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      <div
        ref={tabBarRef}
        className="session-tab-bar"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {sessions.map(session => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            hasUnread={sessionActivity?.[session.id]?.hasUnread}
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
          className="session-tab-new"
          onClick={onCreateSession}
          aria-label="New terminal"
          title="New terminal (Cmd+T)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Right scroll button */}
      {canScrollRight && (
        <button
          type="button"
          className="session-tab-scroll-btn right"
          onClick={() => handleScroll('right')}
          aria-label="Scroll tabs right"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* Overflow dropdown menu */}
      {hasOverflow && (
        <div className="session-tab-overflow" ref={overflowRef}>
          <button
            type="button"
            className="session-tab-overflow-btn"
            onClick={() => setShowOverflow(!showOverflow)}
            aria-label={`Show all ${sessions.length} terminals`}
            title={`Show all ${sessions.length} terminals`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span className="session-tab-count">{sessions.length}</span>
          </button>

          {showOverflow && (
            <div className="session-tab-overflow-menu">
              <div className="session-tab-overflow-header">
                All Terminals ({sessions.length})
              </div>
              <div className="session-tab-overflow-list">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    type="button"
                    className={`session-tab-overflow-item ${session.id === activeSessionId ? 'active' : ''}`}
                    onClick={() => handleOverflowSelect(session.id)}
                  >
                    {sessionActivity?.[session.id]?.hasUnread && (
                      <span className="overflow-unread-dot" />
                    )}
                    <span className="overflow-item-title">{session.title}</span>
                    {session.id === activeSessionId && (
                      <svg className="overflow-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
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
    </div>
  );
}
