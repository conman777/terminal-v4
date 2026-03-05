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
    chatMode, onToggleChatMode,
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
        chatMode={chatMode}
        onToggleChatMode={onToggleChatMode}
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
      <div className="header-left">
        <span className="header-brand">Terminal V4</span>
      </div>

      <div className="header-tabs-area">
        {orderedSessions.length > 0 ? (
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
        ) : (
          <div className="header-tabs-empty">No active sessions</div>
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
          min-height: 54px;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          column-gap: 14px;
          padding: 0 14px;
          background: linear-gradient(180deg, rgba(20, 28, 44, 0.88), rgba(11, 16, 28, 0.88));
          border-bottom: 1px solid rgba(148, 163, 184, 0.2);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.32);
          backdrop-filter: blur(8px);
          user-select: none;
          z-index: 100;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
          min-width: 0;
        }

        .header-brand {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(226, 232, 240, 0.8);
          white-space: nowrap;
        }

        .header-tabs-area {
          width: 100%;
          min-width: 0;
          overflow: hidden;
        }

        .header-tabs-empty {
          display: flex;
          align-items: center;
          height: 34px;
          padding: 0 12px;
          border-radius: 10px;
          color: rgba(148, 163, 184, 0.88);
          background: rgba(30, 41, 59, 0.45);
          border: 1px solid rgba(148, 163, 184, 0.16);
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
          justify-self: end;
          min-width: max-content;
        }

        .header-btn-modern {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 7px 10px;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(30, 41, 59, 0.34);
          color: rgba(226, 232, 240, 0.9);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-btn-modern span {
          display: inline;
        }

        .header-btn-modern:hover {
          background: rgba(56, 189, 248, 0.2);
          border-color: rgba(56, 189, 248, 0.45);
          color: #e2e8f0;
          transform: translateY(-1px);
        }

        .header-btn-modern:active {
          transform: scale(0.97);
        }

        .header-btn-modern.active {
          color: #22d3ee;
          border-color: rgba(34, 211, 238, 0.55);
          background: rgba(34, 211, 238, 0.18);
        }

        .header-divider {
          display: none;
        }

        .header-user-badge-modern {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 10px 4px 4px;
          border-radius: 20px;
          background: rgba(30, 41, 59, 0.5);
          border: 1px solid rgba(148, 163, 184, 0.2);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .header-user-badge-modern:hover {
          background: rgba(56, 189, 248, 0.2);
          border-color: rgba(56, 189, 248, 0.42);
        }

        .user-avatar {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: linear-gradient(135deg, #38bdf8, #0ea5e9);
          color: #02131d;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 700;
        }

        .username {
          font-size: 12px;
          font-weight: 500;
          color: #e2e8f0;
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .chevron {
          opacity: 0.5;
        }

        .app-header.redesign.preview-active {
          min-height: 44px;
          padding: 0 12px;
        }

        .app-header.redesign.preview-active .app-title {
          font-size: 14px;
        }

        .app-header.redesign.preview-active .header-btn-modern {
          padding: 5px 9px;
          font-size: 12px;
        }

        .app-header.redesign.preview-active .user-avatar {
          width: 22px;
          height: 22px;
          font-size: 10px;
        }

        @media (max-width: 1280px) {
          .header-brand {
            display: none;
          }
        }

        @media (max-width: 1500px) {
          .header-btn-modern span {
            display: none;
          }
        }
      `}</style>
    </header>
  );
}
