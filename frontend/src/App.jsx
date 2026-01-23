import { useCallback, useEffect, useState, useRef, useMemo, lazy, Suspense } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { TerminalMicButton } from './components/TerminalMicButton';
import { SplitPaneContainer } from './components/SplitPaneContainer';
import { MobileKeybar } from './components/MobileKeybar';
import { SessionTabBar } from './components/SessionTabBar';
const ClaudeCodePanel = lazy(() => import('./components/ClaudeCodePanel'));
import { Header } from './components/Header';
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
    legacyLayout,
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

  const [terminalWebglEnabled, setTerminalWebglEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem('terminalWebglEnabled');
      if (stored !== null) return stored === 'true';
      return true;
    } catch {
      return true;
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
          if (data.terminalWebglEnabled !== null && data.terminalWebglEnabled !== undefined) {
            setTerminalWebglEnabled(data.terminalWebglEnabled);
            try {
              localStorage.setItem('terminalWebglEnabled', String(data.terminalWebglEnabled));
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

  const updateTerminalWebglEnabled = useCallback((enabled) => {
    setTerminalWebglEnabled(enabled);
    try {
      localStorage.setItem('terminalWebglEnabled', String(enabled));
    } catch (e) {
      console.error('Failed to save terminal WebGL setting to localStorage', e);
    }
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalWebglEnabled: enabled })
    }).catch(e => console.error('Failed to save terminal WebGL setting to server', e));
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

  // Initialize pane with active session
  // - In single-pane mode: always sync pane to active session (tab switching)
  // - In multi-pane mode: only initialize if pane has no session yet
  useEffect(() => {
    if (!activeSessionId) return;
    const isSinglePane = legacyLayout.panes.length === 1;
    const activePane = legacyLayout.panes.find(p => p.id === legacyLayout.activePaneId);

    if (isSinglePane) {
      // Single pane: tabs control which session is shown
      initializePaneWithSession(activeSessionId);
    } else if (activePane && !activePane.sessionId) {
      // Multi-pane: only initialize empty panes
      initializePaneWithSession(activeSessionId);
    }
  }, [activeSessionId, initializePaneWithSession, legacyLayout.panes, legacyLayout.activePaneId]);

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
      const activePaneId = legacyLayout.activePaneId;
      if (activePaneId) {
        toggleFullscreen(activePaneId);
      }
    },
    onFocusPane: (index) => {
      if (legacyLayout.panes[index]) {
        handlePaneFocus(legacyLayout.panes[index].id);
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
    paneCount: legacyLayout.panes.length,
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
          terminalWebglEnabled={terminalWebglEnabled}
          onWebglChange={updateTerminalWebglEnabled}
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
          <Header
            isMobile={true}
            leftPanelMode={leftPanelMode}
            setLeftPanelMode={setLeftPanelMode}
            activeSessions={activeSessions}
            inactiveSessions={inactiveSessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onRestoreSession={handleRestoreSession}
            onCreateSession={createSession}
            onCloseSession={closeSession}
            onRenameSession={renameSession}
            loadingSessions={loadingSessions}
            sessionLoadError={sessionLoadError}
            onRetryLoad={retryLoadSessions}
            claudeCodeSessions={claudeCodeSessions}
            activeClaudeCodeId={activeClaudeCodeId}
            onSelectClaudeCode={selectClaudeCode}
            onNewClaudeCode={startClaudeCode}
            onDeleteClaudeCode={deleteClaudeCode}
            setShowApiSettings={setShowApiSettings}
            onOpenSettings={handleOpenSettings}
            showPreview={showPreview}
            onTogglePreview={togglePreview}
            setShowBookmarks={setShowBookmarks}
            setShowNotes={setShowNotes}
            setShowProcessManager={setShowProcessManager}
            showFileManager={showFileManager}
            onToggleFileManager={() => setShowFileManager(!showFileManager)}
            user={user}
            logout={logout}
            // Mobile specific props
            isNavCollapsed={isNavCollapsed}
            onToggleKeybar={handleToggleKeybar}
            keybarOpen={keybarOpen}
            projects={projects}
            projectsLoading={projectsLoading}
            onFolderSelect={handleSidebarFolderSelect}
            currentPath={projectInfo?.cwd}
            onAddScanFolder={handleAddScanFolder}
            mobileView={mobileView}
            onViewChange={setMobileView}
            previewUrl={previewUrl}
            onNavigateToPath={handleNavigateToPath}
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
            <Header
              isMobile={false}
              leftPanelMode={leftPanelMode}
              setLeftPanelMode={setLeftPanelMode}
              activeSessions={activeSessions}
              inactiveSessions={inactiveSessions}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              onRestoreSession={handleRestoreSession}
              onCreateSession={createSession}
              onCloseSession={closeSession}
              onRenameSession={renameSession}
              loadingSessions={loadingSessions}
              sessionLoadError={sessionLoadError}
              onRetryLoad={retryLoadSessions}
              claudeCodeSessions={claudeCodeSessions}
              activeClaudeCodeId={activeClaudeCodeId}
              onSelectClaudeCode={selectClaudeCode}
              onNewClaudeCode={startClaudeCode}
              onDeleteClaudeCode={deleteClaudeCode}
              setShowApiSettings={setShowApiSettings}
              onOpenSettings={handleOpenSettings}
              showPreview={showPreview}
              onTogglePreview={togglePreview}
              setShowBookmarks={setShowBookmarks}
              setShowNotes={setShowNotes}
              setShowProcessManager={setShowProcessManager}
              showFileManager={showFileManager}
              onToggleFileManager={() => setShowFileManager(!showFileManager)}
              user={user}
              logout={logout}
            />

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
                    layout={legacyLayout}
                    paneLayout={paneLayout}
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
                    webglEnabled={terminalWebglEnabled}
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
                      webglEnabled={terminalWebglEnabled}
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
                    webglEnabled={terminalWebglEnabled}
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
                  webglEnabled={terminalWebglEnabled}
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
                    webglEnabled={terminalWebglEnabled}
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
                  webglEnabled={terminalWebglEnabled}
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
