import { useState, useRef, useEffect } from 'react';
import { SessionTabBar } from './SessionTabBar';
import { Dropdown } from './Dropdown';
import { MobileHeader } from './MobileHeader';
import { useTheme } from '../contexts/ThemeContext';

export function Header({
  isMobile,
  sessionProps,
  modalProps,
  showPreview,
  onTogglePreview,
  showFileManager,
  onToggleFileManager,
  showSystemResources,
  onToggleSystemResources,
  user,
  logout,
  // Mobile specific props
  mobileProps,
}) {
  // Destructure grouped props
  const {
    activeSessions, inactiveSessions, activeSessionId,
    orderedSessions,
    onSelectSession, onRestoreSession, onCreateSession, onCloseSession, onRenameSession,
    onReorderSessions,
    loadingSessions, sessionLoadError, onRetryLoad,
    sessionActivity, sessionsGroupedByProject, showTabStatusLabels,
    sessionAiTypes, onSetSessionAiType,
  } = sessionProps;

  const {
    setShowApiSettings, onOpenSettings,
    setShowBookmarks, setShowNotes, setShowProcessManager,
  } = modalProps;

  const { theme, toggleTheme } = useTheme();

  // Mobile-only props (may be undefined on desktop)
  const {
    isNavCollapsed, onToggleKeybar, keybarOpen,
    projects, projectsLoading, onFolderSelect, currentPath, onAddScanFolder,
    mobileView, onViewChange, previewUrl, onNavigateToPath,
  } = mobileProps || {};
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
        onOpenNotes={() => setShowNotes(true)}
        onOpenProcessManager={() => setShowProcessManager(true)}
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
        showTabStatusLabels={showTabStatusLabels}
        sessionAiTypes={sessionAiTypes}
        onSetSessionAiType={onSetSessionAiType}
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
    <header className={`app-header redesign${showPreview ? ' preview-active' : ''}`}>
      {orderedSessions.length > 0 && (
        <div className="header-tabs-area">
          <SessionTabBar
            sessions={orderedSessions}
            activeSessionId={activeSessionId}
            sessionActivity={sessionActivity}
            onSelectSession={onSelectSession}
            onCreateSession={onCreateSession}
            onCloseSession={onCloseSession}
            onRenameSession={onRenameSession}
            onReorderSessions={onReorderSessions}
            inHeader
            showStatusLabels={showTabStatusLabels}
            sessionAiTypes={sessionAiTypes}
            onSetSessionAiType={onSetSessionAiType}
          />
        </div>
      )}

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

        <button
          className="header-btn-modern"
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
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
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          background: var(--bg-primary, #0a0a0c);
          border-bottom: none;
          box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04), 0 4px 12px rgba(0, 0, 0, 0.2);
          user-select: none;
          z-index: 100;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 20px;
          flex-shrink: 0;
        }

        .header-tabs-area {
          flex: 1;
          min-width: 0;
          overflow: visible;
          margin: 0 12px;
        }

        .app-title {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
          color: var(--accent-primary, #f59e0b);
          letter-spacing: -0.5px;
          text-transform: uppercase;
        }

        .header-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .header-btn-modern {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 6px 8px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--text-muted, #71717a);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-btn-modern span {
          display: none;
        }

        .header-btn-modern:hover {
          background: var(--bg-elevated, #1e1e21);
          color: var(--text-primary, #fafafa);
          transform: translateY(-1px);
        }

        .header-btn-modern:active {
          transform: scale(0.97);
        }

        .header-btn-modern.active {
          color: var(--accent-primary, #f59e0b);
          background: var(--accent-primary-dim);
        }

        .header-divider {
          display: none;
        }

        .header-user-badge-modern {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 3px 8px 3px 3px;
          border-radius: 20px;
          background: var(--bg-surface, #141416);
          border: 1px solid rgba(255, 255, 255, 0.06);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-user-badge-modern:hover {
          background: var(--bg-elevated, #1e1e21);
          border-color: rgba(255, 255, 255, 0.1);
        }

        .user-avatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--accent-primary, #f59e0b);
          color: var(--bg-primary, #0a0a0c);
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

        .app-header.redesign.preview-active {
          height: 36px;
          padding: 0 12px;
        }

        .app-header.redesign.preview-active .app-title {
          font-size: 14px;
        }

        .app-header.redesign.preview-active .header-btn-modern {
          padding: 4px 8px;
          font-size: 12px;
        }

        .app-header.redesign.preview-active .user-avatar {
          width: 22px;
          height: 22px;
          font-size: 10px;
        }
      `}</style>
    </header>
  );
}
