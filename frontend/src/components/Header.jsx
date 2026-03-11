import { MobileHeader } from './MobileHeader';

export function Header({
  isMobile,
  sessionProps,
  modalProps,
  showFileManager,
  onToggleFileManager,
  // Mobile specific props
  mobileProps,
}) {
  if (!isMobile) {
    return null;
  }

  // Destructure grouped props
  const {
    activeSessions, inactiveSessions, activeSessionId,
    onSelectSession, onRestoreSession, onCreateSession, onCloseSession, onRenameSession,
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
