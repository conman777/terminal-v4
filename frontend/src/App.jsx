import { useCallback, useEffect, useState, useRef, useMemo, lazy, Suspense } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { TerminalMicButton } from './components/TerminalMicButton';
import { SplitPaneContainer } from './components/SplitPaneContainer';
import { MobileKeybar } from './components/MobileKeybar';
// SessionTabBar is now rendered inside Header
import { FolderBrowserModal } from './components/FolderBrowserModal';
import { Header } from './components/Header';
import Sidebar from './components/Sidebar';
import ThreadsSidebar from './components/ThreadsSidebar';
import { MobileTerminalCarousel } from './components/MobileTerminalCarousel';
import LoginPage from './components/LoginPage';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TerminalSessionProvider, useTerminalSession } from './contexts/TerminalSessionContext';
import { FolderProvider, useFolders } from './contexts/FolderContext';
import { BookmarkProvider, useBookmarks } from './contexts/BookmarkContext';
import { NotesProvider, useNotes } from './contexts/NotesContext';
import { PaneLayoutProvider, usePaneLayout } from './contexts/PaneLayoutContext';
import { PreviewProvider, usePreview } from './contexts/PreviewContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { useMobileDetect } from './hooks/useMobileDetect';
import { useViewportHeight } from './hooks/useViewportHeight';
import { useScrollDirection } from './hooks/useScrollDirection';
import { useSessionActivity } from './hooks/useSessionActivity';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useModalState } from './hooks/useModalState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { apiFetch } from './utils/api';

function isDynamicImportFetchError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('ChunkLoadError') ||
    /Loading chunk [\w-]+ failed/i.test(message)
  );
}

function triggerOneTimeChunkRecovery(chunkName) {
  if (typeof window === 'undefined') return false;
  try {
    const key = `chunk-reload:${chunkName}`;
    const lastAttemptRaw = sessionStorage.getItem(key);
    const lastAttempt = lastAttemptRaw ? Number.parseInt(lastAttemptRaw, 10) : 0;
    const now = Date.now();
    if (Number.isFinite(lastAttempt) && now - lastAttempt < 30000) {
      return false;
    }
    sessionStorage.setItem(key, String(now));
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('__chunk_reload', String(now));
    window.location.replace(nextUrl.toString());
    return true;
  } catch {
    return false;
  }
}

function lazyWithChunkRecovery(importer, chunkName, pickDefault = (module) => module.default ?? module) {
  return lazy(async () => {
    try {
      const module = await importer();
      try {
        sessionStorage.removeItem(`chunk-reload:${chunkName}`);
      } catch {
        // Ignore sessionStorage failures
      }
      return { default: pickDefault(module) };
    } catch (error) {
      if (isDynamicImportFetchError(error) && triggerOneTimeChunkRecovery(chunkName)) {
        // Keep suspense fallback while navigation happens.
        return new Promise(() => {});
      }
      throw error;
    }
  });
}

const PreviewPanel = lazyWithChunkRecovery(
  () => import('./components/PreviewPanel'),
  'PreviewPanel',
  (module) => module.PreviewPanel
);
const FileManager = lazyWithChunkRecovery(
  () => import('./components/FileManager'),
  'FileManager',
  (module) => module.FileManager
);
const SettingsModal = lazyWithChunkRecovery(
  () => import('./components/SettingsModal'),
  'SettingsModal',
  (module) => module.SettingsModal
);
const BookmarkModal = lazyWithChunkRecovery(
  () => import('./components/BookmarkModal'),
  'BookmarkModal',
  (module) => module.BookmarkModal
);
const NotesModal = lazyWithChunkRecovery(
  () => import('./components/NotesModal'),
  'NotesModal',
  (module) => module.NotesModal
);
const ApiSettingsModal = lazyWithChunkRecovery(
  () => import('./components/ApiSettingsModal'),
  'ApiSettingsModal'
);
const BrowserSettingsModal = lazyWithChunkRecovery(
  () => import('./components/BrowserSettingsModal'),
  'BrowserSettingsModal',
  (module) => module.BrowserSettingsModal
);
const ProcessManagerModal = lazyWithChunkRecovery(
  () => import('./components/ProcessManagerModal'),
  'ProcessManagerModal',
  (module) => module.ProcessManagerModal
);
const SystemResourcesView = lazyWithChunkRecovery(
  () => import('./components/SystemResourcesView'),
  'SystemResourcesView',
  (module) => module.SystemResourcesView
);

function AppContent() {
  const { logout, user } = useAuth();
  const { setTheme } = useTheme();

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
    // Thread-related
    sessionsGroupedByProject,
    pinnedSessions,
    archivedSessions,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    updateSessionTopic
  } = useTerminalSession();

  const {
    recentFolders, pinnedFolders, addRecentFolder, pinFolder, unpinFolder,
    projects, projectsLoading, handleAddScanFolder,
  } = useFolders();

  const {
    bookmarks, addBookmark, updateBookmark, deleteBookmark, executeBookmark,
  } = useBookmarks();

  const {
    notes, addNote, updateNote, deleteNote,
  } = useNotes();

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

  // Modal visibility state
  const {
    showSettings, setShowSettings,
    showApiSettings, setShowApiSettings,
    showBrowserSettings, setShowBrowserSettings,
    showBookmarks, setShowBookmarks,
    showNotes, setShowNotes,
    showProcessManager, setShowProcessManager,
    showFileManager, setShowFileManager,
    showSystemResources, setShowSystemResources,
    showNewSessionModal, setShowNewSessionModal,
  } = useModalState();
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

  // Automatically minimize main terminal when browser opens
  useEffect(() => {
    if (showPreview && !mainTerminalMinimized) {
      setMainTerminalMinimized(true);
      try {
        localStorage.setItem('mainTerminalMinimized', 'true');
      } catch {
        // Ignore localStorage errors
      }
    }
  }, [showPreview]); // Only trigger when showPreview changes

  const mainContentRef = useRef(null);
  const focusTerminalRef = useRef(null);
  const isMobile = useMobileDetect();
  const viewportHeight = useViewportHeight();
  const { isCollapsed: isNavCollapsed, handleScroll: handleScrollDirection, reset: resetScrollDirection } = useScrollDirection();
  const terminalFontSizeStorageKey = isMobile ? 'terminalFontSizeMobile' : 'terminalFontSizeDesktop';

  // Handle mobile view change - when switching to terminal, jump to active terminal
  const handleMobileViewChange = useCallback((view) => {
    if (view === 'terminal' && activeSessionId) {
      // When switching to terminal view, jump to the currently active terminal
      const index = activeSessions.findIndex(s => s.id === activeSessionId);
      if (index !== -1) {
        setMobileTerminalIndex(index);
      }
    }
    setMobileView(view);
  }, [activeSessionId, activeSessions]);

  // Wrap scroll handler to prevent header collapse when keybar is open or in preview mode
  const handleScrollDirectionSafe = useCallback((direction) => {
    // Don't collapse header when keybar is open or in preview mode - user needs access to header controls
    if (keybarOpen || mobileView === 'preview') {
      return;
    }
    handleScrollDirection(direction);
  }, [keybarOpen, mobileView, handleScrollDirection]);

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
    setFocusedSession,
    setBusy: setSessionBusy,
    removeSession: removeSessionActivity
  } = useSessionActivity();

  const handleSessionBusyChange = useCallback((sessionId, isBusy) => {
    setSessionBusy(sessionId, isBusy);
  }, [setSessionBusy]);

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return;
    const now = Date.now();
    const busyWindowMs = 8000;

    sessions.forEach((session) => {
      const snapshotTs = Number.isFinite(Date.parse(session.lastActivityAt || ''))
        ? Date.parse(session.lastActivityAt || '')
        : 0;
      // Fallback inference when backend process has not been restarted and
      // does not yet provide `isBusy`.
      const inferredBusy = snapshotTs > 0 && now - snapshotTs <= busyWindowMs;
      const busy = typeof session.isBusy === 'boolean' ? session.isBusy : inferredBusy;

      setSessionBusy(session.id, busy, { lastActivityAt: snapshotTs });
    });
  }, [sessions, setSessionBusy]);

  useEffect(() => {
    const activeIds = new Set((sessions || []).map((session) => session.id));
    Object.keys(sessionActivity || {}).forEach((sessionId) => {
      if (!activeIds.has(sessionId)) {
        removeSessionActivity(sessionId);
      }
    });
  }, [sessions, sessionActivity, removeSessionActivity]);

  // Tab reorder state - stores session IDs in user-defined order
  const [tabOrder, setTabOrder] = useState([]);

  // Keep tabOrder in sync: add new sessions, remove deleted ones
  useEffect(() => {
    const activeIds = new Set(activeSessions.map(s => s.id));
    setTabOrder(prev => {
      const existing = prev.filter(id => activeIds.has(id));
      const newIds = activeSessions.filter(s => !prev.includes(s.id)).map(s => s.id);
      if (newIds.length === 0 && existing.length === prev.length) return prev;
      return [...existing, ...newIds];
    });
  }, [activeSessions]);

  // Ordered sessions respects user drag reorder
  const orderedSessions = useMemo(() => {
    const map = new Map(activeSessions.map(s => [s.id, s]));
    return tabOrder.map(id => map.get(id)).filter(Boolean);
  }, [activeSessions, tabOrder]);

  const handleReorderSessions = useCallback((newOrder) => {
    setTabOrder(newOrder);
  }, []);

  // Reset header collapse when switching mobile views
  useEffect(() => {
    resetScrollDirection();
  }, [mobileView, resetScrollDirection]);

  // Track focused session for recency ordering and unread state
  useEffect(() => {
    if (activeSessionId) {
      setFocusedSession(activeSessionId);
    }
  }, [activeSessionId, setFocusedSession]);

  // Auto-switch back to terminal if preview URL gets cleared while viewing preview
  useEffect(() => {
    if (mobileView === 'preview' && !previewUrl) {
      handleMobileViewChange('terminal');
    }
  }, [mobileView, previewUrl, handleMobileViewChange]);

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

  // Sidebar mode: 'explorer' or 'threads'
  const [sidebarMode, setSidebarMode] = useState(() => {
    try {
      return localStorage.getItem('sidebarMode') || 'threads';
    } catch {
      return 'threads';
    }
  });

  const toggleSidebarMode = useCallback(() => {
    setSidebarMode((prev) => {
      const newMode = prev === 'explorer' ? 'threads' : 'explorer';
      try {
        localStorage.setItem('sidebarMode', newMode);
      } catch {
        // Ignore localStorage errors
      }
      return newMode;
    });
  }, []);

  // Terminal font size (synced with server)
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    try {
      const deviceStored = localStorage.getItem(terminalFontSizeStorageKey);
      if (deviceStored) return parseInt(deviceStored, 10);
      const stored = localStorage.getItem('terminalFontSize');
      if (stored) return parseInt(stored, 10);
      return isMobile ? 16 : 14;
    } catch {
      return isMobile ? 16 : 14;
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
            let hasDeviceOverride = false;
            try {
              hasDeviceOverride = localStorage.getItem(terminalFontSizeStorageKey) !== null;
            } catch {
              hasDeviceOverride = false;
            }

            if (!hasDeviceOverride) {
              setTerminalFontSize(data.terminalFontSize);
              try {
                localStorage.setItem('terminalFontSize', String(data.terminalFontSize));
                localStorage.setItem(terminalFontSizeStorageKey, String(data.terminalFontSize));
              } catch { /* ignore */ }
            }
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
          // Apply server theme if no localStorage override
          if (data.theme) {
            let hasLocalTheme = false;
            try {
              hasLocalTheme = localStorage.getItem('theme') !== null;
            } catch { hasLocalTheme = false; }
            if (!hasLocalTheme) {
              setTheme(data.theme);
            }
          }
        }
      } catch (e) {
        console.error('Failed to fetch settings from server:', e);
      } finally {
        setSettingsLoaded(true);
      }
    };
    fetchSettings();
  }, [terminalFontSizeStorageKey, setTheme]);

  const updateTerminalFontSize = useCallback((size) => {
    setTerminalFontSize(size);
    // Save to localStorage for immediate use
    try {
      localStorage.setItem('terminalFontSize', String(size));
      localStorage.setItem(terminalFontSizeStorageKey, String(size));
    } catch (e) {
      console.error('Failed to save terminal font size to localStorage', e);
    }
    // Save to server for persistence across devices/sessions
    apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalFontSize: size })
    }).catch(e => console.error('Failed to save terminal font size to server', e));
  }, [terminalFontSizeStorageKey]);

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

  // Sync the active pane to show the active session when tabs are clicked
  useEffect(() => {
    if (!activeSessionId) return;
    initializePaneWithSession(activeSessionId);
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

  const handleRequestNewSession = useCallback(() => {
    setShowNewSessionModal(true);
  }, []);

  const handleCloseNewSessionModal = useCallback(() => {
    setShowNewSessionModal(false);
  }, []);

  const handleCreateSessionFromFolder = useCallback((path) => {
    setShowNewSessionModal(false);
    if (!path) return;
    createSession({ cwd: path });
  }, [createSession]);

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
    onNewTerminal: handleRequestNewSession,
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

  // Grouped props for Header
  const headerSessionProps = {
    activeSessions, inactiveSessions, activeSessionId,
    orderedSessions,
    onSelectSession: handleSelectSession, onRestoreSession: handleRestoreSession,
    onCreateSession: handleRequestNewSession, onCloseSession: closeSession, onRenameSession: renameSession,
    onReorderSessions: handleReorderSessions,
    loadingSessions, sessionLoadError, onRetryLoad: retryLoadSessions,
    sessionActivity, sessionsGroupedByProject,
  };

  const headerModalProps = {
    setShowApiSettings, onOpenSettings: handleOpenSettings,
    setShowBookmarks, setShowNotes, setShowProcessManager,
  };

  return (
    <div className={`layout${isMobile ? ' mobile' : ''}${isNavCollapsed ? ' nav-collapsed' : ''}`} style={layoutStyle}>
      <ErrorBoundary name="modals">
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
      </ErrorBoundary>

      <FolderBrowserModal
        isOpen={showNewSessionModal}
        onClose={handleCloseNewSessionModal}
        currentPath={projectInfo?.cwd || recentFolders[0] || ''}
        recentFolders={recentFolders}
        onSelect={handleCreateSessionFromFolder}
      />

      {isMobile && (
        <>
          <Header
            isMobile={true}
            sessionProps={headerSessionProps}
            modalProps={headerModalProps}
            showPreview={showPreview}
            onTogglePreview={togglePreview}
            showFileManager={showFileManager}
            onToggleFileManager={() => setShowFileManager(!showFileManager)}
            showSystemResources={showSystemResources}
            onToggleSystemResources={() => setShowSystemResources(!showSystemResources)}
            user={user}
            logout={logout}
            mobileProps={{
              isNavCollapsed,
              onToggleKeybar: handleToggleKeybar,
              keybarOpen,
              projects,
              projectsLoading,
              onFolderSelect: handleSidebarFolderSelect,
              currentPath: projectInfo?.cwd,
              onAddScanFolder: handleAddScanFolder,
              mobileView,
              onViewChange: handleMobileViewChange,
              previewUrl,
              onNavigateToPath: handleNavigateToPath,
            }}
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
          {sidebarMode === 'threads' ? (
            <ThreadsSidebar
              isCollapsed={sidebarCollapsed}
              onToggle={toggleSidebar}
              sessionsGroupedByProject={sessionsGroupedByProject}
              pinnedSessions={pinnedSessions}
              archivedSessions={archivedSessions}
              activeSessionId={activeSessionId}
              sessionActivity={sessionActivity}
              onSelectSession={handleSelectSession}
              onPinSession={pinSession}
              onUnpinSession={unpinSession}
              onArchiveSession={archiveSession}
              onUnarchiveSession={unarchiveSession}
              onTopicChange={updateSessionTopic}
              onCloseSession={closeSession}
              onCreateSession={handleRequestNewSession}
              sidebarMode={sidebarMode}
              onToggleSidebarMode={toggleSidebarMode}
            />
          ) : (
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
              sidebarMode={sidebarMode}
              onToggleSidebarMode={toggleSidebarMode}
              onCreateSession={handleRequestNewSession}
            />
          )}
          <div className="main-container">
            <Header
              isMobile={false}
              sessionProps={headerSessionProps}
              modalProps={headerModalProps}
              showPreview={showPreview}
              onTogglePreview={togglePreview}
              showFileManager={showFileManager}
              onToggleFileManager={() => setShowFileManager(!showFileManager)}
              showSystemResources={showSystemResources}
              onToggleSystemResources={() => setShowSystemResources(!showSystemResources)}
              user={user}
              logout={logout}
            />

          <main
            ref={mainContentRef}
            className={`main-content${showPreview && !showSystemResources ? ' with-preview' : ''}${isDragging ? ' dragging' : ''}`}
          >
            {/* System Resources View - full width when active */}
            {showSystemResources ? (
              <Suspense fallback={<div className="empty-state"><p>Loading System Resources...</p></div>}>
                <SystemResourcesView />
              </Suspense>
            ) : (
              <>
                <div
                  className={`terminal-pane${mainTerminalMinimized && showPreview ? ' minimized' : ''}`}
                  style={showPreview && !fullscreenPaneId && !mainTerminalMinimized ? { flex: `0 0 ${splitPosition}%` } : undefined}
                >
                  {activeSessions.length === 0 ? (
                    <div className="empty-state">
                      <h2>Welcome to Terminal</h2>
                      <p>Create a new terminal session to get started.</p>
                      <button className="btn-primary" onClick={handleRequestNewSession}>
                        + New Terminal
                      </button>
                    </div>
                  ) : (
                    <ErrorBoundary name="terminal" resetKey={activeSessionId}>
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
                        onSessionBusyChange={handleSessionBusyChange}
                        projectInfo={projectInfo}
                      />
                    </ErrorBoundary>
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
                    <ErrorBoundary name="preview" resetKey={previewUrl}>
                      <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                        <PreviewPanel
                          url={previewUrl}
                          onClose={handlePreviewClose}
                          onUrlChange={handlePreviewUrlChange}
                          projectInfo={projectInfo}
                          onStartProject={handleStartProject}
                          onSendToTerminal={handleSendToTerminal}

                          activeSessions={activeSessions}
                          activeSessionId={activeSessionId}
                          sessionActivity={sessionActivity}
                          onSessionBusyChange={handleSessionBusyChange}
                          fontSize={terminalFontSize}
                          webglEnabled={terminalWebglEnabled}
                          onUrlDetected={handlePreviewUrlChange}
                          mainTerminalMinimized={mainTerminalMinimized}
                          onToggleMainTerminal={handleToggleMainTerminal}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}
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
                  onSessionBusyChange={handleSessionBusyChange}
                />
              </div>
            )}

            {/* Mobile preview - full screen when active */}
            {mobileView === 'preview' && (
              <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                <PreviewPanel
                  url={previewUrl}
                  onClose={() => handleMobileViewChange('terminal')}
                  onUrlChange={handlePreviewUrlChange}
                  projectInfo={projectInfo}
                  onStartProject={handleStartProject}
                  onSendToTerminal={handleSendToTerminal}
                  onSendToClaudeCode={handleSendToClaudeCode}
                  activeSessions={activeSessions}
                  activeSessionId={activeSessionId}
                  sessionActivity={sessionActivity}
                  onSessionBusyChange={handleSessionBusyChange}
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
    <ThemeProvider>
      <NotesProvider>
        <FolderProvider>
          <TerminalSessionProvider>
            <BookmarkProvider>
              <PaneLayoutProvider>
                <PreviewProvider>
                  <AppContent />
                </PreviewProvider>
              </PaneLayoutProvider>
            </BookmarkProvider>
          </TerminalSessionProvider>
        </FolderProvider>
      </NotesProvider>
    </ThemeProvider>
  );
}
