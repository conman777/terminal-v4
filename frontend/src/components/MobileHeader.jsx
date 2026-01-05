import { useState, useRef, useEffect, useCallback } from 'react';
import { MobileDrawer } from './MobileDrawer';
import { ContextMenu } from './ContextMenu';
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
  const tabsRef = useRef(null);
  const renameInputRef = useRef(null);

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

  return (
    <>
      <header className={`mobile-header${isNavCollapsed ? ' nav-collapsed' : ''}`}>
        {/* Menu button */}
        <button
          className="mobile-header-btn"
          onClick={() => setShowDrawer(true)}
          aria-label="Menu"
          type="button"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* Inline session tabs */}
        <div className="mobile-header-tabs" ref={tabsRef}>
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
            className="mobile-header-tab add-tab"
            onClick={onCreateSession}
            aria-label="New terminal"
          >
            +
          </button>
        </div>

        {/* Action buttons */}
        <div className="mobile-header-actions">
          <button
            className="mobile-header-btn"
            onClick={onOpenBookmarks}
            aria-label="Bookmarks"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className="mobile-header-btn"
            onClick={() => onViewChange?.('preview')}
            aria-label="Preview"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            className="mobile-header-btn"
            onClick={onToggleFileManager}
            aria-label="Files"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className="mobile-header-btn"
            onClick={onToggleKeybar}
            aria-label={keybarOpen ? 'Hide keyboard' : 'Show keyboard'}
            type="button"
          >
            {keybarOpen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
                <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
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
