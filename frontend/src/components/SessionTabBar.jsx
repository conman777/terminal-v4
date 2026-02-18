import { useCallback, useState, useRef, useEffect } from 'react';
import { SessionTab } from './SessionTab';
import { ContextMenu } from './ContextMenu';

const AI_TYPE_OPTIONS = [
  { id: null,      label: 'CLI (default)', color: '#f59e0b' },
  { id: 'claude',  label: 'Claude Code',   color: '#ff6b2b' },
  { id: 'codex',   label: 'Codex',         color: '#3b82f6' },
  { id: 'gemini',  label: 'Gemini',        color: '#22c55e' },
];

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
  onReorderSessions,
  inHeader = false,
  showStatusLabels = false,
  sessionAiTypes,
  onSetSessionAiType,
}) {
  const [contextMenu, setContextMenu] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabBarRef = useRef(null);

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
        activeTab.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
      }
    }
    // Update scroll state after scrolling
    setTimeout(updateScrollState, 50);
  }, [activeSessionId, updateScrollState]);

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

  const getContextMenuItems = useCallback((sessionId) => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return [];

    const currentAiType = sessionAiTypes?.[sessionId] ?? null;

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
      ...AI_TYPE_OPTIONS.map(opt => ({
        label: opt.label,
        icon: <span style={{ width: 8, height: 8, borderRadius: '50%', background: opt.color, display: 'inline-block', flexShrink: 0 }} />,
        shortcut: currentAiType === opt.id ? '✓' : undefined,
        onClick: () => onSetSessionAiType?.(sessionId, opt.id),
      })),
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
  }, [sessions, sessionAiTypes, onSetSessionAiType, onCloseSession, handleCloseOthers]);

  return (
    <div className={`session-tab-bar-container-modern${inHeader ? ' in-header' : ''}`}>
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
        {sessions.map((session) => {
          const activityState = sessionActivity?.[session.id];
          const isActive = session.id === activeSessionId;
          const backendBusy = typeof session?.isBusy === 'boolean'
            ? session.isBusy
            : Boolean(activityState?.isBusy);
          const isBusy = isActive ? backendBusy : false;

          return (
            <SessionTab
              key={session.id}
              session={session}
              isActive={isActive}
              hasUnread={Boolean(activityState?.hasUnread)}
              isBusy={isBusy}
              isReady={!isBusy}
              showStatusLabels={showStatusLabels}
              onSelect={onSelectSession}
              onClose={onCloseSession}
              onRename={onRenameSession}
              onCloseOthers={handleCloseOthers}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDrop={handleDrop}
              onContextMenu={handleContextMenu}
              aiType={sessionAiTypes?.[session.id]}
            />
          );
        })}

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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.sessionId)}
          onClose={handleCloseContextMenu}
        />
      )}

      <style>{`
        .session-tab-bar-container-modern {
          display: flex;
          align-items: center;
          background: var(--bg-primary, #0a0a0c);
          border-bottom: 1px solid var(--border-subtle, #1e1e21);
          padding: 0 4px;
          height: 38px;
          flex-shrink: 0;
          position: relative;
        }

        .session-tab-bar-container-modern.in-header {
          background: transparent;
          border-bottom: none;
          height: 100%;
          padding: 0;
        }

        .session-tab-bar-modern {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 1;
          overflow-x: auto;
          scrollbar-width: none;
          height: 100%;
          padding: 6px 4px;
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
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          z-index: 10;
          transition: all 0.2s ease;
        }

        .session-tab-scroll-btn-modern:hover {
          color: var(--text-primary, #fafafa);
          background: var(--bg-elevated, #1e1e21);
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
          background: var(--bg-surface, #141416);
          color: var(--text-primary, #fafafa);
        }

      `}</style>
    </div>
  );
}
