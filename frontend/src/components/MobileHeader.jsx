import { useState, useRef, useEffect, useCallback } from 'react';
import { MobileDrawer } from './MobileDrawer';
import { ContextMenu } from './ContextMenu';
import { Dropdown } from './Dropdown';
import { useLongPress } from '../hooks/useLongPress';

// Separate component for mobile tab to use hooks properly
function MobileTab({ session, isActive, onSelect, onLongPress, isRenaming, renameValue, onRenameChange, onRenameSubmit, onRenameKeyDown, inputRef }) {
  const longPressHandlers = useLongPress((coords) => {
    onLongPress(session.id, coords);
  });

  if (isRenaming) {
    return (
      <input
        ref={inputRef}
        type="text"
        className="mobile-header-tab-input"
        value={renameValue}
        onChange={(e) => onRenameChange(e.target.value)}
        onBlur={onRenameSubmit}
        onKeyDown={onRenameKeyDown}
        autoFocus
      />
    );
  }

  return (
    <button
      type="button"
      className={`mobile-header-tab${isActive ? ' active' : ''}`}
      onClick={() => onSelect(session.id)}
      {...longPressHandlers}
    >
      {session.title || 'Terminal'}
    </button>
  );
}

export function MobileHeader({
  activeSessions,
  inactiveSessions,
  activeSessionId,
  onSelectSession,
  onRestoreSession,
  onCreateSession,
  onRenameSession,
  onCloseSession,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenBookmarks,
  keybarOpen,
  onToggleKeybar,
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  currentPath,
  onAddScanFolder = null,
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  showFileManager,
  onToggleFileManager,
  onNavigateToPath,
  isNavCollapsed = false
}) {
  const [showDrawer, setShowDrawer] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [showOverflow, setShowOverflow] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const tabsRef = useRef(null);
  const headerRef = useRef(null);
  const renameInputRef = useRef(null);
  const overflowRef = useRef(null);

  // Update --mobile-header-height CSS variable
  useEffect(() => {
    if (!headerRef.current) return;

    const updateHeight = () => {
      if (headerRef.current) {
        const height = headerRef.current.offsetHeight;
        document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
      }
    };

    // Initial update
    updateHeight();

    // Use ResizeObserver for changes in height (e.g. row toggles)
    const observer = new ResizeObserver(updateHeight);
    observer.observe(headerRef.current);

    return () => observer.disconnect();
  }, []);

  // Check if tabs overflow
  const updateOverflowState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    setHasOverflow(el.scrollWidth > el.clientWidth + 1);
  }, []);

  // Update overflow state on mount and when sessions change
  useEffect(() => {
    updateOverflowState();
    const el = tabsRef.current;
    if (el) {
      el.addEventListener('scroll', updateOverflowState);
      window.addEventListener('resize', updateOverflowState);
      return () => {
        el.removeEventListener('scroll', updateOverflowState);
        window.removeEventListener('resize', updateOverflowState);
      };
    }
  }, [activeSessions.length, updateOverflowState]);

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

  const handleOverflowSelect = useCallback((sessionId) => {
    onSelectSession(sessionId);
    setShowOverflow(false);
  }, [onSelectSession]);

  const handleTabLongPress = useCallback((sessionId, coords) => {
    setTabContextMenu({ sessionId, x: coords.x, y: coords.y });
  }, []);

  const handleStartRename = useCallback((sessionId) => {
    const session = activeSessions.find(s => s.id === sessionId);
    if (session) {
      setRenameValue(session.title || 'Terminal');
      setRenamingSessionId(sessionId);
      setTabContextMenu(null);
    }
  }, [activeSessions]);

  const handleRenameSubmit = useCallback(() => {
    if (renamingSessionId) {
      const trimmed = renameValue.trim();
      if (trimmed) {
        onRenameSession(renamingSessionId, trimmed);
      }
      setRenamingSessionId(null);
      setRenameValue('');
    }
  }, [renamingSessionId, renameValue, onRenameSession]);

  const handleRenameKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenamingSessionId(null);
      setRenameValue('');
    }
  }, [handleRenameSubmit]);

  const handleCloseFromMenu = useCallback((sessionId) => {
    onCloseSession(sessionId);
    setTabContextMenu(null);
  }, [onCloseSession]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (tabsRef.current && activeSessionId) {
      const activeTab = tabsRef.current.querySelector('.mobile-header-tab.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [activeSessionId]);

  const toolsItems = [
    {
      label: 'Process Manager',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
      onClick: () => { /* Logic to open Process Manager - typically handled in App */ }
    },
    {
      label: 'Bookmarks',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      ),
      onClick: onOpenBookmarks
    },
    {
      label: 'File Manager',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      active: showFileManager,
      onClick: onToggleFileManager
    }
  ];

  return (
    <>
      <header 
        ref={headerRef}
        className={`mobile-header mobile-header-modern${isNavCollapsed ? ' nav-collapsed' : ''}`}
      >
        <div className="mobile-header-top-row">
          <button
            className="mobile-header-btn-modern"
            onClick={() => setShowDrawer(true)}
            aria-label="Menu"
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          <div className="mobile-mode-toggle">
            <button
              className={`mode-btn ${mobileView === 'terminal' || mobileView === 'preview' ? 'active' : ''}`}
              onClick={() => onViewChange?.('terminal')}
            >
              Term
            </button>
            <button
              className={`mode-btn ${mobileView === 'claude' ? 'active' : ''}`}
              onClick={() => onViewChange?.('claude')}
            >
              Claude
            </button>
          </div>

          <div className="mobile-header-actions-right">
            <button
              className={`mobile-header-btn-modern ${mobileView === 'preview' ? 'active' : ''}`}
              onClick={() => onViewChange?.('preview')}
              aria-label="Preview"
              title="Preview"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
            </button>

            <Dropdown
              trigger={
                <button className="mobile-header-btn-modern" type="button" aria-label="Tools">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </button>
              }
              items={toolsItems}
              align="right"
            />

            <button
              className={`mobile-header-btn-modern ${keybarOpen ? 'active' : ''}`}
              onClick={onToggleKeybar}
              aria-label="Keyboard"
              title="Keyboard"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Second row for tabs - only in terminal mode */}
        {(mobileView === 'terminal' || mobileView === 'preview') && (
          <div className="mobile-header-tabs-row">
            <div className="mobile-header-tabs-modern" ref={tabsRef}>
              {activeSessions.map((session) => (
                <MobileTab
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  onSelect={onSelectSession}
                  onLongPress={handleTabLongPress}
                  isRenaming={renamingSessionId === session.id}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameSubmit={handleRenameSubmit}
                  onRenameKeyDown={handleRenameKeyDown}
                  inputRef={renameInputRef}
                />
              ))}
              <button
                type="button"
                className="mobile-header-tab-add"
                onClick={onCreateSession}
                aria-label="New terminal"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <style jsx>{`
          .mobile-header-modern {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: var(--bg-primary, #09090b);
            border-bottom: 1px solid var(--border-default, #3f3f46);
            display: flex;
            flex-direction: column;
            z-index: 2000;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            /* Remove backdrop-filter as it causes z-index context issues on some browsers */
            /* backdrop-filter: blur(12px); */
          }

          .mobile-header-modern.nav-collapsed {
            transform: translateY(-100%);
          }

          .mobile-header-top-row {
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 8px;
          }

          .mobile-mode-toggle {
            display: flex;
            background: var(--bg-surface, #18181b);
            padding: 2px;
            border-radius: 8px;
            border: 1px solid var(--border-subtle, #27272a);
          }

          .mode-btn {
            padding: 4px 12px;
            border-radius: 6px;
            border: none;
            background: transparent;
            color: var(--text-secondary, #a1a1aa);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }

          .mode-btn.active {
            background: var(--bg-elevated, #27272a);
            color: var(--accent-primary, #f59e0b);
            box-shadow: var(--shadow-sm);
          }

          .mobile-header-btn-modern {
            width: 36px;
            height: 36px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: transparent;
            border: none;
            color: var(--text-secondary, #a1a1aa);
            border-radius: 8px;
            transition: all 0.2s ease;
          }

          .mobile-header-btn-modern.active {
            color: var(--accent-primary, #f59e0b);
            background: var(--accent-primary-dim);
          }

          .mobile-header-actions-right {
            display: flex;
            gap: 4px;
          }

          .mobile-header-tabs-row {
            height: 36px;
            border-top: 1px solid var(--border-subtle, #27272a);
            display: flex;
            align-items: center;
            padding: 0 4px;
            background: rgba(0, 0, 0, 0.2);
          }

          .mobile-header-tabs-modern {
            flex: 1;
            display: flex;
            align-items: center;
            overflow-x: auto;
            scrollbar-width: none;
            gap: 6px;
            padding: 0 4px;
          }

          .mobile-header-tabs-modern::-webkit-scrollbar {
            display: none;
          }

          :global(.mobile-header-tab) {
            flex-shrink: 0;
            height: 26px;
            padding: 0 10px;
            background: var(--bg-surface, #18181b);
            border: 1px solid var(--border-subtle, #27272a);
            border-radius: 13px;
            color: var(--text-secondary, #a1a1aa);
            font-size: 11px;
            font-weight: 600;
            white-space: nowrap;
            max-width: 100px;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: all 0.2s ease;
          }

          :global(.mobile-header-tab.active) {
            background: var(--accent-primary-dim);
            border-color: var(--accent-primary, #f59e0b);
            color: var(--accent-primary, #f59e0b);
            box-shadow: 0 0 10px var(--accent-primary-dim);
          }

          .mobile-header-tab-add {
            flex-shrink: 0;
            width: 26px;
            height: 26px;
            border-radius: 50%;
            background: var(--bg-elevated, #27272a);
            border: 1px solid var(--border-default, #3f3f46);
            color: var(--text-muted, #71717a);
            display: flex;
            align-items: center;
            justify-content: center;
          }

          :global(.mobile-header-tab-input) {
            height: 26px;
            background: var(--bg-primary, #09090b);
            border: 1px solid var(--accent-primary, #f59e0b);
            border-radius: 13px;
            color: var(--text-primary, #fafafa);
            padding: 0 10px;
            font-size: 11px;
            width: 90px;
            outline: none;
          }
        `}</style>
      </header>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
        onOpenBrowserSettings={onOpenBrowserSettings}
        onOpenBookmarks={onOpenBookmarks}
        projects={projects}
        projectsLoading={projectsLoading}
        onFolderSelect={onFolderSelect}
        currentPath={currentPath}
        onAddScanFolder={onAddScanFolder}
        onNavigateToPath={onNavigateToPath}
        mobileView={mobileView}
        onViewChange={onViewChange}
        previewUrl={previewUrl}
        inactiveSessions={inactiveSessions}
        onRestoreSession={onRestoreSession}
      />

      {tabContextMenu && (
        <ContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          items={[
            {
              label: 'Rename',
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              ),
              onClick: () => handleStartRename(tabContextMenu.sessionId)
            },
            { separator: true },
            {
              label: 'Close',
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ),
              onClick: () => handleCloseFromMenu(tabContextMenu.sessionId),
              danger: true
            }
          ]}
          onClose={() => setTabContextMenu(null)}
        />
      )}
    </>
  );
}
