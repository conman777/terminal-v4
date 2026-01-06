import { useCallback, useState, useRef, useEffect } from 'react';
import { SessionTab } from './SessionTab';
import { ContextMenu } from './ContextMenu';

/**
 * Horizontal tab bar for session management.
 * Features: drag reorder, right-click menu, new tab button, activity indicators.
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
  const tabBarRef = useRef(null);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (tabBarRef.current) {
      const activeTab = tabBarRef.current.querySelector('.session-tab-item.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
      }
    }
  }, [activeSessionId]);

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

  return (
    <div className="session-tab-bar-container">
      <div
        ref={tabBarRef}
        className="session-tab-bar"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {sessions.map(session => (
          <div
            key={session.id}
            onContextMenu={(e) => handleContextMenu(e, session.id)}
          >
            <SessionTab
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
            />
          </div>
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
