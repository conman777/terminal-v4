import { useCallback, useEffect, useState, useRef, useMemo, lazy, Suspense } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { TerminalMicButton } from './components/TerminalMicButton';
import { SplitPaneContainer } from './components/SplitPaneContainer';
import { MobileHeader } from './components/MobileHeader';
import { MobileKeybar } from './components/MobileKeybar';
import { SessionTabBar } from './components/SessionTabBar';
import { SessionSelector } from './components/SessionSelector';
const ClaudeCodePanel = lazy(() => import('./components/ClaudeCodePanel'));
import ClaudeCodeSessionSelector from './components/ClaudeCodeSessionSelector';
import Sidebar from './components/Sidebar';
import { MobileTerminalCarousel } from './components/MobileTerminalCarousel';
import LoginPage from './components/LoginPage';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TerminalSessionProvider, useTerminalSession } from './contexts/TerminalSessionContext';
import { PaneLayoutProvider, usePaneLayout } from './contexts/PaneLayoutContext';
import { ClaudeCodeProvider, useClaudeCode } from './contexts/ClaudeCodeContext';
import { PreviewProvider, usePreview } from './contexts/PreviewContext';
import { useMobileDetect } from './hooks/useMobileDetect';
import { useViewportHeight } from './hooks/useViewportHeight';
import { useScrollDirection } from './hooks/useScrollDirection';
import { useSessionActivity } from './hooks/useSessionActivity';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { apiFetch } from './utils/api';

const PreviewPanel = lazy(() => import('./components/PreviewPanel').then((module) => ({ default: module.PreviewPanel })));
const FileManager = lazy(() => import('./components/FileManager').then((module) => ({ default: module.FileManager })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })));
const BookmarkModal = lazy(() => import('./components/BookmarkModal').then((module) => ({ default: module.BookmarkModal })));
const NotesModal = lazy(() => import('./components/NotesModal').then((module) => ({ default: module.NotesModal })));
const ApiSettingsModal = lazy(() => import('./components/ApiSettingsModal'));
const BrowserSettingsModal = lazy(() => import('./components/BrowserSettingsModal').then((module) => ({ default: module.BrowserSettingsModal })));
const ProcessManagerModal = lazy(() => import('./components/ProcessManagerModal').then((module) => ({ default: module.ProcessManagerModal })));

function AppContent() {
  const { logout, user } = useAuth();

  // Context hooks
  const {
    sessions,
    activeSessionId,
    activeSessions,
    inactiveSessions,
    loadingSessions,
    sessionLoadError,
    restoringSessionId,
    projectInfo,
    createSession,
    selectSession,
    restoreSession,
    renameSession,
    closeSession,
    navigateSession,
    retryLoadSessions,
    recentFolders,
    pinnedFolders,
    addRecentFolder,
    pinFolder,
    unpinFolder,
    projects,
    projectsLoading,
    handleAddScanFolder,
    bookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    executeBookmark,
    notes,
    addNote,
    updateNote,
    deleteNote
  } = useTerminalSession();

  const {
    paneLayout,
    fullscreenPaneId,
    splitPosition,
    isDragging,
    initializePaneWithSession,
    setPaneSession,
    focusPane,
    splitPane,
    closePane,
    toggleFullscreen,
    exitFullscreen,
    startDragging,
    updateSplitPosition,
    stopDragging,
    setIsDragging
  } = usePaneLayout();

  const {
    leftPanelMode,
    claudeCodeSessions,
    activeClaudeCodeId,
    setLeftPanelMode,
    startClaudeCode,
    selectClaudeCode,
    deleteClaudeCode
  } = useClaudeCode();

  const {
    previewUrl,
    showPreview,
    previewMode,
    pipPosition,
    pipSize,
    handleUrlDetected,
    handlePreviewClose,
    handlePreviewUrlChange,
    togglePreview,
    setShowPreview
  } = usePreview();

  // Local UI state (not shared across components)
  const [showSettings, setShowSettings] = useState(false);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [showBrowserSettings, setShowBrowserSettings] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showProcessManager, setShowProcessManager] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const [keybarHeight, setKeybarHeight] = useState(0);
  const [mobileView, setMobileView] = useState('terminal');
  const [mobileTerminalIndex, setMobileTerminalIndex] = useState(0);
  const [mainTerminalMinimized, setMainTerminalMinimized] = useState(() => {
    try {
      return localStorage.getItem('mainTerminalMinimized') === 'true';
    } catch {
      return false;
    }
  });

  const mainContentRef = useRef(null);
  const focusTerminalRef = useRef(null);
  const isMobile = useMobileDetect();
  const viewportHeight = useViewportHeight();
  const { isCollapsed: isNavCollapsed, handleScroll: handleScrollDirection, reset: resetScrollDirection } = useScrollDirection();

  // Wrap scroll handler to prevent header collapse when keybar is open
  const handleScrollDirectionSafe = useCallback((direction) => {
    // Don't collapse header when keybar is open - user needs access to header controls
    if (keybarOpen) {
      return;
    }
    handleScrollDirection(direction);
  }, [keybarOpen, handleScrollDirection]);

  // Toggle keybar and reset header collapse when opening
  const handleToggleKeybar = useCallback(() => {
    const willOpen = !keybarOpen;
    setKeybarOpen(willOpen);
    // When opening keybar, ensure header is visible and focus terminal
    if (willOpen) {
      resetScrollDirection();
      // Focus terminal immediately - iOS requires this in same call stack as user tap
      if (focusTerminalRef.current) {
        focusTerminalRef.current();
      }
    }
  }, [keybarOpen, resetScrollDirection]);

  // Register focus terminal callback from MobileTerminalCarousel
  const handleRegisterFocusTerminal = useCallback((focusFn) => {
    focusTerminalRef.current = focusFn;
  }, []);

  // Session activity tracking for unread indicators
  const {
    activity: sessionActivity,
    markActivity,
    setFocusedSession,
    removeSession: removeSessionActivity
  } = useSessionActivity();

  // Reset header collapse when switching mobile views
  useEffect(() => {
    resetScrollDirection();
  }, [mobileView, resetScrollDirection]);

  // Settings loaded from server (with localStorage fallback)
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Sidebar collapsed state (synced with server)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Terminal font size (synced with server)
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    try {
      const stored = localStorage.getItem('terminalFontSize');
      if (stored) return parseInt(stored, 10);
      return isMobile ? 20 : 14;
    } catch {
      return isMobile ? 20 : 14;
    }
  });

  // Fetch settings from server on mount
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await apiFetch('/api/settings');
        if (response.ok) {
          const data = await response.json();
          // Apply server settings if they exist
          if (data.terminalFontSize !== null) {
            setTerminalFontSize(data.terminalFontSize);
            try {
              localStorage.setItem('terminalFontSize', String(data.terminalFontSize));
            } catch { /* ignore */ }
          }
          if (data.sidebarCollapsed !== null && data.sidebarCollapsed !== undefined) {
            setSidebarCollapsed(data.sidebarCollapsed);
            try {
              localStorage.setItem('sidebarCollapsed', String(data.sidebarCollapsed));
            } catch { /* ignore */ }
          }
        }
      } catch (e) {
        console.error('Failed to fetch settings from server:', e);
      } finally {
        setSettingsLoaded(true);
      }
    };
    fetchSettings();
  }, []);

  const updateTerminalFontSize = useCallback((size) => {
    setTerminalFontSize(size);
    // Save to localStorage for immediate use
    try {
      localStorage.setItem('terminalFontSize', String(size));
    } catch (e) {
      console.error('Failed to save terminal font size to localStorage', e);
    }
    // Save to server for persistence across devices/sessions
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalFontSize: size })
    }).catch(e => console.error('Failed to save terminal font size to server', e));
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const newValue = !prev;
      // Save to localStorage for immediate use
      try {
        localStorage.setItem('sidebarCollapsed', String(newValue));
      } catch (e) {
        console.error('Failed to save sidebar state to localStorage', e);
      }
      // Save to server for persistence across devices/sessions
      apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sidebarCollapsed: newValue })
      }).catch(e => console.error('Failed to save sidebar state to server', e));
      return newValue;
    });
  }, []);

  // Initialize first pane with active session
  useEffect(() => {
    if (activeSessionId) {
      initializePaneWithSession(activeSessionId);
    }
  }, [activeSessionId, initializePaneWithSession]);

  // Handlers that wrap context functions with local logic
  const handleSelectSession = useCallback((sessionId) => {
    selectSession(sessionId);
    setShowPreview(false);
  }, [selectSession, setShowPreview]);

  const handleRestoreSession = useCallback(async (sessionId) => {
    await restoreSession(sessionId);
    setShowPreview(false);
  }, [restoreSession, setShowPreview]);

  const handlePaneSessionSelect = useCallback((paneId, sessionId) => {
    const newSessionId = setPaneSession(paneId, sessionId);
    if (newSessionId) {
      selectSession(newSessionId);
    }
  }, [setPaneSession, selectSession]);

  const handlePaneFocus = useCallback((paneId) => {
    const sessionId = focusPane(paneId);
    if (sessionId) {
      selectSession(sessionId);
    }
  }, [focusPane, selectSession]);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleSidebarFolderSelect = useCallback((path) => {
    if (!path) return;
    if (activeSessionId) {
      navigateSession(activeSessionId, path);
    } else {
      addRecentFolder(path);
    }
  }, [activeSessionId, navigateSession, addRecentFolder]);

  const handleKeybarHeightChange = useCallback((height) => {
    setKeybarHeight(Math.max(0, Math.round(height)));
  }, []);

  // Keyboard shortcuts (desktop only)
  useKeyboardShortcuts({
    onToggleSidebar: toggleSidebar,
    onTogglePreview: togglePreview,
    onToggleFullScreen: () => {
      const activePaneId = paneLayout.activePaneId;
      if (activePaneId) {
        toggleFullscreen(activePaneId);
      }
    },
    onFocusPane: (index) => {
      if (paneLayout.panes[index]) {
        handlePaneFocus(paneLayout.panes[index].id);
      }
    },
    onNewTerminal: createSession,
    onCloseTerminal: () => {
      if (activeSessionId) {
        closeSession(activeSessionId);
      }
    },
    onExitFullScreen: exitFullscreen,
    isFullScreen: !!fullscreenPaneId,
    paneCount: paneLayout.panes.length,
    enabled: !isMobile
  });

  const handleStartProject = useCallback(async (command) => {
    if (!activeSessionId || !command) return;

    try {
      await apiFetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command + '\r' })
      });
    } catch (error) {
      console.error('Failed to run command', error);
    }
  }, [activeSessionId]);

  // Send text to terminal from preview inspector
  const handleSendToTerminal = useCallback(async (text) => {
    if (!activeSessionId || !text) return;

    try {
      await apiFetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text })
      });
    } catch (error) {
      console.error('Failed to send to terminal', error);
    }
  }, [activeSessionId]);

  // Send element context to Claude Code from preview inspector
  const handleSendToClaudeCode = useCallback(async (context) => {
    if (!context) return;

    // If no active Claude Code session, start one
    let sessionId = activeClaudeCodeId;
    if (!sessionId) {
      try {
        const session = await startClaudeCode();
        sessionId = session.id;
      } catch (error) {
        console.error('Failed to start Claude Code session:', error);
        return;
      }
    }

    // Switch to Claude Code panel
    setLeftPanelMode('claude-code');

    // Send the context as input
    try {
      const command = context.endsWith('\n') || context.endsWith('\r')
        ? context
        : `${context}\r`;
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
    } catch (error) {
      console.error('Failed to send to Claude Code:', error);
    }
  }, [activeClaudeCodeId, startClaudeCode, setLeftPanelMode]);

  const handleNavigateToPath = useCallback(async (path) => {
    if (!activeSessionId || !path) return;

    try {
      // Send cd command to terminal
      const cdCommand = `cd "${path}"\r`;
      await apiFetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cdCommand })
      });
    } catch (error) {
      console.error('Failed to navigate to path', error);
    }
  }, [activeSessionId]);

  // Handle mobile terminal carousel index change - sync with activeSessionId
  const handleMobileTerminalIndexChange = useCallback((newIndex) => {
    setMobileTerminalIndex(newIndex);
    // Update activeSessionId to match the carousel selection
    if (activeSessions[newIndex]) {
      selectSession(activeSessions[newIndex].id);
    }
  }, [activeSessions, selectSession]);

  // Sync carousel index when activeSessionId changes (e.g., from header dropdown)
  useEffect(() => {
    if (!activeSessionId) return;
    const index = activeSessions.findIndex(s => s.id === activeSessionId);
    if (index !== -1 && index !== mobileTerminalIndex) {
      setMobileTerminalIndex(index);
    }
  }, [activeSessionId, activeSessions, mobileTerminalIndex]);

  // Split handle drag handlers
  const handleSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    startDragging(e);
  }, [startDragging]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      if (!mainContentRef.current) return;
      const rect = mainContentRef.current.getBoundingClientRect();
      const newPosition = ((e.clientX - rect.left) / rect.width) * 100;
      updateSplitPosition(newPosition);
    };

    const handleMouseUp = () => {
      stopDragging();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, updateSplitPosition, stopDragging]);

  // Handler to toggle main terminal minimized state
  const handleToggleMainTerminal = useCallback(() => {
    setMainTerminalMinimized(prev => {
      const newValue = !prev;
      try {
        localStorage.setItem('mainTerminalMinimized', String(newValue));
      } catch {
        // Ignore localStorage errors
      }
      return newValue;
    });
  }, []);

  const mobileKeybarOffset = isMobile && keybarOpen ? keybarHeight : 0;
  const layoutStyle =
    isMobile && viewportHeight
      ? {
          '--mobile-viewport-height': `${Math.round(viewportHeight)}px`
        }
      : undefined;

  return (
    <div className={`layout${isMobile ? ' mobile' : ''}${isNavCollapsed ? ' nav-collapsed' : ''}`} style={layoutStyle}>
      <Suspense fallback={null}>
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          sessionId={activeSessionId}
          sessionTitle={activeSessions.find(s => s.id === activeSessionId)?.title}
          currentCwd={projectInfo?.cwd}
          recentFolders={recentFolders}
          onSave={navigateSession}
          onAddRecentFolder={addRecentFolder}
          terminalFontSize={terminalFontSize}
          onFontSizeChange={updateTerminalFontSize}
        />
        <BookmarkModal
          isOpen={showBookmarks}
          onClose={() => setShowBookmarks(false)}
          bookmarks={bookmarks}
          onAdd={addBookmark}
          onUpdate={updateBookmark}
          onDelete={deleteBookmark}
          onExecute={executeBookmark}
        />
        <NotesModal
          isOpen={showNotes}
          onClose={() => setShowNotes(false)}
          notes={notes}
          onAdd={addNote}
          onUpdate={updateNote}
          onDelete={deleteNote}
        />
        <ApiSettingsModal
          isOpen={showApiSettings}
          onClose={() => setShowApiSettings(false)}
        />
        <BrowserSettingsModal
          isOpen={showBrowserSettings}
          onClose={() => setShowBrowserSettings(false)}
        />
        <ProcessManagerModal
          isOpen={showProcessManager}
          onClose={() => setShowProcessManager(false)}
          projects={projects}
        />
      </Suspense>

      {isMobile && (
        <>
          <MobileHeader
            activeSessions={activeSessions}
            inactiveSessions={inactiveSessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onRestoreSession={handleRestoreSession}
            onCreateSession={createSession}
            onRenameSession={renameSession}
            onCloseSession={closeSession}
            onOpenSettings={handleOpenSettings}
            onOpenApiSettings={() => setShowApiSettings(true)}
            onOpenBrowserSettings={() => setShowBrowserSettings(true)}
            onOpenBookmarks={() => setShowBookmarks(true)}
            keybarOpen={keybarOpen}
            onToggleKeybar={handleToggleKeybar}
            projects={projects}
            projectsLoading={projectsLoading}
            onFolderSelect={handleSidebarFolderSelect}
            currentPath={projectInfo?.cwd}
            onAddScanFolder={handleAddScanFolder}
            mobileView={mobileView}
            onViewChange={setMobileView}
            previewUrl={previewUrl}
            showFileManager={showFileManager}
            onToggleFileManager={() => setShowFileManager(!showFileManager)}
            onNavigateToPath={handleNavigateToPath}
            isNavCollapsed={isNavCollapsed}
          />
          <MobileKeybar
            sessionId={activeSessionId}
            isOpen={keybarOpen}
            onHeightChange={handleKeybarHeightChange}
          />
        </>
      )}

      {/* Desktop layout with sidebar */}
      {!isMobile && (
        <>
          <Sidebar
            isCollapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            recentFolders={recentFolders}
            pinnedFolders={pinnedFolders}
            projects={projects}
            projectsLoading={projectsLoading}
            onFolderSelect={handleSidebarFolderSelect}
            onPinFolder={pinFolder}
            onUnpinFolder={unpinFolder}
            currentPath={projectInfo?.cwd}
            onAddScanFolder={handleAddScanFolder}
          />
          <div className="main-container">
          <header className="app-header">
            <div className="header-left">
              <h1 className="app-title">Terminal</h1>
              <div className="mode-toggle">
                <button
                  className={`mode-btn ${leftPanelMode === 'terminal' ? 'active' : ''}`}
                  onClick={() => setLeftPanelMode('terminal')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Terminal
                </button>
                <button
                  className={`mode-btn ${leftPanelMode === 'claude-code' ? 'active' : ''}`}
                  onClick={() => setLeftPanelMode('claude-code')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                  Claude
                </button>
              </div>
              {leftPanelMode === 'terminal' ? (
                activeSessions.length > 1 ? (
                  <SessionSelector
                    activeSessions={activeSessions}
                    inactiveSessions={inactiveSessions}
                    activeSessionId={activeSessionId}
                    onSelectSession={handleSelectSession}
                    onRestoreSession={handleRestoreSession}
                    onCreateSession={createSession}
                    onCloseSession={closeSession}
                    onRenameSession={renameSession}
                    isLoading={loadingSessions}
                    sessionLoadError={sessionLoadError}
                    onRetryLoad={retryLoadSessions}
                  />
                ) : null
              ) : (
                <ClaudeCodeSessionSelector
                  sessions={claudeCodeSessions}
                  activeId={activeClaudeCodeId}
                  onSelect={selectClaudeCode}
                  onNew={startClaudeCode}
                  onDelete={deleteClaudeCode}
                />
              )}
            </div>
            <div className="header-actions">
              <button
                className="header-btn"
                type="button"
                onClick={() => setShowApiSettings(true)}
                aria-label="API Settings"
                title="API Settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
              </button>
              <button
                className="header-btn"
                type="button"
                onClick={handleOpenSettings}
                aria-label="Settings"
                title="Settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button
                className={`header-btn${showPreview ? ' active' : ''}`}
                type="button"
                onClick={togglePreview}
                aria-label="Toggle Browser"
                title={showPreview ? 'Hide Browser' : 'Show Browser'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                </svg>
              </button>
              <button
                className="header-btn"
                type="button"
                onClick={() => setShowBookmarks(true)}
                aria-label="Bookmarks"
                title="Bookmarks"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <button
                className="header-btn"
                type="button"
                onClick={() => setShowNotes(true)}
                aria-label="Notes"
                title="Notes"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </button>
              <button
                className="header-btn"
                type="button"
                onClick={() => setShowProcessManager(true)}
                aria-label="Process Manager"
                title="Process Manager"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </button>
              <button
                className={`header-btn${showFileManager ? ' active' : ''}`}
                type="button"
                onClick={() => setShowFileManager(!showFileManager)}
                aria-label="File Manager"
                title={showFileManager ? 'Hide Files' : 'Show Files'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <div className="header-user-badge" title={user?.username}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span>{user?.username}</span>
              </div>
              <button
                className="header-btn logout-btn"
                type="button"
                onClick={logout}
                aria-label="Logout"
                title="Logout"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </header>

          {/* Session tab bar - only show in terminal mode */}
          {leftPanelMode === 'terminal' && activeSessions.length > 0 && (
            <SessionTabBar
              sessions={activeSessions}
              activeSessionId={activeSessionId}
              sessionActivity={sessionActivity}
              onSelectSession={handleSelectSession}
              onCreateSession={createSession}
              onCloseSession={closeSession}
              onRenameSession={renameSession}
            />
          )}

          <main
            ref={mainContentRef}
            className={`main-content${showPreview ? ' with-preview' : ''}${isDragging ? ' dragging' : ''}`}
          >
            {/* Left pane - switches between Terminal and Claude Code */}
            <div
              className={`terminal-pane${mainTerminalMinimized && showPreview ? ' minimized' : ''}`}
              style={showPreview && !fullscreenPaneId && !mainTerminalMinimized ? { flex: `0 0 ${splitPosition}%` } : undefined}
            >
              {leftPanelMode === 'terminal' ? (
                activeSessions.length === 0 ? (
                  <div className="empty-state">
                    <h2>Welcome to Terminal</h2>
                    <p>Create a new terminal session to get started.</p>
                    <button className="btn-primary" onClick={createSession}>
                      + New Terminal
                    </button>
                  </div>
                ) : (
                  <SplitPaneContainer
                    layout={paneLayout}
                    sessions={activeSessions}
                    onPaneSessionSelect={handlePaneSessionSelect}
                    onPaneSplit={splitPane}
                    onPaneClose={closePane}
                    onPaneFocus={handlePaneFocus}
                    onPaneFullscreen={toggleFullscreen}
                    fullscreenPaneId={fullscreenPaneId}
                    showPreview={showPreview && !fullscreenPaneId}
                    onMinimizeMainTerminal={handleToggleMainTerminal}
                    keybarOpen={keybarOpen}
                    viewportHeight={viewportHeight}
                    onUrlDetected={handleUrlDetected}
                    fontSize={terminalFontSize}
                    sessionActivity={sessionActivity}
                    projectInfo={projectInfo}
                  />
                )
              ) : (
                !activeClaudeCodeId ? (
                  <div className="empty-state">
                    <h2>Claude Code</h2>
                    <p>Start a Claude Code session to open the interactive CLI.</p>
                    <p className="empty-hint">Use /model inside the CLI to change models.</p>
                    <button className="btn-primary" onClick={startClaudeCode}>
                      + New Session
                    </button>
                  </div>
                ) : (
                  <Suspense fallback={<div className="empty-state"><p>Loading Claude Code...</p></div>}>
                    <ClaudeCodePanel
                      sessionId={activeClaudeCodeId}
                      keybarOpen={keybarOpen}
                      viewportHeight={viewportHeight}
                      onUrlDetected={handleUrlDetected}
                      fontSize={terminalFontSize}
                      usesTmux={sessions.find(s => s.id === activeClaudeCodeId)?.usesTmux}
                    />
                  </Suspense>
                )
              )}
            </div>

            {/* Preview pane - hidden during fullscreen */}
            {showPreview && !fullscreenPaneId && (
              <>
                {!mainTerminalMinimized && (
                  <div
                    className={`split-handle${isDragging ? ' active' : ''}`}
                    onMouseDown={handleSplitMouseDown}
                  />
                )}
                <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                  <PreviewPanel
                    url={previewUrl}
                    onClose={handlePreviewClose}
                    onUrlChange={handlePreviewUrlChange}
                    projectInfo={projectInfo}
                    onStartProject={handleStartProject}
                    onSendToTerminal={handleSendToTerminal}
                    onSendToClaudeCode={handleSendToClaudeCode}
                    activeSessions={activeSessions}
                    activeSessionId={activeSessionId}
                    fontSize={terminalFontSize}
                    onUrlDetected={handlePreviewUrlChange}
                    mainTerminalMinimized={mainTerminalMinimized}
                    onToggleMainTerminal={handleToggleMainTerminal}
                  />
                </Suspense>
              </>
            )}
          </main>

          {/* File Manager Sidebar */}
          {showFileManager && (
            <Suspense fallback={null}>
              <FileManager
                isOpen={showFileManager}
                onClose={() => setShowFileManager(false)}
                onNavigateTerminal={handleNavigateToPath}
              />
            </Suspense>
          )}
        </div>
        </>
      )}

      {/* Mobile layout */}
      {isMobile && (
        <div className="main-pane">
          <main
            className="terminal-main"
            style={{ '--mobile-keybar-offset': `${mobileKeybarOffset}px` }}
          >
            {/* Terminal pane with swipe carousel */}
            {mobileView === 'terminal' && (
              <div className="terminal-pane">
                <MobileTerminalCarousel
                  sessions={activeSessions}
                  currentIndex={mobileTerminalIndex}
                  onIndexChange={handleMobileTerminalIndexChange}
                  keybarOpen={keybarOpen}
                  viewportHeight={viewportHeight}
                  onUrlDetected={handleUrlDetected}
                  fontSize={terminalFontSize}
                  onScrollDirection={handleScrollDirectionSafe}
                  onRegisterFocusTerminal={handleRegisterFocusTerminal}
                />
              </div>
            )}

            {/* Claude Code pane */}
            {mobileView === 'claude' && (
              <div className="claude-code-pane">
                <Suspense fallback={<div className="empty-state"><p>Loading...</p></div>}>
                  <ClaudeCodePanel
                    sessionId={activeClaudeCodeId}
                    keybarOpen={keybarOpen}
                    viewportHeight={viewportHeight}
                    onUrlDetected={handleUrlDetected}
                    fontSize={terminalFontSize}
                    onScrollDirection={handleScrollDirectionSafe}
                    onRegisterFocusTerminal={handleRegisterFocusTerminal}
                    usesTmux={sessions.find(s => s.id === activeClaudeCodeId)?.usesTmux}
                  />
                </Suspense>
              </div>
            )}

            {/* Mobile preview - full screen when active */}
            {mobileView === 'preview' && (
              <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                <PreviewPanel
                  url={previewUrl}
                  onClose={() => setMobileView('terminal')}
                  onUrlChange={handlePreviewUrlChange}
                  projectInfo={projectInfo}
                  onStartProject={handleStartProject}
                  onSendToTerminal={handleSendToTerminal}
                  onSendToClaudeCode={handleSendToClaudeCode}
                  activeSessions={activeSessions}
                  activeSessionId={activeSessionId}
                  fontSize={terminalFontSize}
                  onUrlDetected={handlePreviewUrlChange}
                />
              </Suspense>
            )}
          </main>
        </div>
      )}

      {/* Mobile File Manager - render at root level outside all containers */}
      {isMobile && showFileManager && (
        <>
          <div
            className="file-manager-overlay open"
            onClick={() => setShowFileManager(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,0.6)',
              zIndex: 99998
            }}
          />
          <Suspense fallback={null}>
            <FileManager
              isOpen={showFileManager}
              onClose={() => setShowFileManager(false)}
              onNavigateTerminal={handleNavigateToPath}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-loading">
        <div className="auth-loading-spinner" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <TerminalSessionProvider>
      <PaneLayoutProvider>
        <ClaudeCodeProvider>
          <PreviewProvider>
            <AppContent />
          </PreviewProvider>
        </ClaudeCodeProvider>
      </PaneLayoutProvider>
    </TerminalSessionProvider>
  );
}
