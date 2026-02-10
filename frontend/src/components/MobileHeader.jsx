import { useState, useRef, useEffect, useCallback } from 'react';
import { MobileDrawer } from './MobileDrawer';
import { ContextMenu } from './ContextMenu';
import { Dropdown } from './Dropdown';
import { useLongPress } from '../hooks/useLongPress';
import { MobileViewTabs } from './MobileViewTabs';
import { useTheme } from '../contexts/ThemeContext';

// Separate component for mobile tab to use hooks properly
function MobileTab({
  session,
  isActive,
  isBusy,
  isDone,
  hasUnread,
  onSelect,
  onLongPress,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameKeyDown,
  inputRef
}) {
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

  const tabClasses = [
    'mobile-header-tab',
    isActive && 'active',
    isBusy && 'busy',
    isDone && !isBusy && 'done',
    hasUnread && !isActive && 'unread'
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      className={tabClasses}
      onClick={() => onSelect(session.id)}
      {...longPressHandlers}
    >
      <span className={`mobile-header-tab-status${isBusy ? ' busy' : isDone ? ' done' : ' ready'}`} />
      <span className="mobile-header-tab-label">{session.title || 'Terminal'}</span>
      {hasUnread && !isActive && <span className="mobile-header-tab-unread-dot" aria-hidden="true" />}
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
  onOpenNotes,
  onOpenProcessManager,
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
  isNavCollapsed = false,
  sessionActivity,
  sessionsGroupedByProject
}) {
  const { theme, toggleTheme } = useTheme();
  const [showDrawer, setShowDrawer] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [hasOverflow, setHasOverflow] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(() => mobileView === 'preview' && Boolean(previewUrl));
  const tabsRef = useRef(null);
  const headerRef = useRef(null);
  const renameInputRef = useRef(null);
  const overflowRef = useRef(null);
  const sessionActionsButtonRef = useRef(null);
  // Track user scrolling to prevent auto-scroll interruption
  const userScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef(null);

  // Update --mobile-header-height CSS variable
  useEffect(() => {
    if (!headerRef.current) return;

    const updateHeight = () => {
      if (headerRef.current) {
        const height = Math.round(headerRef.current.getBoundingClientRect().height || headerRef.current.offsetHeight || 0);
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

  // Force a height re-sync when header row composition changes.
  useEffect(() => {
    if (!headerRef.current) return;
    const raf = requestAnimationFrame(() => {
      const height = Math.round(headerRef.current?.getBoundingClientRect().height || 0);
      document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    });
    return () => cancelAnimationFrame(raf);
  }, [mobileView, previewOpened, previewUrl, activeSessions.length, isNavCollapsed]);

  // Check if tabs overflow
  const updateOverflowState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    // Use 2px threshold for Retina displays with subpixel rendering
    const OVERFLOW_THRESHOLD = 2;
    setHasOverflow(el.scrollWidth > el.clientWidth + OVERFLOW_THRESHOLD);
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

  const handleOpenActiveSessionMenu = useCallback(() => {
    if (!activeSessionId) return;
    const rect = sessionActionsButtonRef.current?.getBoundingClientRect();
    const fallbackX = typeof window !== 'undefined' ? window.innerWidth - 12 : 12;
    const fallbackY = typeof window !== 'undefined' ? 56 : 56;
    const x = rect ? Math.round(rect.left + (rect.width / 2)) : fallbackX;
    const y = rect ? Math.round(rect.bottom + 6) : fallbackY;
    setTabContextMenu({ sessionId: activeSessionId, x, y });
  }, [activeSessionId]);

  // Handle user manual scrolling to prevent auto-scroll interruption
  const handleUserScroll = useCallback(() => {
    userScrollingRef.current = true;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false;
    }, 150);
  }, []);

  // Auto-scroll active tab into view (but don't interrupt user scrolling)
  useEffect(() => {
    // Don't auto-scroll if user is actively scrolling tabs manually
    if (userScrollingRef.current) return;

    if (tabsRef.current && activeSessionId) {
      const activeTab = tabsRef.current.querySelector('.mobile-header-tab.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [activeSessionId]);

  // Track when preview is opened
  useEffect(() => {
    if (mobileView === 'preview' && previewUrl) {
      setPreviewOpened(true);
    }
    // Reset when leaving preview mode
    if (mobileView === 'terminal') {
      setPreviewOpened(false);
    }
  }, [mobileView, previewUrl]);

  // Reset preview opened state when preview URL is cleared
  useEffect(() => {
    if (!previewUrl) {
      setPreviewOpened(false);
    }
  }, [previewUrl]);

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
      onClick: onOpenProcessManager
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
      label: 'Notes',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      ),
      onClick: onOpenNotes
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
        className={`mobile-header${isNavCollapsed ? ' nav-collapsed' : ''}${previewOpened ? ' preview-mode' : ''}`}
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

          {previewUrl && previewOpened ? (
            <MobileViewTabs
              mobileView={mobileView}
              onViewChange={onViewChange}
              previewUrl={previewUrl}
            />
          ) : (
            <span className="mobile-header-title">Terminal</span>
          )}

          <div className="mobile-header-actions-right">
            {/* Preview button only when view tabs aren't showing */}
            {!(previewUrl && previewOpened) && (
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
            )}

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
              className="mobile-header-btn-modern"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>

            <button
              className={`mobile-header-btn-modern ${keybarOpen ? 'active' : ''}`}
              onClick={onToggleKeybar}
              aria-label="Keyboard"
              title="Keyboard"
              type="button"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
              </svg>
            </button>
            {activeSessionId && (
              <button
                ref={sessionActionsButtonRef}
                className="mobile-header-btn-modern"
                onClick={handleOpenActiveSessionMenu}
                aria-label="Session actions"
                title="Session actions"
                type="button"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Second row for session tabs - only when not showing view tabs in top row */}
        {(mobileView === 'terminal' || mobileView === 'preview') && !(previewUrl && previewOpened) && (
          <div className="mobile-header-tabs-row">
            <div className="mobile-header-tabs-modern" ref={tabsRef} onScroll={handleUserScroll}>
              {activeSessions.map((session) => (
                <MobileTab
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  isBusy={Boolean(sessionActivity?.[session.id]?.isBusy)}
                  isDone={Boolean(sessionActivity?.[session.id]?.isDone)}
                  hasUnread={Boolean(sessionActivity?.[session.id]?.hasUnread)}
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

      </header>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
        onOpenBrowserSettings={onOpenBrowserSettings}
        onOpenBookmarks={onOpenBookmarks}
        onOpenNotes={onOpenNotes}
        onOpenProcessManager={onOpenProcessManager}
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
        activeSessions={activeSessions}
        activeSessionId={activeSessionId}
        sessionActivity={sessionActivity}
        onSelectSession={onSelectSession}
        sessionsGroupedByProject={sessionsGroupedByProject}
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
