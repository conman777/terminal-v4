import { MobileHeader } from './MobileHeader';
import { DesktopSwitcher } from './DesktopSwitcher';
import { SessionTabBar } from './SessionTabBar';

function getPathParts(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    return {
      parentPath: '~/workspace',
      currentName: 'term-v4'
    };
  }

  const normalized = cwd.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return {
      parentPath: normalized,
      currentName: normalized
    };
  }

  const currentName = segments[segments.length - 1];
  const parentSegments = segments.slice(0, -1);

  if (parentSegments.length === 0) {
    return {
      parentPath: normalized,
      currentName
    };
  }

  const drivePrefix = /^[A-Za-z]:$/.test(parentSegments[0]) ? `${parentSegments[0]}/` : '';
  const visibleTail = parentSegments.slice(-2).join('/');
  return {
    parentPath: `${drivePrefix}${visibleTail}`,
    currentName
  };
}

function TitlebarAction({ ariaLabel, active = false, toggleable = true, onClick, children }) {
  return (
    <button
      type="button"
      className={`desktop-titlebar-action${active ? ' active' : ''}`}
      aria-label={ariaLabel}
      aria-pressed={toggleable ? active : undefined}
      title={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Header({
  isMobile,
  sessionProps,
  modalProps,
  projectInfo,
  isSidebarCollapsed,
  onToggleSidebar,
  showPreview,
  onTogglePreview,
  showFileManager,
  onToggleFileManager,
  desktopOnOpenSettings,
  desktopSwitcherProps,
  // Mobile specific props
  mobileProps,
}) {
  // Destructure grouped props
  const {
    activeSessions, inactiveSessions, activeSessionId,
    orderedSessions = activeSessions,
    onSelectSession, onRestoreSession, onCreateSession, onCloseSession, onRenameSession,
    onReorderSessions,
    sessionActivity, sessionsGroupedByProject, showTabStatusLabels,
    sessionAiTypes, onSetSessionAiType,
  } = sessionProps;

  const {
    setShowApiSettings, onOpenSettings,
    setShowBookmarks, setShowNotes, setShowProcessManager,
  } = modalProps;

  // Mobile-only props (may be undefined on desktop)
  const {
    isNavCollapsed, onToggleKeybar, keybarOpen,
    projects, projectsLoading, onFolderSelect, currentPath, onAddScanFolder,
    mobileView, onViewChange, previewUrl, onNavigateToPath,
    chatMode, onToggleChatMode,
  } = mobileProps || {};

  if (!isMobile) {
    const { parentPath, currentName } = getPathParts(projectInfo?.cwd);

    return (
      <header className="desktop-header">
        <div className="desktop-titlebar">
          <div className="desktop-titlebar-traffic" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>

          <div className="desktop-titlebar-path" title={projectInfo?.cwd || 'Workspace'}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="desktop-titlebar-path-parent">{parentPath}</span>
            <span className="desktop-titlebar-path-sep">/</span>
            <span className="desktop-titlebar-path-current">{currentName}</span>
            {projectInfo?.gitBranch ? (
              <>
                <span className="desktop-titlebar-path-sep">.</span>
                <span className="desktop-titlebar-branch">{projectInfo.gitBranch}</span>
              </>
            ) : null}
          </div>

          <div className="desktop-titlebar-actions">
            <TitlebarAction
              ariaLabel={isSidebarCollapsed ? 'Show threads' : 'Hide threads'}
              active={!isSidebarCollapsed}
              onClick={onToggleSidebar}
            >
              threads
            </TitlebarAction>
            <TitlebarAction
              ariaLabel={showFileManager ? 'Hide files' : 'Show files'}
              active={showFileManager}
              onClick={onToggleFileManager}
            >
              files
            </TitlebarAction>
            <TitlebarAction
              ariaLabel={showPreview ? 'Hide preview' : 'Show preview'}
              active={showPreview}
              onClick={onTogglePreview}
            >
              preview
            </TitlebarAction>
            <TitlebarAction ariaLabel="Open settings" toggleable={false} onClick={desktopOnOpenSettings}>
              settings
            </TitlebarAction>
          </div>
        </div>

        <div className="desktop-workbench-bar">
          <DesktopSwitcher {...desktopSwitcherProps} variant="header" />
          <div className="desktop-workbench-tabs">
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
        </div>
      </header>
    );
  }

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
      projectInfo={projectInfo}
      pathParts={getPathParts(projectInfo?.cwd)}
    />
  );
}

export { getPathParts };
