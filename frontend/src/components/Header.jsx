import { useState, useRef, useEffect } from 'react';
import { SessionSelector } from './SessionSelector';
import ClaudeCodeSessionSelector from './ClaudeCodeSessionSelector';
import { Dropdown } from './Dropdown';
import { MobileHeader } from './MobileHeader';

export function Header({
  isMobile,
  leftPanelMode,
  setLeftPanelMode,
  activeSessions,
  inactiveSessions,
  activeSessionId,
  onSelectSession,
  onRestoreSession,
  onCreateSession,
  onCloseSession,
  onRenameSession,
  loadingSessions,
  sessionLoadError,
  onRetryLoad,
  claudeCodeSessions,
  activeClaudeCodeId,
  onSelectClaudeCode,
  onNewClaudeCode,
  onDeleteClaudeCode,
  setShowApiSettings,
  onOpenSettings,
  showPreview,
  onTogglePreview,
  setShowBookmarks,
  setShowNotes,
  setShowProcessManager,
  showFileManager,
  onToggleFileManager,
  showSystemResources,
  onToggleSystemResources,
  user,
  logout,
  // Sidebar mode props
  sidebarMode,
  onToggleSidebarMode,
  // Mobile specific props
  isNavCollapsed,
  onToggleKeybar,
  keybarOpen,
  projects,
  projectsLoading,
  onFolderSelect,
  currentPath,
  onAddScanFolder,
  mobileView,
  onViewChange,
  previewUrl,
  onNavigateToPath,
  sessionActivity,
  sessionsGroupedByProject
}) {
  if (isMobile) {
    return (
      <MobileHeader
        activeSessions={activeSessions}
        inactiveSessions={inactiveSessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onRestoreSession={onRestoreSession}
        onCreateSession={onCreateSession}
        onRenameSession={onRenameSession}
        onCloseSession={onCloseSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={() => setShowApiSettings(true)}
        onOpenBrowserSettings={() => {}} // Handle if needed
        onOpenBookmarks={() => setShowBookmarks(true)}
        keybarOpen={keybarOpen}
        onToggleKeybar={onToggleKeybar}
        projects={projects}
        projectsLoading={projectsLoading}
        onFolderSelect={onFolderSelect}
        currentPath={currentPath}
        onAddScanFolder={onAddScanFolder}
        mobileView={mobileView}
        onViewChange={onViewChange}
        previewUrl={previewUrl}
        showFileManager={showFileManager}
        onToggleFileManager={onToggleFileManager}
        onNavigateToPath={onNavigateToPath}
        isNavCollapsed={isNavCollapsed}
        sessionActivity={sessionActivity}
        sessionsGroupedByProject={sessionsGroupedByProject}
      />
    );
  }

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
      onClick: () => setShowProcessManager(true)
    },
    {
      label: 'Bookmarks',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      ),
      onClick: () => setShowBookmarks(true)
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
      onClick: () => setShowNotes(true)
    },
    {
      label: showFileManager ? 'Hide Files' : 'Show Files',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      active: showFileManager,
      onClick: onToggleFileManager
    }
  ];

  const userItems = [
    {
      label: 'Settings',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
      onClick: onOpenSettings
    },
    {
      label: 'API Settings',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
        </svg>
      ),
      onClick: () => setShowApiSettings(true)
    },
    { separator: true },
    {
      label: 'Logout',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
      ),
      danger: true,
      onClick: logout
    }
  ];

  return (
    <header className="app-header redesign">
      <div className="header-left">
        <h1 className="app-title">Terminal</h1>

        {onToggleSidebarMode && (
          <button
            className={`sidebar-mode-toggle ${sidebarMode === 'threads' ? 'threads' : 'explorer'}`}
            onClick={onToggleSidebarMode}
            title={sidebarMode === 'threads' ? 'Switch to Explorer' : 'Switch to Threads'}
            type="button"
          >
            {sidebarMode === 'threads' ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
              </svg>
            )}
          </button>
        )}

        <div className="segmented-control">
          <button
            className={`segmented-btn ${leftPanelMode === 'terminal' ? 'active' : ''}`}
            onClick={() => setLeftPanelMode('terminal')}
            type="button"
          >
            Terminal
          </button>
          <button
            className={`segmented-btn ${leftPanelMode === 'claude-code' ? 'active' : ''}`}
            onClick={() => setLeftPanelMode('claude-code')}
            type="button"
          >
            Claude
          </button>
        </div>

        {leftPanelMode === 'terminal' ? (
          activeSessions.length > 0 && (
            <SessionSelector
              activeSessions={activeSessions}
              inactiveSessions={inactiveSessions}
              activeSessionId={activeSessionId}
              onSelectSession={onSelectSession}
              onRestoreSession={onRestoreSession}
              onCreateSession={onCreateSession}
              onCloseSession={onCloseSession}
              onRenameSession={onRenameSession}
              isLoading={loadingSessions}
              sessionLoadError={sessionLoadError}
              onRetryLoad={onRetryLoad}
            />
          )
        ) : (
          <ClaudeCodeSessionSelector
            sessions={claudeCodeSessions}
            activeId={activeClaudeCodeId}
            onSelect={onSelectClaudeCode}
            onNew={onNewClaudeCode}
            onDelete={onDeleteClaudeCode}
          />
        )}
      </div>

      <div className="header-actions">
        <button
          className={`header-btn-modern ${showPreview ? 'active' : ''}`}
          type="button"
          onClick={onTogglePreview}
          title={showPreview ? 'Hide Browser' : 'Show Browser'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
          <span>Browser</span>
        </button>

        <div className="header-divider" />

        <Dropdown
          trigger={
            <button className="header-btn-modern" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>Tools</span>
              <svg className="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          }
          items={toolsItems}
        />

        <button
          className={`header-btn-modern system-resources-btn${showSystemResources ? ' active' : ''}`}
          onClick={onToggleSystemResources}
          title="System Resources"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        </button>

        <Dropdown
          trigger={
            <div className="header-user-badge-modern">
              <div className="user-avatar">
                {user?.username?.charAt(0).toUpperCase() || 'U'}
              </div>
              <span className="username">{user?.username}</span>
              <svg className="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          }
          items={userItems}
        />
      </div>

      <style jsx>{`
        .app-header.redesign {
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          background: var(--bg-primary, #09090b);
          border-bottom: 1px solid var(--border-default, #3f3f46);
          user-select: none;
          z-index: 100;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 20px;
        }

        .app-title {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
          color: var(--accent-primary, #f59e0b);
          letter-spacing: -0.5px;
          text-transform: uppercase;
        }

        .sidebar-mode-toggle {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-default, #3f3f46);
          border-radius: 6px;
          color: var(--text-muted, #71717a);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .sidebar-mode-toggle:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
          border-color: var(--border-hover, #52525b);
        }

        .sidebar-mode-toggle.threads {
          color: var(--accent-primary, #f59e0b);
        }

        .segmented-control {
          display: flex;
          background: var(--bg-surface, #18181b);
          padding: 3px;
          border-radius: 8px;
          border: 1px solid var(--border-default, #3f3f46);
        }

        .segmented-btn {
          padding: 4px 12px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--text-secondary, #a1a1aa);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .segmented-btn.active {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
          box-shadow: var(--shadow-sm);
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .header-btn-modern {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-secondary, #a1a1aa);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-btn-modern:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .header-btn-modern.active {
          color: var(--accent-primary, #f59e0b);
          background: var(--accent-primary-dim);
          border-color: var(--surface-glass-border);
        }

        .header-divider {
          width: 1px;
          height: 20px;
          background: var(--border-subtle, #27272a);
          margin: 0 4px;
        }

        .header-user-badge-modern {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 4px 8px;
          padding-left: 4px;
          border-radius: 20px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-default, #3f3f46);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-user-badge-modern:hover {
          background: var(--bg-elevated, #27272a);
          border-color: var(--border-hover, #52525b);
        }

        .user-avatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--accent-primary, #f59e0b);
          color: var(--bg-primary, #09090b);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 700;
        }

        .username {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-primary, #fafafa);
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .chevron {
          opacity: 0.5;
        }
      `}</style>
    </header>
  );
}
