import { useState } from 'react';
import { SessionDropdown } from './SessionDropdown';
import { MobileDrawer } from './MobileDrawer';
import { PathBreadcrumb } from './PathBreadcrumb';

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
  // New props for view switcher and preview
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  showFileManager,
  onToggleFileManager,
  onNavigateToPath,
  // Header collapse on scroll
  isNavCollapsed = false
}) {
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  const activeSession = activeSessions.find((s) => s.id === activeSessionId);
  const sessionName = activeSession?.title || 'No Session';

  return (
    <>
      <header className={`mobile-header${isNavCollapsed ? ' nav-collapsed' : ''}`}>
        <div className="mobile-header-row">
          <button className="mobile-header-btn" onClick={() => setShowDrawer(true)} aria-label="Menu" type="button">
            ☰
          </button>

          <button
            className="mobile-header-session"
            onClick={() => setShowSessionDropdown(true)}
            aria-label="Select session"
            type="button"
          >
            {sessionName} ▾
          </button>

          <div className="mobile-header-actions">
            <button
              className="mobile-header-btn"
              onClick={onToggleKeybar}
              aria-label={keybarOpen ? 'Hide keyboard' : 'Show keyboard'}
              type="button"
            >
              {keybarOpen ? '✕' : '⌨'}
            </button>
            <button className="mobile-header-btn" onClick={onOpenBookmarks} aria-label="Bookmarks" type="button">
              📑
            </button>
          </div>
        </div>

        {/* Second row: breadcrumb and view switcher */}
        <div className="mobile-header-row mobile-header-nav">
          {currentPath ? (
            <div className="mobile-header-breadcrumb">
              <PathBreadcrumb
                cwd={currentPath}
                onNavigate={onNavigateToPath}
              />
            </div>
          ) : (
            <div className="mobile-header-breadcrumb-placeholder" />
          )}

          <div className="mobile-view-switcher">
            <button
              type="button"
              className={`view-switch-btn${mobileView === 'terminal' ? ' active' : ''}`}
              onClick={() => onViewChange?.('terminal')}
            >
              ⚡
            </button>
            <button
              type="button"
              className={`view-switch-btn${mobileView === 'claude' ? ' active' : ''}`}
              onClick={() => onViewChange?.('claude')}
            >
              🤖
            </button>
            {previewUrl && (
              <button
                type="button"
                className={`view-switch-btn${mobileView === 'preview' ? ' active' : ''}`}
                onClick={() => onViewChange?.('preview')}
              >
                👁
              </button>
            )}
            <button
              type="button"
              className={`view-switch-btn${showFileManager ? ' active' : ''}`}
              onClick={onToggleFileManager}
            >
              📁
            </button>
          </div>
        </div>
      </header>

      <SessionDropdown
        isOpen={showSessionDropdown}
        onClose={() => setShowSessionDropdown(false)}
        activeSessions={activeSessions}
        inactiveSessions={inactiveSessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onRestoreSession={onRestoreSession}
        onCreateSession={onCreateSession}
        onRenameSession={onRenameSession}
        onCloseSession={onCloseSession}
      />

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
        projects={projects}
        projectsLoading={projectsLoading}
        onFolderSelect={onFolderSelect}
        currentPath={currentPath}
        onAddScanFolder={onAddScanFolder}
      />
    </>
  );
}
