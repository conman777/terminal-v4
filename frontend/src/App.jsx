import { DeviceRelayPanel } from './components/DeviceRelayPanel';
import RemoteDesktopPanel from './components/RemoteDesktopPanel';
import RemoteHostPanel from './components/RemoteHostPanel';
import RemoteTunnelsPanel from './components/RemoteTunnelsPanel';
import { GuestInvitationGate } from './components/GuestInvitationGate';
import { EnvironmentIdentityGate } from './components/EnvironmentIdentityGate';
import { RemoteEnvironmentSwitcher } from './components/RemoteEnvironmentsPanel';
import { getEnvironmentStorage, getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment, setActiveEnvironment, setEnvironmentIdentity } from './utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent } from './utils/auth';
import { shouldInitializeWorkspacePane } from './utils/paneSessionAssignments';
import { resolveAgentSessionLaunch } from './utils/agentLauncher';
import { recordThreadLineage } from './utils/threadLineageApi';
import { reopenWorkspaceSession } from './utils/workspaceNavigation';
import { isStructuredSessionId } from './utils/structuredSessions';
import { busyTransitions, notifyAgent } from './utils/agentNotifications';
import { CommandPalette } from './components/CommandPalette';
import { FindInThread } from './components/FindInThread';
import { ScreenshotGallery } from './components/ScreenshotGallery';
import { formatBinding, loadBindings } from './utils/keybindings';
import { isCompanionSession } from './utils/sidebarSessionScope';
import { projectNameFromPath } from './utils/projectBadge';
import { useCallback, useEffect, useState, useRef, useMemo, lazy, Suspense, useSyncExternalStore } from 'react';
import { TerminalMicButton } from './components/TerminalMicButton';
import { SplitPaneContainer } from './components/SplitPaneContainer';
// SessionTabBar is now rendered inside Header
import { FolderBrowserModal } from './components/FolderBrowserModal';
import { AddScanFolderModal } from './components/AddScanFolderModal';
import { FileManager } from './components/FileManager';
import ThreadsSidebar from './components/ThreadsSidebar';
import { MobileHeader } from './components/MobileHeader';
import { MobileShell } from './components/MobileShell';
import { WorkspaceStartView } from './components/WorkspaceStartView';
import { WorkspaceToolsButton } from './components/WorkspaceToolsButton';
import { WorkspaceProfileButton } from './components/WorkspaceProfileButton';
import OwnershipRecovery from './components/OwnershipRecovery';
import OwnerCleanupRecovery from './components/OwnerCleanupRecovery';
import { RawInputRecovery } from './components/RawInputRecovery';
import { RawInputPending } from './components/RawInputPending';
import { getComposerDraftStore } from './utils/composerDraftStore';
import { openWorkspaceImageConversation, startWorkspacePrompt } from './utils/workspaceStart';
import { environmentAllows } from './utils/runtimePermissions';
import { MobileKeyboardDebugOverlay } from './components/MobileKeyboardDebugOverlay';
import LoginPage from './components/LoginPage';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { TerminalSessionProvider, useTerminalSession } from './contexts/TerminalSessionContext';
import { FolderProvider, useFolders } from './contexts/FolderContext';
import { BookmarkProvider, useBookmarks } from './contexts/BookmarkContext';
import { NotesProvider, useNotes } from './contexts/NotesContext';
import { PaneLayoutProvider, usePaneLayout } from './contexts/PaneLayoutContext';
import { PreviewProvider, usePreview } from './contexts/PreviewContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AutocorrectProvider } from './contexts/AutocorrectContext';
import { useMobileDetect } from './hooks/useMobileDetect';
import { useMobileInputZoomLock } from './hooks/useMobileInputZoomLock';
import { useViewportMetrics } from './hooks/useViewportHeight';
import { useScrollDirection } from './hooks/useScrollDirection';
import { useSessionActivity } from './hooks/useSessionActivity';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useModalState } from './hooks/useModalState';
import { useBrowserApprovals } from './hooks/useBrowserApprovals';
import { MountOnFirstOpen } from './components/MountOnFirstOpen';
import { ErrorBoundary } from './components/ErrorBoundary';
import './ProTerminalEmpty.css';
import './ProUI.css';
import { WorkspacePanel } from './components/WorkspacePanel';
import './AppSurface.css';
import { apiFetch } from './utils/api';
import {
  createCustomAiProvider,
  getNewTabAiOptions,
  normalizeAiType
} from './utils/aiProviders';
import { isMeaningfulSessionTopic } from './utils/sessionTopic';
import { scopeThreadsSidebarData } from './utils/sidebarSessionScope';
import { persistSidebarProject } from './utils/sidebarProjectPersistence';
import {
  resolveStartupWorkspacePath,
} from './utils/startupWorkspace';
import { resolveTerminalWebglEnabled } from './utils/terminalRendererPolicy';
import { resolveDesktopTerminalInputPreference } from './utils/desktopTypingPreference';

function isDynamicImportFetchError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('ChunkLoadError') ||
    /Loading chunk [\w-]+ failed/i.test(message)
  );
}

function isTextEntryElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return false;
  if (!(target instanceof HTMLInputElement)) return false;

  const nonTextTypes = new Set([
    'button',
    'checkbox',
    'color',
    'file',
    'hidden',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ]);

  return !nonTextTypes.has((target.type || '').toLowerCase());
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

const WorkspaceBrowser = lazyWithChunkRecovery(
  () => import('./components/WorkspaceBrowser'),
  'WorkspaceBrowser',
  (module) => module.default
);
const PreviewPanel = lazyWithChunkRecovery(
  () => import('./components/PreviewPanel'),
  'PreviewPanel',
  (module) => module.PreviewPanel
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

function AppContent({ serverControl }) {
  const [showWorkspaceStart, setShowWorkspaceStart] = useState(false);
  const [workspaceDraftPath, setWorkspaceDraftPath] = useState('');
  const [workspaceResponses, setWorkspaceResponses] = useState(() => new Map());
  const handleWorkspaceResponseChange = useCallback((sessionId, text) => {
    if (sessionId) setWorkspaceResponses(previous => previous.get(sessionId) === text ? previous : new Map(previous).set(sessionId, text));
  }, []);
  const storage = useMemo(() => getEnvironmentStorage(), []);
  const remotePreferences = useMemo(() => Boolean(getActiveEnvironment()), []);
  const { logout, user } = useAuth();
  const { setTheme, toggleTheme } = useTheme();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [findInThreadOpen, setFindInThreadOpen] = useState(false);
  const [findFocusRequest, setFindFocusRequest] = useState(null);
  const [pendingPaneFind, setPendingPaneFind] = useState(null);
  const [showScreenshots, setShowScreenshots] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;

    const applyWindowActiveState = () => {
      const isActive = !document.hidden && document.hasFocus();
      document.documentElement.setAttribute('data-window-active', isActive ? 'true' : 'false');
    };

    applyWindowActiveState();
    window.addEventListener('focus', applyWindowActiveState);
    window.addEventListener('blur', applyWindowActiveState);
    document.addEventListener('visibilitychange', applyWindowActiveState);

    return () => {
      window.removeEventListener('focus', applyWindowActiveState);
      window.removeEventListener('blur', applyWindowActiveState);
      document.removeEventListener('visibilitychange', applyWindowActiveState);
    };
  }, []);

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
    createStructuredSession,
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
    updateThreadMetadata,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    updateSessionTopic,
    generateSessionTopic,
    sendToSession
  } = useTerminalSession();

  const {
    recentFolders, pinnedFolders, addRecentFolder, pinFolder, unpinFolder,
    projects, projectsLoading, addScanFolder,
    sidebarProjects, addSidebarProject, removeSidebarProject,
  } = useFolders();
  useEffect(() => {
    const environment=getActiveEnvironment();
    if (!environment || !projectInfo?.cwd || environment.lastWorkspace === projectInfo.cwd) return;
    const controller=new AbortController();
    const timer=setTimeout(() => {
      apiFetch('/api/environments/'+encodeURIComponent(environment.id), {home:true,method:'PATCH',body:{lastWorkspace:projectInfo.cwd},signal:controller.signal})
        .then(response=>{if (!response.ok) throw new Error('Unable to save recent workspace');})
        .catch(error=>{if(!controller.signal.aborted) console.warn(error.message);});
    },500);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[projectInfo?.cwd]);
  useEffect(() => { setShowWorkspaceStart(false); }, [activeSessionId]);

  const startupWorkspacePath = useMemo(
    () => resolveStartupWorkspacePath(projectInfo?.cwd, recentFolders),
    [projectInfo?.cwd, recentFolders]
  );
  const currentWorkspacePath = projectInfo?.cwd || (!activeSessionId ? startupWorkspacePath : '');

  const {
    bookmarks, addBookmark, updateBookmark, deleteBookmark, executeBookmark,
    bookmarksLoadStatus, bookmarksLoadError, reloadBookmarks, bookmarksScopeKey,
  } = useBookmarks();

  const {
    notes, addNote, updateNote, deleteNote,
    notesLoadStatus, notesLoadError, reloadNotes, notesScopeKey,
  } = useNotes();

  const {
    paneLayout,
    legacyLayout,
    fullscreenPaneId,
    splitPosition,
    isDragging,
    initializePaneWithSession,
    setPaneSession,
    reconcilePaneSessions,
    focusPane,
    splitPane,
    resizeSplit,
    closePane,
    toggleFullscreen,
    exitFullscreen,
    startDragging,
    updateSplitPosition,
    stopDragging,
    setIsDragging,
    desktops,
    activeDesktopId,
    createDesktop,
    switchDesktop,
    deleteDesktop,
    renameDesktop,
    moveSessionToDesktop,
    addSessionToDesktop,
  } = usePaneLayout();
  const historyPaneScope = useRef(null);
  historyPaneScope.current = { desktopId: activeDesktopId, panes: legacyLayout.panes, activePaneId: fullscreenPaneId || legacyLayout.activePaneId, activeSessionId, sessions, showWorkspaceStart };
  const imageStartDesktopRef = useRef({ desktopId: activeDesktopId });
  if (imageStartDesktopRef.current.desktopId !== activeDesktopId) imageStartDesktopRef.current = { desktopId: activeDesktopId };
  const imageStartDesktop = imageStartDesktopRef.current;
  const historyNavigationRequest = useRef(0);
  const historyInteractionCleanup = useRef(null);
  const historyNavigationExpanding = useRef(false);
  const [historyNavigation, setHistoryNavigation] = useState(null);
  const [historyNavigationNotice, setHistoryNavigationNotice] = useState('');
  const cancelHistoryNavigation = useCallback(() => {
    historyNavigationRequest.current += 1;
    historyInteractionCleanup.current?.();
    historyInteractionCleanup.current = null;
    setHistoryNavigation(null);
    setHistoryNavigationNotice('');
  }, []);
  useEffect(() => () => historyInteractionCleanup.current?.(), []);
  const mobileHistoryContentRef = useRef(null);
  const filePaneScope = useRef(null);
  const activeFilePaneId = fullscreenPaneId || legacyLayout.activePaneId;
  filePaneScope.current = { desktopId: activeDesktopId, pane: legacyLayout.panes.find(pane => pane.id === activeFilePaneId) };
  const [filePaneTarget, setFilePaneTarget] = useState(null);
  const filePaneRequest = useRef(0);

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
  const [newSessionLaunchMode, setNewSessionLaunchMode] = useState(undefined);
  const openNewTerminal = useCallback(() => {
    setNewSessionLaunchMode('terminal');
    setShowNewSessionModal(true);
  }, [setShowNewSessionModal]);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const [keybarHeight, setKeybarHeight] = useState(0);
  const [mobileView, setMobileView] = useState('terminal');
  const [mobileThreadTerminal, setMobileThreadTerminal] = useState(null);
  const [chatMode, setChatMode] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const browserOpenerRef = useRef(null);
  const isMobile = useMobileDetect();
  const browserVisible = showBrowser && !showSystemResources && (isMobile || !fullscreenPaneId);
  const browserRequests = useBrowserApprovals(!browserVisible, 2500, 10000);
  const toggleBrowser = () => {
    if (!browserVisible) browserOpenerRef.current = (isMobile && document.querySelector('[aria-label="Menu"]')) || document.activeElement;
    setShowBrowser(!browserVisible);
    setBrowserExpanded(false);
    if (fullscreenPaneId) exitFullscreen();
    setShowSystemResources(false);
    setShowPreview(false);
    setMainTerminalMinimized(false);
  };
  const closeBrowser = () => {
    setShowBrowser(false);
    setBrowserExpanded(false);
    requestAnimationFrame(() => {
      const opener = browserOpenerRef.current;
      if (opener?.isConnected && opener !== document.body && opener !== document.documentElement) opener.focus();
      else document.querySelector('[aria-label="Toggle browser pane"], [aria-label="Browser"], [aria-label="More actions"], [aria-label="Menu"]')?.focus();
    });
  };
  const toggleWorkspacePreview = () => {
    setShowBrowser(false);
    setBrowserExpanded(false);
    togglePreview();
  };
  const [mobileTerminalIndex, setMobileTerminalIndex] = useState(0);
  const [showAddScanFolderModal, setShowAddScanFolderModal] = useState(false);
  const [addScanFolderError, setAddScanFolderError] = useState('');
  const [showAddProjectModal, setShowAddProjectModal] = useState(false);
  const [mainTerminalFitToken, setMainTerminalFitToken] = useState(0);
  const mainTerminalFitRafRef = useRef(null);
  const previewDragRef = useRef(null);
  const [mainTerminalMinimized, setMainTerminalMinimized] = useState(() => {
    try {
      return storage.getItem('mainTerminalMinimized') === 'true';
    } catch {
      return false;
    }
  });

  // Automatically minimize main terminal when browser opens
  useEffect(() => {
    if (showPreview && !mainTerminalMinimized) {
      setMainTerminalMinimized(true);
      try {
        storage.setItem('mainTerminalMinimized', 'true');
      } catch {
        // Ignore localStorage errors
      }
    }
  }, [showPreview]); // Only trigger when showPreview changes

  const mainContentRef = useRef(null);
  const handlePreviewOpenTerminal = useCallback(() => {
    setMobileView('terminal');
    setShowPreview(false);
    setMainTerminalMinimized(false);
    openNewTerminal();
  }, [openNewTerminal, setShowPreview]);
  const resourcesSurfaceRef = useRef(null);
  const workspaceFocusRef = useRef(null);
  const rememberWorkspaceFocus = event => { workspaceFocusRef.current = event.target; };
  const closeSystemResources = () => {
    setShowSystemResources(false);
    requestAnimationFrame(() => {
      const previous = workspaceFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
      else document.querySelector('.app-workspace-surface textarea:not(:disabled), .app-workspace-surface button:not(:disabled)')?.focus();
    });
  };
  useEffect(() => {
    if (showSystemResources) resourcesSurfaceRef.current?.focus();
  }, [showSystemResources]);
  const focusTerminalRef = useRef(null);
  const mobileViewportAtBottomRef = useRef(true);
  const previousActiveSessionRef = useRef(null);
  const [isMobileTextEntryFocused, setIsMobileTextEntryFocused] = useState(false);
  const {
    height: measuredViewportHeight,
    width: viewportWidth,
    offsetTop: viewportOffsetTop,
    offsetLeft: viewportOffsetLeft
  } = useViewportMetrics();
  const touchDesktopViewport = !isMobile && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  const viewportChromeHeight = isMobile || (touchDesktopViewport && viewportOffsetTop > 0) ? 0 : 44;
  const viewportHeight = measuredViewportHeight ? Math.max(0, measuredViewportHeight - viewportChromeHeight) : measuredViewportHeight;
  useMobileInputZoomLock(isMobile && isMobileTextEntryFocused);
  const { isCollapsed: isNavCollapsed, handleScroll: handleScrollDirection, reset: resetScrollDirection } = useScrollDirection();
  const terminalFontSizeStorageKey = isMobile ? 'terminalFontSizeMobile' : 'terminalFontSizeDesktop';

  const activeClaudeSession = useMemo(() => (
    activeSessions.find((session) => {
      const shell = (session?.shell || '').toLowerCase();
      const title = (session?.title || '').toLowerCase();
      return shell === 'claude' || title.includes('claude');
    }) || null
  ), [activeSessions]);
  // Preview's split shows a live shell, so agent chats (which have no terminal) stay out of it.
  const previewTerminalSessions = useMemo(
    () => activeSessions.filter(session => !isStructuredSessionId(session.id)),
    [activeSessions]
  );
  const previewTerminalSessionId = previewTerminalSessions.some(session => session.id === activeSessionId) ? activeSessionId : null;

  // Derive the effective carousel index synchronously to avoid a stale-index render
  // when activeSessions reorders between loadSessions calls.
  const effectiveMobileIndex = useMemo(() => {
    if (activeSessionId) {
      const idx = activeSessions.findIndex(s => s.id === activeSessionId);
      if (idx !== -1) return idx;
    }
    return Math.min(mobileTerminalIndex, Math.max(0, activeSessions.length - 1));
  }, [activeSessionId, activeSessions, mobileTerminalIndex]);

  const mobileVisibleSessionId = useMemo(() => {
    if (!isMobile) return null;
    const session = activeSessions[effectiveMobileIndex];
    return session?.id || null;
  }, [activeSessions, isMobile, effectiveMobileIndex]);

  const mobileKeybarSessionId = useMemo(() => {
    if (!isMobile) return activeSessionId;

    if (mobileView === 'claude') {
      return activeClaudeSession?.id || activeSessionId || mobileVisibleSessionId;
    }
    if (mobileView === 'terminal') {
      return mobileVisibleSessionId || activeSessionId || activeClaudeSession?.id || null;
    }

    return activeSessionId || mobileVisibleSessionId || activeClaudeSession?.id || null;
  }, [
    activeClaudeSession?.id,
    activeSessionId,
    isMobile,
    mobileView,
    mobileVisibleSessionId
  ]);

  // Handle mobile view change - when switching to terminal, jump to active terminal
  const handleMobileViewChange = useCallback((view) => {
    const normalizedView = view === 'preview' || view === 'claude' || view === 'terminal'
      ? view
      : 'terminal';
    if (normalizedView === 'preview' && keybarOpen) {
      setKeybarOpen(false);
    }
    if (normalizedView === 'terminal' && activeSessionId) {
      // When switching to terminal view, jump to the currently active terminal
      const index = activeSessions.findIndex(s => s.id === activeSessionId);
      if (index !== -1) {
        setMobileTerminalIndex(index);
      }
    }
    setMobileView(normalizedView);
  }, [activeSessionId, activeSessions, keybarOpen]);

  const closeMobilePreview = () => {
    const previous = document.activeElement;
    handleMobileViewChange('terminal');
    handlePreviewClose();
    requestAnimationFrame(() => {
      if (document.activeElement === previous || document.activeElement === document.body) {
        document.querySelector('.mobile-header [aria-label="Menu"]')?.focus({ preventScroll: true });
      }
    });
  };

  const handleMobileViewportStateChange = useCallback((atBottom) => {
    mobileViewportAtBottomRef.current = atBottom;
    if (atBottom) {
      resetScrollDirection();
    }
  }, [resetScrollDirection]);

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || typeof document === 'undefined') {
      setIsMobileTextEntryFocused(false);
      return undefined;
    }

    let frameId = null;
    let timeoutId = null;

    const updateFocusedState = () => {
      setIsMobileTextEntryFocused(isTextEntryElement(document.activeElement));
    };

    const scheduleFocusedStateUpdate = () => {
      if (frameId) cancelAnimationFrame(frameId);
      if (timeoutId) clearTimeout(timeoutId);
      frameId = requestAnimationFrame(() => {
        frameId = null;
        updateFocusedState();
      });
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        updateFocusedState();
      }, 30);
    };

    scheduleFocusedStateUpdate();
    window.addEventListener('focusin', scheduleFocusedStateUpdate);
    window.addEventListener('focusout', scheduleFocusedStateUpdate);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener('focusin', scheduleFocusedStateUpdate);
      window.removeEventListener('focusout', scheduleFocusedStateUpdate);
    };
  }, [isMobile]);

  const shouldKeepMobileHeaderVisible = isMobile && (
    keybarOpen
    || mobileView === 'preview'
    || isMobileTextEntryFocused
  );

  useEffect(() => {
    if (shouldKeepMobileHeaderVisible) {
      resetScrollDirection();
    }
  }, [resetScrollDirection, shouldKeepMobileHeaderVisible]);

  // Wrap scroll handler to prevent header collapse when keybar is open or in preview mode
  const handleScrollDirectionSafe = useCallback((direction) => {
    // Don't collapse header when the user is actively entering text or the keybar/preview needs controls visible.
    if (shouldKeepMobileHeaderVisible) {
      return;
    }
    if (mobileViewportAtBottomRef.current && direction === 'down') {
      return;
    }
    handleScrollDirection(direction);
  }, [handleScrollDirection, shouldKeepMobileHeaderVisible]);

  // Toggle keybar and reset header collapse when opening
  const handleToggleKeybar = useCallback(() => {
    if (chatMode) {
      return;
    }
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
  }, [chatMode, keybarOpen, resetScrollDirection]);

  // Register focus terminal callback from MobileTerminalCarousel
  const handleRegisterFocusTerminal = useCallback((focusFn) => {
    focusTerminalRef.current = focusFn;
  }, []);

  // Session activity tracking for unread indicators
  const {
    activity: sessionActivity,
    markActivity: markSessionActivity,
    markUnread: markSessionUnread,
    setFocusedSession,
    setBusy: setSessionBusy,
    removeSession: removeSessionActivity
  } = useSessionActivity();
  const previousActivityRef = useRef({});
  const busySinceRef = useRef({});
  useEffect(() => {
    for (const id of busyTransitions(sessionActivity, previousActivityRef.current, busySinceRef.current)) {
      notifyAgent('finished', sessions.find(session => session.id === id)?.title);
    }
    previousActivityRef.current = sessionActivity;
  }, [sessionActivity, sessions]);


  // Keep a stable ref to sessions so handleSessionBusyChange can read current
  // session data without adding `sessions` to its dependency array.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  // Track which sessions have already had topic generation triggered so we
  // only fire once per session (not on every busy→idle transition).
  const topicGeneratedRef = useRef(new Set());

  const handleSessionBusyChange = useCallback((sessionId, isBusy) => {
    if (isBusy && sessionId && sessionId !== activeSessionId) {
      markSessionActivity(sessionId);
    }
    setSessionBusy(sessionId, Boolean(isBusy), { persistent: isStructuredSessionId(sessionId) });
    // Auto-generate topic once, on the first idle transition, if no topic yet
    if (!isBusy && sessionId && !topicGeneratedRef.current.has(sessionId)) {
      const session = sessionsRef.current?.find((s) => s.id === sessionId);
      if (session && !isMeaningfulSessionTopic(session.thread?.topic)) {
        topicGeneratedRef.current.add(sessionId);
        void generateSessionTopic(sessionId).then((ok) => {
          if (!ok) {
            topicGeneratedRef.current.delete(sessionId);
          }
        });
      }
    }
  }, [activeSessionId, markSessionActivity, setSessionBusy, generateSessionTopic]);

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return;

    sessions.forEach((session) => {
      // Only trust explicit backend busy state to avoid UI color flapping.
      if (typeof session?.isBusy !== 'boolean') {
        return;
      }
      const parsedLastActivity = Date.parse(session.lastActivityAt || '');
      const snapshotTs = Number.isFinite(parsedLastActivity) ? parsedLastActivity : 0;

      setSessionBusy(session.id, session.isBusy, { lastActivityAt: snapshotTs, persistent: isStructuredSessionId(session.id), statusSeq: session.statusSeq });
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

  // On initial load, generate topics for sessions that already have history but no topic.
  const hasInitializedTopicsRef = useRef(false);
  useEffect(() => {
    if (hasInitializedTopicsRef.current) return;
    if (!Array.isArray(sessions) || sessions.length === 0) return;
    hasInitializedTopicsRef.current = true;
    sessions.forEach((session) => {
      if (!isMeaningfulSessionTopic(session.thread?.topic) && !topicGeneratedRef.current.has(session.id)) {
        topicGeneratedRef.current.add(session.id);
        void generateSessionTopic(session.id).then((ok) => {
          if (!ok) {
            topicGeneratedRef.current.delete(session.id);
          }
        });
      }
    });
  }, [sessions, generateSessionTopic]);

  // Per-session AI type mapping, persisted in localStorage for tab color restoration
  const [sessionAiTypes, setSessionAiTypes] = useState(() => {
    try { return JSON.parse(storage.getItem('sessionAiTypes') || '{}'); }
    catch { return {}; }
  });
  const migratedSessionAiTypesRef = useRef(new Set());
  const [customAiProviders, setCustomAiProviders] = useState(() => {
    try { return JSON.parse(storage.getItem('customAiProviders') || '[]'); }
    catch { return []; }
  });

  useEffect(() => {
    if (!Array.isArray(sessions) || sessions.length === 0) return;

    const serverAiTypes = {};
    const localMigrations = [];

    sessions.forEach((session) => {
      const sessionId = session?.id;
      if (!sessionId || String(sessionId).startsWith('ss-')) return;

      const serverAiType = normalizeAiType(session.thread?.aiType);
      const localAiType = normalizeAiType(sessionAiTypes?.[sessionId]);

      if (serverAiType && sessionAiTypes?.[sessionId] !== serverAiType) {
        serverAiTypes[sessionId] = serverAiType;
      }

      if (!serverAiType && localAiType && !migratedSessionAiTypesRef.current.has(sessionId)) {
        localMigrations.push({ sessionId, aiType: localAiType });
      }
    });

    if (Object.keys(serverAiTypes).length > 0) {
      setSessionAiTypes((current) => {
        const next = { ...current, ...serverAiTypes };
        storage.setItem('sessionAiTypes', JSON.stringify(next));
        return next;
      });
    }

    localMigrations.forEach(({ sessionId, aiType }) => {
      migratedSessionAiTypesRef.current.add(sessionId);
      updateThreadMetadata(sessionId, { aiType }).catch(() => {
        migratedSessionAiTypesRef.current.delete(sessionId);
      });
    });
  }, [sessions, sessionAiTypes, updateThreadMetadata]);

  // Tab reorder state - stores session IDs in user-defined order, persisted server-side
  const [tabOrder, setTabOrder] = useState(() => {
    try { const stored = JSON.parse(storage.getItem('tabOrder') || '[]'); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; } catch { return []; }
  });
  const tabOrderSaveRef = useRef(null);

  // Keep tabOrder in sync: add new sessions, remove deleted ones
  useEffect(() => {
    if (loadingSessions || sessionLoadError) return;
    const activeIds = new Set(activeSessions.map(s => s.id));
    setTabOrder(prev => {
      const existing = prev.filter(id => activeIds.has(id));
      const newIds = activeSessions.filter(s => !prev.includes(s.id)).map(s => s.id);
      if (newIds.length === 0 && existing.length === prev.length) return prev;
      return [...existing, ...newIds];
    });
  }, [activeSessions, loadingSessions, sessionLoadError]);

  // Persist tab order to server (debounced to avoid excessive API calls)
  useEffect(() => {
    if (loadingSessions || sessionLoadError) return;
    try { storage.setItem('tabOrder', JSON.stringify(tabOrder)); } catch {}
    if (remotePreferences || tabOrder.length === 0) return;
    clearTimeout(tabOrderSaveRef.current);
    tabOrderSaveRef.current = setTimeout(() => {
      if (!remotePreferences) apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabOrder })
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(tabOrderSaveRef.current);
  }, [tabOrder, loadingSessions, sessionLoadError, remotePreferences, storage]);

  // Ordered sessions respects user drag reorder
  const orderedSessions = useMemo(() => {
    const map = new Map(activeSessions.map(s => [s.id, s]));
    return tabOrder.map(id => map.get(id)).filter(Boolean);
  }, [activeSessions, tabOrder]);

  // Sessions visible on the active desktop: owned by this desktop, or not yet owned by any desktop
  const desktopOrderedSessions = useMemo(() => {
    const activeDesktop = desktops.find(d => d.id === activeDesktopId);
    const ownedByActive = new Set(activeDesktop?.ownedSessionIds || []);
    const ownedByOthers = new Set(
      desktops.filter(d => d.id !== activeDesktopId).flatMap(d => d.ownedSessionIds || [])
    );
    return orderedSessions.filter(s => ownedByActive.has(s.id) || !ownedByOthers.has(s.id));
  }, [orderedSessions, desktops, activeDesktopId]);

  const visibleDesktopSessions = useMemo(
    () => desktopOrderedSessions.filter((session) => !session.thread?.archived),
    [desktopOrderedSessions]
  );

  const handleReorderSessions = useCallback((newOrder) => {
    setTabOrder(newOrder);
  }, []);

  // Reset header collapse when switching mobile views
  useEffect(() => {
    mobileViewportAtBottomRef.current = true;
    resetScrollDirection();
  }, [mobileView, resetScrollDirection]);

  useEffect(() => {
    mobileViewportAtBottomRef.current = true;
    resetScrollDirection();
  }, [chatMode, mobileVisibleSessionId, resetScrollDirection]);

  useEffect(() => {
    if (!chatMode || !keybarOpen) return;
    setKeybarOpen(false);
  }, [chatMode, keybarOpen]);

  useEffect(() => {
    if (!isMobileTextEntryFocused) return;
    mobileViewportAtBottomRef.current = true;
    resetScrollDirection();
  }, [isMobileTextEntryFocused, resetScrollDirection]);

  // Track focused session for recency ordering and unread state
  useEffect(() => {
    if (activeSessionId) {
      setFocusedSession(activeSessionId);
    }
  }, [activeSessionId, setFocusedSession]);

  useEffect(() => {
    const previousActiveSessionId = previousActiveSessionRef.current;
    if (
      previousActiveSessionId &&
      previousActiveSessionId !== activeSessionId &&
      sessionActivity?.[previousActiveSessionId]?.isBusy
    ) {
      markSessionActivity(previousActiveSessionId);
    }
    previousActiveSessionRef.current = activeSessionId || null;
  }, [activeSessionId, sessionActivity, markSessionActivity]);

  // Settings loaded from server (with localStorage fallback)
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Sidebar collapsed state (synced with server)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return storage.getItem('sidebarCollapsed') === 'true';
    } catch {
      return false;
    }
  });


  // Terminal font size (synced with server)
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    try {
      const deviceStored = storage.getItem(terminalFontSizeStorageKey);
      if (deviceStored) return parseInt(deviceStored, 10);
      const stored = storage.getItem('terminalFontSize');
      if (stored) return parseInt(stored, 10);
      return isMobile ? 16 : 14;
    } catch {
      return isMobile ? 16 : 14;
    }
  });

  const [terminalWebglEnabled, setTerminalWebglEnabled] = useState(() => {
    try {
      const stored = storage.getItem('terminalWebglEnabled');
      if (stored !== null) return resolveTerminalWebglEnabled(stored === 'true');
      return resolveTerminalWebglEnabled(true);
    } catch {
      return resolveTerminalWebglEnabled(true);
    }
  });
  const desktopTerminalInputMigrationRef = useRef(false);
  const [desktopAllowTerminalInput, setDesktopAllowTerminalInput] = useState(() => {
    const preference = resolveDesktopTerminalInputPreference(storage);
    desktopTerminalInputMigrationRef.current = preference.didResetLegacyPreference;
    return preference.value;
  });
  const [showTabStatusLabels, setShowTabStatusLabels] = useState(() => {
    try {
      const stored = storage.getItem('showTabStatusLabels');
      if (stored === null) return true;
      return stored === 'true';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (resolveTerminalWebglEnabled(true)) return;
    try {
      storage.setItem('terminalWebglEnabled', 'false');
    } catch {
      // Ignore storage failures
    }
  }, []);

  // Fetch settings from server on mount
  useEffect(() => {
    if (remotePreferences) { desktopTerminalInputMigrationRef.current = false; setSettingsLoaded(true); return; }
    const shouldResetLegacyDesktopTypingPreference = desktopTerminalInputMigrationRef.current;
    if (shouldResetLegacyDesktopTypingPreference) {
      setDesktopAllowTerminalInput(false);
      if (!remotePreferences) apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopAllowTerminalInput: false })
      }).catch((error) => {
        console.error('Failed to reset desktop terminal input setting to composer-only', error);
      });
    }

    const fetchSettings = async () => {
      try {
        const response = await apiFetch('/api/settings');
        if (response.ok) {
          const data = await response.json();
          // Apply server settings if they exist
          if (data.terminalFontSize !== null) {
            let hasDeviceOverride = false;
            try {
              hasDeviceOverride = storage.getItem(terminalFontSizeStorageKey) !== null;
            } catch {
              hasDeviceOverride = false;
            }

            if (!hasDeviceOverride) {
              setTerminalFontSize(data.terminalFontSize);
              try {
                storage.setItem('terminalFontSize', String(data.terminalFontSize));
                storage.setItem(terminalFontSizeStorageKey, String(data.terminalFontSize));
              } catch { /* ignore */ }
            }
          }
          if (data.terminalWebglEnabled !== null && data.terminalWebglEnabled !== undefined) {
            const resolvedWebglEnabled = resolveTerminalWebglEnabled(data.terminalWebglEnabled);
            setTerminalWebglEnabled(resolvedWebglEnabled);
            try {
              storage.setItem('terminalWebglEnabled', String(resolvedWebglEnabled));
            } catch { /* ignore */ }
          }
          if (
            !shouldResetLegacyDesktopTypingPreference
            && data.desktopAllowTerminalInput !== null
            && data.desktopAllowTerminalInput !== undefined
          ) {
            setDesktopAllowTerminalInput(data.desktopAllowTerminalInput);
            try {
              storage.setItem('desktopAllowTerminalInput', String(data.desktopAllowTerminalInput));
            } catch { /* ignore */ }
          }
          if (data.sidebarCollapsed !== null && data.sidebarCollapsed !== undefined) {
            setSidebarCollapsed(data.sidebarCollapsed);
            try {
              storage.setItem('sidebarCollapsed', String(data.sidebarCollapsed));
            } catch { /* ignore */ }
          }
          // Apply server theme if no localStorage override
          if (data.theme) {
            let hasLocalTheme = false;
            try {
              hasLocalTheme = storage.getItem('theme') !== null;
            } catch { hasLocalTheme = false; }
            if (!hasLocalTheme) {
              setTheme(data.theme);
            }
          }
          // Apply server tab order
          if (Array.isArray(data.tabOrder) && data.tabOrder.length > 0) {
            setTabOrder(data.tabOrder);
          }
        }
      } catch (e) {
        console.error('Failed to fetch settings from server:', e);
      } finally {
        desktopTerminalInputMigrationRef.current = false;
        setSettingsLoaded(true);
      }
    };
    fetchSettings();
  }, [terminalFontSizeStorageKey, setTheme]);

  const updateTerminalFontSize = useCallback((size) => {
    setTerminalFontSize(size);
    // Save to localStorage for immediate use
    try {
      storage.setItem('terminalFontSize', String(size));
      storage.setItem(terminalFontSizeStorageKey, String(size));
    } catch (e) {
      console.error('Failed to save terminal font size to localStorage', e);
    }
    // Save to server for persistence across devices/sessions
    if (!remotePreferences) apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalFontSize: size })
    }).catch(e => console.error('Failed to save terminal font size to server', e));
  }, [terminalFontSizeStorageKey]);

  const updateTerminalWebglEnabled = useCallback((enabled) => {
    const resolvedEnabled = resolveTerminalWebglEnabled(enabled);
    setTerminalWebglEnabled(resolvedEnabled);
    try {
      storage.setItem('terminalWebglEnabled', String(resolvedEnabled));
    } catch (e) {
      console.error('Failed to save terminal WebGL setting to localStorage', e);
    }
    if (!remotePreferences) apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalWebglEnabled: resolvedEnabled })
    }).catch(e => console.error('Failed to save terminal WebGL setting to server', e));
  }, []);

  const updateDesktopAllowTerminalInput = useCallback((enabled) => {
    setDesktopAllowTerminalInput(enabled);
    try {
      storage.setItem('desktopAllowTerminalInput', String(enabled));
    } catch (e) {
      console.error('Failed to save desktop terminal input setting to localStorage', e);
    }
    if (!remotePreferences) apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desktopAllowTerminalInput: enabled })
    }).catch(e => console.error('Failed to save desktop terminal input setting to server', e));
  }, []);

  const updateShowTabStatusLabels = useCallback((enabled) => {
    setShowTabStatusLabels(enabled);
    try {
      storage.setItem('showTabStatusLabels', String(enabled));
    } catch (e) {
      console.error('Failed to save tab status label setting to localStorage', e);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const newValue = !prev;
      // Save to localStorage for immediate use
      try {
        storage.setItem('sidebarCollapsed', String(newValue));
      } catch (e) {
        console.error('Failed to save sidebar state to localStorage', e);
      }
      // Save to server for persistence across devices/sessions
      if (!remotePreferences) apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sidebarCollapsed: newValue })
      }).catch(e => console.error('Failed to save sidebar state to server', e));
      return newValue;
    });
  }, []);

  // Sync active session into pane assignment.
  // In multi-pane mode, only initialize empty active panes to avoid overwriting
  // other pane assignments when a different pane/session is selected.
  useEffect(() => {
    if (shouldInitializeWorkspacePane(activeSessionId, legacyLayout, visibleDesktopSessions.map(session => session.id))) {
      initializePaneWithSession(activeSessionId);
    }
  }, [activeSessionId, initializePaneWithSession, legacyLayout, visibleDesktopSessions]);

  const desktopPaneAssignmentSignature = useMemo(
    () => (legacyLayout?.panes || []).map((pane) => `${pane.id}:${pane.sessionId ?? ''}`).join('|'),
    [legacyLayout]
  );
  const visibleDesktopSessionSignature = useMemo(
    () => visibleDesktopSessions.map((session) => session.id).join('|'),
    [visibleDesktopSessions]
  );
  const visibleDesktopSessionIds = useMemo(
    () => visibleDesktopSessions.map((session) => session.id),
    [visibleDesktopSessionSignature]
  );

  useEffect(() => {
    reconcilePaneSessions(visibleDesktopSessionIds);
  }, [desktopPaneAssignmentSignature, reconcilePaneSessions, visibleDesktopSessionIds]);

  // Handlers that wrap context functions with local logic
  const handleSelectSession = useCallback((sessionId) => {
    cancelHistoryNavigation();
    setShowWorkspaceStart(false);
    selectSession(sessionId);
    const displayedPane = legacyLayout.panes.find(pane => pane.sessionId === sessionId);
    if (displayedPane) {
      focusPane(displayedPane.id);
      if (fullscreenPaneId && displayedPane.id !== fullscreenPaneId) toggleFullscreen(displayedPane.id);
    } else if (visibleDesktopSessions.some(session => session.id === sessionId)) {
      setPaneSession(fullscreenPaneId || legacyLayout.activePaneId, sessionId);
    }
    setShowPreview(false);
    if (isMobile) setMobileView('terminal');
  }, [cancelHistoryNavigation, focusPane, setPaneSession, legacyLayout, selectSession, setShowPreview, visibleDesktopSessions, fullscreenPaneId, toggleFullscreen, isMobile]);

  const handleRestoreSession = useCallback(async (sessionId) => {
    const result = await restoreSession(sessionId);
    if (result?.isCurrent?.() === false) return;
    addSessionToDesktop(sessionId);
    setShowPreview(false);
  }, [restoreSession, addSessionToDesktop, setShowPreview]);

  const handleSelectHistorySession = useCallback(async (sessionId, paneId = fullscreenPaneId || legacyLayout.activePaneId) => {
    cancelHistoryNavigation();
    setShowWorkspaceStart(false);
    const desktopId = activeDesktopId;
    const isTargetCurrent = () => historyPaneScope.current.desktopId === desktopId
      && (!paneId || historyPaneScope.current.panes.some(pane => pane.id === paneId));
    const result = await reopenWorkspaceSession(sessionId, { restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane, isTargetCurrent }, paneId);
    if (result?.reopened === false || result?.isCurrent?.() === false) return;
    setShowPreview(false);
  }, [cancelHistoryNavigation, restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane, legacyLayout.activePaneId, setShowPreview, fullscreenPaneId, activeDesktopId]);

  const handleSelectHistoryResult = useCallback(async row => {
    historyInteractionCleanup.current?.();
    const request = ++historyNavigationRequest.current;
    const cancelOnInteraction = () => cancelHistoryNavigation();
    document.addEventListener('pointerdown', cancelOnInteraction, true);
    document.addEventListener('keydown', cancelOnInteraction, true);
    document.addEventListener('input', cancelOnInteraction, true);
    historyInteractionCleanup.current = () => {
      document.removeEventListener('pointerdown', cancelOnInteraction, true);
      document.removeEventListener('keydown', cancelOnInteraction, true);
      document.removeEventListener('input', cancelOnInteraction, true);
    };
    setHistoryNavigation(null);
    setHistoryNavigationNotice('Opening conversation…');
    const paneId = fullscreenPaneId || legacyLayout.activePaneId;
    const initial = historyPaneScope.current;
    const initialPane = initial.panes.find(pane => pane.id === paneId);
    const isTargetCurrent = () => {
      const scope = historyPaneScope.current;
      return historyNavigationRequest.current === request && scope.desktopId === initial.desktopId
        && scope.activePaneId === paneId && scope.activeSessionId === initial.activeSessionId
        && (!scope.showWorkspaceStart || initial.showWorkspaceStart)
        && scope.panes.find(pane => pane.id === paneId)?.sessionId === initialPane?.sessionId;
    };
    setShowWorkspaceStart(false);
    try {
      const result = await reopenWorkspaceSession(row.sessionId, { restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane, isTargetCurrent }, paneId);
      if (!result?.reopened || result.isCurrent?.() === false || historyNavigationRequest.current !== request) {
        if (historyNavigationRequest.current === request) cancelHistoryNavigation();
        return;
      }
      setShowPreview(false);
      if (isMobile) setMobileView('terminal');
      const anchor = row.matchType === 'message' && row.anchor?.type === 'message' && typeof row.anchor.messageId === 'string' && row.anchor.messageId && ['user', 'assistant'].includes(row.anchor.role) ? row.anchor : null;
      setHistoryNavigationNotice(anchor ? 'Finding the matching message…' : 'Opening conversation…');
      setHistoryNavigation({ request, paneId, desktopId: initial.desktopId, sessionId: row.sessionId, anchor, isCurrent: result.isCurrent, mobile: isMobile });
    } catch (error) {
      if (historyNavigationRequest.current === request) {
        historyInteractionCleanup.current?.();
        historyInteractionCleanup.current = null;
        setHistoryNavigationNotice('Could not open this conversation. It may no longer be available.');
      }
    }
  }, [fullscreenPaneId, legacyLayout.activePaneId, restoreSession, unarchiveSession, addSessionToDesktop, selectSession, setPaneSession, focusPane, setShowPreview, isMobile, cancelHistoryNavigation]);

  useEffect(() => {
    if (!historyNavigation) return undefined;
    const { request, paneId, desktopId, sessionId, anchor, isCurrent, mobile } = historyNavigation;
    let finished = false;
    const finish = notice => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timeout);
      if (historyNavigationRequest.current !== request) return;
      historyInteractionCleanup.current?.();
      historyInteractionCleanup.current = null;
      setHistoryNavigationNotice(notice);
      setHistoryNavigation(null);
    };
    const findMessage = () => {
      const scope = historyPaneScope.current;
      if (historyNavigationRequest.current === request && !scope.sessions.some(session => session.id === sessionId)) {
        finish('This conversation is no longer available.');
        return;
      }
      if (historyNavigationRequest.current !== request || isCurrent?.() === false || scope.desktopId !== desktopId
        || scope.activePaneId !== paneId || scope.activeSessionId !== sessionId || scope.showWorkspaceStart) {
        finish('');
        return;
      }
      const host = mobile ? mobileHistoryContentRef.current : [...(mainContentRef.current?.querySelectorAll('[data-pane-host]') || [])].find(node => node.dataset.paneHost === paneId);
      if (!host || scope.panes.find(pane => pane.id === paneId)?.sessionId !== sessionId || !scope.sessions.some(session => session.id === sessionId)) return;
      if (!anchor) {
        finish('Conversation opened. An exact message location is not available for this result.');
        return;
      }
      const view = [...host.querySelectorAll('[data-conversation-session-id]')].find(node => node.dataset.conversationSessionId === sessionId);
      if (!view) return;
      const target = [...view.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === anchor.messageId && node.dataset.messageRole === anchor.role);
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        target.classList.add('history-search-highlight');
        setTimeout(() => target.classList.remove('history-search-highlight'), 4000);
        finish('Matching message located.');
        return;
      }
      const folded = [...view.querySelectorAll('[data-folded-message-id]')].find(node => node.dataset.foldedMessageId === anchor.messageId && node.dataset.foldedMessageRole === anchor.role);
      const toggle = folded?.parentElement?.querySelector('.conversation-work-toggle[aria-expanded="false"]');
      if (toggle) {
        historyNavigationExpanding.current = true;
        try { toggle.click(); } finally { historyNavigationExpanding.current = false; }
      }
    };
    const observer = new MutationObserver(findMessage);
    observer.observe((mobile ? mobileHistoryContentRef.current : mainContentRef.current) || document.body, { childList: true, subtree: true });
    const timeout = setTimeout(() => {
      if (historyNavigationRequest.current !== request || isCurrent?.() === false) { finish(''); return; }
      const exists = historyPaneScope.current.sessions.some(session => session.id === sessionId);
      finish(exists ? 'The matching message could not be located in this conversation.' : 'This conversation is no longer available.');
    }, 8000);
    findMessage();
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [historyNavigation, activeDesktopId, activeSessionId, fullscreenPaneId, legacyLayout.activePaneId, desktopPaneAssignmentSignature, showWorkspaceStart, cancelHistoryNavigation]);

  const handlePaneSessionSelect = useCallback((paneId, sessionId) => {
    cancelHistoryNavigation();
    // Ensure this pane is active before syncing global active session state.
    focusPane(paneId);
    const newSessionId = setPaneSession(paneId, sessionId);
    if (newSessionId) {
      selectSession(newSessionId);
    }
  }, [cancelHistoryNavigation, focusPane, setPaneSession, selectSession]);

  const handleRenameThread = useCallback(async (sessionId, title) => {
    const auth = captureAuthScope();
    const signal = getEnvironmentSignal();
    const result = await renameSession(sessionId, title);
    if (result?.ok === false) return result;
    if (signal.aborted || signal !== getEnvironmentSignal() || !isAuthScopeCurrent(auth)) {
      return { ok: false, error: new Error('The account or environment changed. Check the original thread before trying again.') };
    }
    try {
      return await updateSessionTopic(sessionId, title, false);
    } catch (error) {
      return { ok: false, error };
    }
  }, [renameSession, updateSessionTopic]);

  const handlePaneFocus = useCallback((paneId) => {
    if (historyNavigationExpanding.current) return;
    cancelHistoryNavigation();
    filePaneScope.current = { desktopId: historyPaneScope.current.desktopId, pane: historyPaneScope.current.panes.find(pane => pane.id === paneId) };
    const sessionId = focusPane(paneId);
    if (sessionId) {
      selectSession(sessionId);
    }
    if (fullscreenPaneId && paneId !== fullscreenPaneId) toggleFullscreen(paneId);
  }, [cancelHistoryNavigation, focusPane, selectSession, fullscreenPaneId, toggleFullscreen]);

  const handlePaneFind = useCallback((paneId, sessionId, opener) => {
    setPendingPaneFind({ paneId, sessionId, opener, desktopId: activeDesktopId });
  }, [activeDesktopId]);

  useEffect(() => {
    if (!pendingPaneFind) return;
    setPendingPaneFind(null);
    const { paneId, sessionId, opener, desktopId } = pendingPaneFind;
    const pane = legacyLayout.panes.find(item => item.id === paneId);
    if (isMobile || showWorkspaceStart || activeDesktopId !== desktopId
      || (fullscreenPaneId || legacyLayout.activePaneId) !== paneId || pane?.sessionId !== sessionId
      || !opener?.isConnected || document.activeElement !== opener) return;
    setFindFocusRequest({ opener });
    setFindInThreadOpen(true);
  }, [pendingPaneFind, isMobile, showWorkspaceStart, activeDesktopId, fullscreenPaneId, legacyLayout]);

  const handlePaneFullscreen = useCallback((paneId) => {
    const sessionId = focusPane(paneId);
    if (sessionId) selectSession(sessionId);
    toggleFullscreen(paneId);
  }, [focusPane, selectSession, toggleFullscreen]);

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleSidebarFolderSelect = useCallback((path) => {
    if (!path) return;
    if (activeSessionId) {
      void navigateSession(activeSessionId, path).catch(error => window.alert(error.message));
    } else {
      addRecentFolder(path);
    }
  }, [activeSessionId, navigateSession, addRecentFolder]);

  const handleKeybarHeightChange = useCallback((height) => {
    setKeybarHeight(Math.max(0, Math.round(height)));
  }, []);

  const handleRequestNewSession = useCallback(async (projectPathOrEvent) => {
    const projectPath = typeof projectPathOrEvent === 'string'
      ? projectPathOrEvent
      : '';

    if (projectPath) {
      // Create directly in the project directory
      try {
        const session = await createSession({ cwd: projectPath });
        if (session?.id) {
          persistSidebarProject(addSidebarProject, projectPath, session);
          addSessionToDesktop(session.id);
        }
      } catch { /* createSession already logs */ }
    } else {
      setNewSessionLaunchMode(undefined);
      setShowNewSessionModal(true);
    }
  }, [addSessionToDesktop, addSidebarProject, createSession, setShowNewSessionModal]);

  const handleSubmitWorkspaceStartPrompt = useCallback(async (prompt, options = {}) => {
    return startWorkspacePrompt(prompt, options, { customAiProviders, createStructuredSession,
      rememberProject: (cwd, session) => persistSidebarProject(addSidebarProject, cwd, session), addSessionToDesktop, sendToSession });
  }, [addSessionToDesktop, addSidebarProject, createStructuredSession, customAiProviders, sendToSession]);

  const handleOpenWorkspaceImageConversation = useCallback(async (prompt, options = {}) => {
    return openWorkspaceImageConversation(prompt, options, { customAiProviders, createStructuredSession,
      rememberProject: (cwd, session) => persistSidebarProject(addSidebarProject, cwd, session), addSessionToDesktop,
      desktopId: imageStartDesktop.desktopId, isDesktopCurrent: () => imageStartDesktopRef.current === imageStartDesktop,
      onSelected: () => setShowWorkspaceStart(false) });
  }, [addSessionToDesktop, addSidebarProject, createStructuredSession, customAiProviders, imageStartDesktop]);

  // Starts a fresh thread in the same folder with the same agent and model, seeded with a first message.
  const handleStartThreadWithPrompt = useCallback((prompt, session) => {
    if (!session?.cwd) return;
    handleSubmitWorkspaceStartPrompt(prompt, { path: session.cwd, agentId: session.runtime === 'codex' ? 'codex' : session.aiType,
      selection: session.model ? { model: session.model, reasoning: session.reasoning || '' } : undefined })
      .then(result => { if (result?.sessionId && session.id) return recordThreadLineage(result.sessionId, session.id, 'fork'); })
      .catch(error => console.error('Failed to start the new thread', error));
  }, [handleSubmitWorkspaceStartPrompt]);

  const handleCloseNewSessionModal = useCallback(() => {
    setShowNewSessionModal(false);
  }, []);

  const handleCreateSessionFromFolder = useCallback(async (
    path,
    aiOptionId = 'cli',
    tabName = '',
    agentSelection = null,
  ) => {
    if (!path) return;
    const newTabAiOptions = getNewTabAiOptions(customAiProviders);
    const selectedAi = newTabAiOptions.find((option) => option.id === aiOptionId) || newTabAiOptions[0];
    const title = tabName || selectedAi.title || undefined;
    try {
      const launch = aiOptionId === 'cli' ? { kind: 'terminal' }
        : await resolveAgentSessionLaunch(aiOptionId, agentSelection, customAiProviders);
      const session = launch.kind === 'structured'
        ? await createStructuredSession({ cwd: path, provider: launch.provider, model: launch.model, reasoning: launch.reasoning, serviceTier: launch.serviceTier, title })
        : await createSession({ cwd: path, title, ...(launch.initialCommand ? { initialCommand: launch.initialCommand } : {}) });

      if (session?.id) {
        persistSidebarProject(addSidebarProject, path, session);
        addSessionToDesktop(session.id);
        if (aiOptionId !== 'cli') {
          setSessionAiTypes(prev => {
            const next = { ...prev, [session.id]: aiOptionId };
            storage.setItem('sessionAiTypes', JSON.stringify(next));
            return next;
          });
          void updateThreadMetadata(session.id, { aiType: aiOptionId }).catch(() => {});
        }
      }
      setShowNewSessionModal(false);
    } catch (error) { throw error; }
  }, [addSessionToDesktop, addSidebarProject, createSession, createStructuredSession, customAiProviders, updateThreadMetadata]);

  const handleSetSessionAiType = useCallback((sessionId, aiType) => {
    const normalizedAiType = normalizeAiType(aiType);
    setSessionAiTypes(prev => {
      const next = { ...prev };
      if (normalizedAiType) {
        next[sessionId] = normalizedAiType;
      } else {
        delete next[sessionId];
      }
      storage.setItem('sessionAiTypes', JSON.stringify(next));
      return next;
    });
    void updateThreadMetadata(sessionId, { aiType: normalizedAiType }).catch(() => {});
  }, [updateThreadMetadata]);

  const handleAddCustomAiProvider = useCallback((label, command) => {
    const provider = createCustomAiProvider(label, command, customAiProviders);
    if (!provider) return null;

    setCustomAiProviders((prev) => {
      const next = [...prev, provider];
      storage.setItem('customAiProviders', JSON.stringify(next));
      return next;
    });

    return provider;
  }, [customAiProviders]);

  // Keyboard shortcuts (desktop only)
  const keyboardPane = () => {
    const focusedId = document.activeElement?.closest?.('[data-pane-host]')?.getAttribute('data-pane-host');
    return legacyLayout.panes.find(pane => pane.id === (focusedId || fullscreenPaneId || legacyLayout.activePaneId));
  };
  useKeyboardShortcuts({
    onCommandPalette: () => setCommandPaletteOpen(open => !open),
    onFindInThread: () => setFindInThreadOpen(true),
    onToggleSidebar: toggleSidebar,
    onTogglePreview: toggleWorkspacePreview,
    onToggleFullScreen: () => {
      const pane = keyboardPane();
      if (pane) {
        handlePaneFullscreen(pane.id);
      }
    },
    onFocusPane: (index) => {
      if (legacyLayout.panes[index]) {
        handlePaneFocus(legacyLayout.panes[index].id);
      }
    },
    onNewTerminal: openNewTerminal,
    onCloseTerminal: () => {
      if (showWorkspaceStart) return;
      const pane = keyboardPane();
      const sessionId = pane ? pane.sessionId : fullscreenPaneId ? null : activeSessionId;
      if (sessionId) closeSession(sessionId);
    },
    onExitFullScreen: exitFullscreen,
    isFullScreen: !!fullscreenPaneId,
    paneCount: legacyLayout.panes.length,
    enabled: !isMobile && !showSystemResources
  });

  const paletteCommands = useMemo(() => [
    { id: 'new-thread', label: 'New thread', run: () => { cancelHistoryNavigation(); setShowWorkspaceStart(true); } },
    { id: 'new-terminal', label: 'New terminal', hint: formatBinding(loadBindings().newTerminal), run: openNewTerminal },
    { id: 'find', label: 'Find in thread', hint: formatBinding(loadBindings().findInThread), run: () => setFindInThreadOpen(true) },
    { id: 'files', label: 'Open Files', run: () => setShowFileManager(true) },
    { id: 'preview', label: 'Toggle preview', hint: formatBinding(loadBindings().togglePreview), run: toggleWorkspacePreview },
    { id: 'notes', label: 'Open Notes', run: () => setShowNotes(true) },
    { id: 'bookmarks', label: 'Open Bookmarks', run: () => setShowBookmarks(true) },
    { id: 'screenshots', label: 'Open Screenshots', run: () => setShowScreenshots(true) },
    { id: 'sidebar', label: 'Toggle sidebar', hint: formatBinding(loadBindings().toggleSidebar), run: toggleSidebar },
    { id: 'theme', label: 'Switch light or dark theme', run: toggleTheme },
    { id: 'settings', label: 'Open Settings', run: () => setShowSettings(true) },
  ], [cancelHistoryNavigation, openNewTerminal, setShowBookmarks, setShowFileManager, setShowNotes, setShowSettings, toggleSidebar, toggleTheme, toggleWorkspacePreview]);
  const paletteThreads = useMemo(() => sessions
    .filter(session => !session.thread?.archived && !isCompanionSession(session))
    .map(session => ({ id: session.id, title: session.thread?.topic || session.title || 'Untitled', project: projectNameFromPath(session.thread?.projectPath || session.cwd || '') })),
  [sessions]);

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
      await sendToSession(activeSessionId, text);
    } catch (error) {
      console.error('Failed to send to terminal', error);
      if (error.name !== 'AbortError') window.alert(error.message || 'The message could not be sent. Try again from the conversation.');
    }
  }, [activeSessionId, sendToSession]);

  // Send text to Claude Code (prefers an active Claude session, falls back to current terminal)
  const handleSendToClaudeCode = useCallback(async (text) => {
    if (!text) return;

    const targetSessionId = activeClaudeSession?.id || activeSessionId || activeSessions[0]?.id;
    if (!targetSessionId) return;

    if (targetSessionId !== activeSessionId) {
      selectSession(targetSessionId);
    }

    const payload = text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\r`;
    try {
      await sendToSession(targetSessionId, payload);
      if (isMobile) {
        handleMobileViewChange('terminal');
      }
    } catch (error) {
      console.error('Failed to send to Claude Code', error);
      if (error.name !== 'AbortError') window.alert(error.message || 'The message could not be sent. Try again from the conversation.');
    }
  }, [activeClaudeSession?.id, activeSessionId, activeSessions, handleMobileViewChange, isMobile, selectSession, sendToSession]);

  const handleNavigateToPath = useCallback(async (path) => {
    if (!activeSessionId || !path) return;

    try {
      await navigateSession(activeSessionId, path);
    } catch (error) {
      console.error('Failed to navigate to path', error);
      window.alert(error.message || 'Unable to change directory.');
    }
  }, [activeSessionId, navigateSession]);

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
  const handleSplitPointerDown = useCallback((e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    previewDragRef.current = { pointerId: e.pointerId, target: e.currentTarget };
    startDragging(e);
  }, [startDragging]);

  const requestMainTerminalFit = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (mainTerminalFitRafRef.current) return;
    mainTerminalFitRafRef.current = window.requestAnimationFrame(() => {
      mainTerminalFitRafRef.current = null;
      setMainTerminalFitToken((token) => token + 1);
    });
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    if (!previewDragRef.current || !showPreview || fullscreenPaneId || mainTerminalMinimized || showSystemResources) {
      stopDragging();
      return;
    }

    const handlePointerMove = (e) => {
      if (!previewDragRef.current || previewDragRef.current.pointerId !== e.pointerId) return;
      if (!mainContentRef.current) return;
      const rect = mainContentRef.current.getBoundingClientRect();
      if (!rect.width) return;
      e.preventDefault();
      const newPosition = ((e.clientX - rect.left) / rect.width) * 100;
      updateSplitPosition(newPosition);
      requestMainTerminalFit();
    };

    const handlePointerEnd = (e) => {
      const drag = previewDragRef.current;
      if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
      previewDragRef.current = null;
      if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
      stopDragging();
      requestMainTerminalFit();
    };

    document.addEventListener('pointermove', handlePointerMove, { passive: false });
    document.addEventListener('pointerup', handlePointerEnd);
    document.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', handlePointerEnd);

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerEnd);
      document.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', handlePointerEnd);
      const drag = previewDragRef.current;
      previewDragRef.current = null;
      if (drag?.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    };
  }, [isDragging, requestMainTerminalFit, updateSplitPosition, stopDragging, showPreview, fullscreenPaneId, mainTerminalMinimized, showSystemResources, activeDesktopId]);

  useEffect(() => {
    requestMainTerminalFit();
  }, [requestMainTerminalFit, paneLayout?.root, fullscreenPaneId, showPreview, mainTerminalMinimized, showSystemResources]);

  useEffect(() => () => {
    if (mainTerminalFitRafRef.current) {
      cancelAnimationFrame(mainTerminalFitRafRef.current);
      mainTerminalFitRafRef.current = null;
    }
  }, []);

  // Handler to toggle main terminal minimized state
  const handleToggleMainTerminal = useCallback(() => {
    setMainTerminalMinimized(prev => {
      const newValue = !prev;
      try {
        storage.setItem('mainTerminalMinimized', String(newValue));
      } catch {
        // Ignore localStorage errors
      }
      return newValue;
    });
  }, []);

  const toggleFileManager = useCallback(() => {
    setShowFileManager((prev) => !prev);
  }, [setShowFileManager]);

  const openAddScanFolderModal = useCallback(() => {
    setAddScanFolderError('');
    setShowAddScanFolderModal(true);
  }, []);

  const closeAddScanFolderModal = useCallback(() => {
    setShowAddScanFolderModal(false);
    setAddScanFolderError('');
  }, []);

  const handleSubmitAddScanFolder = useCallback(async (folderPath) => {
    const result = await addScanFolder(folderPath);
    if (result?.ok) {
      closeAddScanFolderModal();
      return;
    }
    setAddScanFolderError(result?.error || 'Failed to add scan folder');
  }, [addScanFolder, closeAddScanFolderModal]);

  // Add project to sidebar (user-curated list)
  const openAddProjectModal = useCallback(() => {
    setShowAddProjectModal(true);
  }, []);

  // Opens the new-task composer only; the current conversation stays untouched in the sidebar.
  const handleStartProjectChat = useCallback((folderPath) => {
    if (typeof folderPath === 'string' && folderPath) setWorkspaceDraftPath(folderPath);
    setShowWorkspaceStart(true);
    if (!folderPath) setShowAddProjectModal(true);
  }, []);

  const handleAddProjectSelect = useCallback((folderPath) => {
    setWorkspaceDraftPath(folderPath);
    addSidebarProject(folderPath);
    addRecentFolder(folderPath);
    setShowAddProjectModal(false);
  }, [addRecentFolder, addSidebarProject]);

  const handleCloseProject = useCallback((projectPath, sessionIds = []) => {
    sessionIds.forEach((sessionId) => {
      closeSession(sessionId);
    });
    removeSidebarProject(projectPath);
  }, [closeSession, removeSidebarProject]);

  const mobileKeybarOffset = isMobile && keybarOpen ? keybarHeight : 0;
  // Mobile layout always follows visual viewport height so keyboard open/close
  // keeps composer and terminal content in sync on iOS/Android.
  const effectiveNavCollapsed = isMobile ? false : (shouldKeepMobileHeaderVisible ? false : isNavCollapsed);
  const mobileKeyboardDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('mobileDebug') === '1' || storage.getItem('mobileKeyboardDebug') === '1';
    } catch {
      return false;
    }
  }, []);
  const layoutStyle = isMobile || touchDesktopViewport
    ? {
        '--mobile-viewport-height': measuredViewportHeight
          ? `${Math.round(measuredViewportHeight)}px`
          : '100dvh',
        '--mobile-viewport-width': viewportWidth
          ? `${Math.round(viewportWidth)}px`
          : '100vw',
        '--mobile-viewport-offset': viewportOffsetTop
          ? `${Math.round(viewportOffsetTop)}px`
          : '0px',
        '--mobile-viewport-offset-left': viewportOffsetLeft
          ? `${Math.round(viewportOffsetLeft)}px`
          : '0px',
        ...(touchDesktopViewport ? { '--environment-bar-height': `${viewportChromeHeight}px` } : {})
      }
    : undefined;

  const scopedSidebarData = useMemo(() => scopeThreadsSidebarData({
    sessionsGroupedByProject,
    pinnedSessions,
    archivedSessions,
    activeSessions
  }), [activeSessions, archivedSessions, pinnedSessions, sessionsGroupedByProject]);

  const navigationSession = showWorkspaceStart ? null : activeSessions.find(session => session.id === activeSessionId);
  const navigationWorkspacePath = showWorkspaceStart || !navigationSession
    ? workspaceDraftPath || startupWorkspacePath
    : isStructuredSessionId(navigationSession.id)
      ? navigationSession.thread?.projectPath || navigationSession.cwd || currentWorkspacePath
      : currentWorkspacePath || navigationSession.cwd;
  const fileTargetIsCurrent = Boolean(filePaneTarget && !isMobile && !showWorkspaceStart
    && filePaneTarget.desktopId === activeDesktopId && filePaneTarget.paneId === activeFilePaneId
    && filePaneTarget.sessionId === activeSessionId && filePaneTarget.sessionId === filePaneScope.current.pane?.sessionId);
  const filesInitialPath = fileTargetIsCurrent ? filePaneTarget.path : navigationWorkspacePath || (navigationSession ? null : '~');
  const filesWorkspaceKey = fileTargetIsCurrent ? `pane-files:${filePaneTarget.request}` : navigationWorkspacePath || (navigationSession ? `pending:${navigationSession.id}` : 'home');
  useEffect(() => {
    if (filePaneTarget && (!showFileManager || !fileTargetIsCurrent)) setFilePaneTarget(null);
  }, [filePaneTarget, fileTargetIsCurrent, showFileManager]);
  const handleOpenPaneFiles = (path) => {
    const { desktopId, pane } = filePaneScope.current;
    if (typeof path !== 'string' || !path || !pane?.sessionId) return;
    setFilePaneTarget({ desktopId, paneId: pane.id, sessionId: pane.sessionId, path, request: ++filePaneRequest.current });
    setShowFileManager(true);
  };
  const navigationDraftId = navigationSession?.id || 'workspace-start';
  const readNavigationResponse = () => workspaceResponses.get(navigationSession?.id) || '';
  const navigationCanInsert = environmentAllows(getActiveEnvironment(), isStructuredSessionId(navigationSession?.id) || !navigationSession ? 'agentExecute' : 'terminalInput');
  const insertNavigationPrompt = navigationCanInsert ? prompt => {
    getComposerDraftStore(navigationDraftId).setText(value => value.trim() ? `${value}\n\n${prompt}` : prompt);
  } : undefined;
  const insertNavigationContext = navigationCanInsert ? context => {
    getComposerDraftStore(navigationDraftId).setText(value => context + (value.trim() ? `\n\nTask:\n${value}` : ''));
  } : undefined;
  const projectNavigationActions = <>
    <WorkspaceToolsButton label="Project tools" workspacePath={navigationWorkspacePath} currentSessionId={navigationSession?.id}
      readLatestAssistantText={readNavigationResponse}
      onStartTask={handleRequestNewSession} onSelectSession={handleSelectHistorySession} onInsertPrompt={insertNavigationPrompt} />
    <WorkspaceProfileButton workspacePath={navigationWorkspacePath} aiOptions={getNewTabAiOptions(customAiProviders)} onInsertContext={insertNavigationContext} />
  </>;

  return (
    <div className={`layout${isMobile ? ' mobile' : ''}${touchDesktopViewport ? ' touch-viewport' : ''}${effectiveNavCollapsed ? ' nav-collapsed' : ''}`} style={layoutStyle}>
      <OwnerCleanupRecovery key={user?.id} onResolved={retryLoadSessions} />
      <RawInputRecovery sessions={sessions} />
      <RawInputPending sessions={sessions} />
      {sessionLoadError && !loadingSessions && <section className="session-load-notice" aria-label="Session loading problem">
        <p role="alert">Could not load your sessions.</p>
        <p>Check your connection and try again. Your existing sessions may be unavailable until loading succeeds.</p>
        <OwnershipRecovery onResolved={retryLoadSessions} />
        <button type="button" onClick={retryLoadSessions}>Retry loading sessions</button>
      </section>}
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} commands={paletteCommands} threads={paletteThreads} onSelectThread={handleSelectSession} />
      <FindInThread open={findInThreadOpen} focusRequest={findFocusRequest} onClose={() => { setFindInThreadOpen(false); setFindFocusRequest(null); }} />
      <ScreenshotGallery open={showScreenshots} onClose={() => setShowScreenshots(false)} />
      {!browserVisible && browserRequests.length > 0 && <button className="browser-request-notice" type="button" onClick={toggleBrowser}>Review browser request ({browserRequests.length})</button>}
      {isMobile && mobileKeyboardDebugEnabled && (
        <MobileKeyboardDebugOverlay
          viewportHeight={viewportHeight}
          keybarOpen={keybarOpen}
          keybarHeight={keybarHeight}
          mobileView={mobileView}
          chatMode={chatMode}
          enabled
        />
      )}
      <ErrorBoundary name="modals">
        <Suspense fallback={null}>
          <MountOnFirstOpen isOpen={showSettings}>
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
              desktopAllowTerminalInput={desktopAllowTerminalInput}
              onDesktopTerminalInputChange={updateDesktopAllowTerminalInput}
              onOpenApiSettings={() => {
                setShowSettings(false);
                setShowApiSettings(true);
              }}
              onOpenProcessManager={() => {
                setShowSettings(false);
                setShowProcessManager(true);
              }}
              onOpenSystemResources={() => {
                setShowSettings(false);
                setShowSystemResources(true);
              }}
              showTabStatusLabels={showTabStatusLabels}
              onTabStatusLabelsChange={updateShowTabStatusLabels}
            />
          </MountOnFirstOpen>
          <MountOnFirstOpen isOpen={showBookmarks}>
            <BookmarkModal
              isOpen={showBookmarks}
              onClose={() => setShowBookmarks(false)}
              bookmarks={bookmarks}
              loadStatus={bookmarksLoadStatus}
              loadError={bookmarksLoadError}
              onRetryLoad={reloadBookmarks}
              scopeKey={bookmarksScopeKey}
              onAdd={addBookmark}
              onUpdate={updateBookmark}
              onDelete={deleteBookmark}
              onExecute={executeBookmark}
            />
          </MountOnFirstOpen>
          <MountOnFirstOpen isOpen={showNotes}>
            <NotesModal
              isOpen={showNotes}
              onClose={() => setShowNotes(false)}
              notes={notes}
              loadStatus={notesLoadStatus}
              loadError={notesLoadError}
              onRetryLoad={reloadNotes}
              scopeKey={notesScopeKey}
              onAdd={addNote}
              onUpdate={updateNote}
              onDelete={deleteNote}
            />
          </MountOnFirstOpen>
          <MountOnFirstOpen isOpen={showApiSettings}>
            <ApiSettingsModal
              isOpen={showApiSettings}
              onClose={() => setShowApiSettings(false)}
            />
          </MountOnFirstOpen>
          <MountOnFirstOpen isOpen={showBrowserSettings}>
            <BrowserSettingsModal
              isOpen={showBrowserSettings}
              onClose={() => setShowBrowserSettings(false)}
            />
          </MountOnFirstOpen>
          <MountOnFirstOpen isOpen={showProcessManager}>
            <ProcessManagerModal
              isOpen={showProcessManager}
              onClose={() => setShowProcessManager(false)}
              projects={projects}
            />
          </MountOnFirstOpen>
        </Suspense>
      </ErrorBoundary>

      <FolderBrowserModal
        isOpen={showNewSessionModal}
        onClose={handleCloseNewSessionModal}
        currentPath={startupWorkspacePath}
        recentFolders={recentFolders}
        onSelect={handleCreateSessionFromFolder}
        showAiSelector={true}
        aiOptions={getNewTabAiOptions(customAiProviders)}
        defaultAiOptionId="codex"
        launchMode={newSessionLaunchMode}
      />
      <AddScanFolderModal
        isOpen={showAddScanFolderModal}
        isLoading={projectsLoading}
        error={addScanFolderError}
        onClose={closeAddScanFolderModal}
        onSubmit={handleSubmitAddScanFolder}
      />
      <FolderBrowserModal
        isOpen={showAddProjectModal}
        onClose={() => setShowAddProjectModal(false)}
        currentPath={startupWorkspacePath}
        recentFolders={recentFolders}
        onSelect={handleAddProjectSelect}
      />

      {/* Desktop layout with sidebar */}
      {!isMobile && (
        <>
          <WorkspacePanel kind="navigation" collapsed={sidebarCollapsed} reserveSpace={showBrowser && !browserExpanded && !fullscreenPaneId && (viewportWidth || window.innerWidth) > 980 ? 720 : 640} onResize={requestMainTerminalFit}>
          <ThreadsSidebar
            sessionLoadError={Boolean(sessionLoadError)}
            sessionsLoading={Boolean(loadingSessions)}
            onOpenWorkspaceStart={() => { cancelHistoryNavigation(); setShowWorkspaceStart(true); }}
            serverControl={serverControl}
            workspacePath={navigationWorkspacePath}
            onInsertPrompt={insertNavigationPrompt}
            onInsertContext={insertNavigationContext}
            readLatestAssistantText={readNavigationResponse}
            aiOptions={getNewTabAiOptions(customAiProviders)}
            currentSessionId={navigationSession?.id || null}
            onCreateTerminal={openNewTerminal}
            onSelectHistorySession={handleSelectHistorySession}
            onSelectHistoryResult={handleSelectHistoryResult}
            historyNavigationNotice={historyNavigationNotice}
            isCollapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            sessionsGroupedByProject={scopedSidebarData.sessionsGroupedByProject}
            pinnedSessions={scopedSidebarData.pinnedSessions}
            archivedSessions={scopedSidebarData.archivedSessions}
            activeSessionId={activeSessionId}
            sessionActivity={sessionActivity}
            onSelectSession={handleSelectSession}
            onPinSession={pinSession}
            onUnpinSession={unpinSession}
            onArchiveSession={archiveSession}
            onUnarchiveSession={unarchiveSession}
            onMarkUnread={markSessionUnread}
            onUpdateThreadMetadata={updateThreadMetadata}
            onTopicChange={updateSessionTopic}
            onRenameSession={handleRenameThread}
            onCloseSession={closeSession}
            onCreateSession={path => { cancelHistoryNavigation(); if (typeof path === 'string') setWorkspaceDraftPath(path); setShowWorkspaceStart(true); }}
            onCloseProject={handleCloseProject}
            projects={sidebarProjects}
            onAddProject={openAddProjectModal}
            onOpenSettings={handleOpenSettings}
            onOpenBookmarks={() => setShowBookmarks(true)}
            onOpenScreenshots={() => setShowScreenshots(true)}
            onOpenNotes={() => setShowNotes(true)}
            showPreview={showPreview}
            onTogglePreview={toggleWorkspacePreview}
            showBrowser={showBrowser}
            onToggleBrowser={toggleBrowser}
            showFileManager={showFileManager}
            onToggleFileManager={toggleFileManager}
            logout={logout}
          />
          </WorkspacePanel>
          <div className="main-container">
          <div className="app-workspace-surface">
          <main
            ref={mainContentRef}
            className={`main-content${showPreview ? ' with-preview' : ''}${showBrowser && !fullscreenPaneId ? ' with-browser' : ''}${showBrowser && browserExpanded && !fullscreenPaneId ? ' browser-expanded' : ''}${isDragging ? ' dragging' : ''}${showSystemResources ? ' app-workspace-covered' : ''}`}
            inert={showSystemResources ? '' : undefined}
            aria-hidden={showSystemResources || undefined}
            onFocusCapture={rememberWorkspaceFocus}
          >
                <div
                  className={`terminal-pane${mainTerminalMinimized && showPreview ? ' minimized' : ''}`}
                  style={showPreview && !fullscreenPaneId && !mainTerminalMinimized ? { flex: `0 0 ${splitPosition}%` } : undefined}
                >
                  {loadingSessions ? (
                    <div className="empty-state">
                      <p>Loading sessions…</p>
                    </div>
                  ) : visibleDesktopSessions.length === 0 || showWorkspaceStart ? (
                    <WorkspaceStartView
                      onSelectHistorySession={handleSelectHistorySession}
                      onSelectSession={handleSelectSession}
                      currentPath={workspaceDraftPath || startupWorkspacePath}
                      projects={sidebarProjects}
                      recentFolders={recentFolders}
                      onSelectWorkspace={setWorkspaceDraftPath}
                      onCreateSession={path => typeof path === 'string' && path ? handleRequestNewSession(path) : openNewTerminal()}
                      onSubmitPrompt={handleSubmitWorkspaceStartPrompt}
                      onOpenImageConversation={handleOpenWorkspaceImageConversation}
                      onReviewImageConversation={handleSelectHistorySession}
                      onAddWorkspace={openAddProjectModal}
                    />
                  ) : (
                    <ErrorBoundary name="terminal" resetKey={activeSessionId}>
                      <SplitPaneContainer
                        onOpenFiles={handleOpenPaneFiles}
                        onFindInThread={handlePaneFind}
                        onStartThreadWithPrompt={handleStartThreadWithPrompt}
                        onWorkspaceResponseChange={handleWorkspaceResponseChange}
                        onSelectHistorySession={handleSelectHistorySession}
                        onStartWorkspaceTask={handleRequestNewSession}
                        onStartProjectChat={handleStartProjectChat}
                        projects={sidebarProjects}
                        recentFolders={recentFolders}
                        layout={legacyLayout}
                        paneLayout={paneLayout}
                        sessions={visibleDesktopSessions}
                        onPaneSessionSelect={handlePaneSessionSelect}
                        onPaneSplit={splitPane}
                        onPaneResize={resizeSplit}
                        onPaneClose={closePane}
                        onPaneFocus={handlePaneFocus}
                        onPaneFullscreen={handlePaneFullscreen}
                        fullscreenPaneId={fullscreenPaneId}
                        showPreview={showPreview && !fullscreenPaneId}
                        showBrowser={showBrowser && !fullscreenPaneId}
                        onToggleBrowser={toggleBrowser}
                        onMinimizeMainTerminal={handleToggleMainTerminal}
                        keybarOpen={keybarOpen}
                        viewportHeight={viewportHeight}
                        onUrlDetected={handleUrlDetected}
                        fontSize={terminalFontSize}
                        webglEnabled={terminalWebglEnabled}
                        sessionActivity={sessionActivity}
                        onSessionBusyChange={handleSessionBusyChange}
                        projectInfo={projectInfo}
                        sessionAiTypes={sessionAiTypes}
                        customAiProviders={customAiProviders}
                        onSetSessionAiType={handleSetSessionAiType}
                        onAddCustomAiProvider={handleAddCustomAiProvider}
                        desktopAllowTerminalInput={desktopAllowTerminalInput}
                        currentDesktopId={activeDesktopId}
                        fitSignal={mainTerminalFitToken}
                      />
                    </ErrorBoundary>
                  )}
                </div>

                {showBrowser && !fullscreenPaneId && <WorkspacePanel kind="tools" expanded={browserExpanded} covered={showSystemResources} onClose={closeBrowser} onResize={requestMainTerminalFit}>
                  <ErrorBoundary name="browser"><Suspense fallback={<p>Loading browser…</p>}>
                    <WorkspaceBrowser onClose={closeBrowser} isExpanded={browserExpanded} onToggleExpanded={() => setBrowserExpanded(value => !value)} />
                  </Suspense></ErrorBoundary>
                </WorkspacePanel>}

                {/* Preview pane - hidden during fullscreen */}
                {showPreview && !fullscreenPaneId && (
                  <>
                    {!mainTerminalMinimized && (
                      <div
                        className={`split-handle workspace-preview-resizer${isDragging ? ' active' : ''}`}
                        data-pane-resize-handle=""
                        role="separator"
                        aria-label="Resize terminal and Preview"
                        aria-orientation="vertical"
                        aria-valuemin={20}
                        aria-valuemax={80}
                        aria-valuenow={Math.round(splitPosition)}
                        aria-valuetext={`${Math.round(splitPosition)}% terminal width`}
                        tabIndex={0}
                        onPointerDown={handleSplitPointerDown}
                        onLostPointerCapture={event => {
                          if (!previewDragRef.current || previewDragRef.current.pointerId !== event.pointerId) return;
                          previewDragRef.current = null;
                          stopDragging();
                          requestMainTerminalFit();
                        }}
                        onKeyDown={event => {
                          const step = event.shiftKey ? 10 : 5;
                          const position = { ArrowLeft: splitPosition - step, ArrowRight: splitPosition + step, Home: 20, End: 80, Enter: 50 }[event.key];
                          if (position === undefined) return;
                          event.preventDefault();
                          event.stopPropagation();
                          updateSplitPosition(position);
                          requestMainTerminalFit();
                        }}
                      />
                    )}
                    <ErrorBoundary name="preview" resetKey={previewUrl}>
                      <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                        <PreviewPanel
                          url={previewUrl}
                          onClose={handlePreviewClose}
                          onUrlChange={handlePreviewUrlChange}
                          projectInfo={projectInfo || (!activeSessionId ? { cwd: currentWorkspacePath, projectType: 'unknown' } : null)}
                          onStartProject={handleStartProject}
                          onOpenTerminal={handlePreviewOpenTerminal}
                          onSendToTerminal={handleSendToTerminal}
                          onSendToClaudeCode={handleSendToClaudeCode}

                          activeSessions={previewTerminalSessions}
                          activeSessionId={previewTerminalSessionId}
                          sessionActivity={sessionActivity}
                          onSessionBusyChange={handleSessionBusyChange}
                          fontSize={terminalFontSize}
                          webglEnabled={terminalWebglEnabled}
                          onUrlDetected={handlePreviewUrlChange}
                          mainTerminalMinimized={mainTerminalMinimized}
                          onToggleMainTerminal={handleToggleMainTerminal}
                          showStatusLabels={showTabStatusLabels}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  </>
                )}
          </main>
          {showSystemResources && <section className="app-resources-surface" aria-label="System Resources" tabIndex={-1} ref={resourcesSurfaceRef}>
            <Suspense fallback={<div className="empty-state"><p>Loading System Resources...</p></div>}>
              <SystemResourcesView onClose={closeSystemResources} />
            </Suspense>
          </section>}
          </div>

          {/* File Manager Sidebar */}
          {showFileManager && (
            <Suspense fallback={null}>
              <FileManager
                key={filesWorkspaceKey}
                initialPath={filesInitialPath}
                sessionId={navigationSession?.id || null}
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
            <MobileHeader
            sessionLoadError={Boolean(sessionLoadError)}
            sessionsLoading={Boolean(loadingSessions)}
            serverControl={serverControl}
            workspaceActions={projectNavigationActions}
            onFindInThread={() => setFindInThreadOpen(true)}
            onCreateTerminal={openNewTerminal}
            threadTerminalOpen={mobileThreadTerminal?.sessionId === activeSessionId && mobileThreadTerminal.open}
            onToggleThreadTerminal={() => {
              if (!activeSessionId) return;
              const shouldOpen = mobileView === 'preview' || mobileThreadTerminal?.sessionId !== activeSessionId || !mobileThreadTerminal.open;
              setMobileThreadTerminal({ sessionId: activeSessionId, open: shouldOpen });
              if (mobileView === 'preview') handleMobileViewChange('terminal');
            }}
            isWorkspaceStart={showWorkspaceStart || !navigationSession}
            gitControl={<WorkspaceToolsButton label="Git" ariaLabel="Git" iconOnly initialTool="git" workspacePath={navigationWorkspacePath}
              readLatestAssistantText={readNavigationResponse}
              currentSessionId={navigationSession?.id} onStartTask={handleRequestNewSession} onSelectSession={handleSelectHistorySession} onInsertPrompt={insertNavigationPrompt}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="20" r="2" /><path d="M6 6v12m12-10a8 8 0 0 1-8 8H6" /></svg>} />}
            newSessionLabel="New thread"
            activeSessions={activeSessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onSelectHistoryResult={handleSelectHistoryResult}
            onCreateSession={() => setShowWorkspaceStart(true)}
            onRenameSession={handleRenameThread}
            onPinSession={pinSession}
            onUnpinSession={unpinSession}
            archivedSessions={scopedSidebarData.archivedSessions}
            onArchiveSession={archiveSession}
            onUnarchiveSession={unarchiveSession}
            onUpdateThreadMetadata={updateThreadMetadata}
            onCloseSession={closeSession}
            onOpenSettings={handleOpenSettings}
            onOpenApiSettings={() => setShowApiSettings(true)}
            onOpenBrowserSettings={() => setShowBrowserSettings(true)}
            onOpenWorkspaceBrowser={toggleBrowser}
            onOpenBookmarks={() => setShowBookmarks(true)}
            onOpenNotes={() => setShowNotes(true)}
            onOpenProcessManager={() => setShowProcessManager(true)}
            onLogout={logout}
            keybarOpen={keybarOpen}
            onToggleKeybar={handleToggleKeybar}
            projects={projects}
            projectsLoading={projectsLoading}
            onFolderSelect={handleSidebarFolderSelect}
            currentPath={navigationWorkspacePath || ''}
            onAddScanFolder={openAddScanFolderModal}
            mobileView={mobileView}
            onViewChange={handleMobileViewChange}
            previewUrl={previewUrl}
            showFileManager={showFileManager}
            onToggleFileManager={toggleFileManager}
            isNavCollapsed={false}
            sessionActivity={sessionActivity}
            sessionsGroupedByProject={scopedSidebarData.sessionsGroupedByProject}
            sessionAiTypes={sessionAiTypes}
            onSetSessionAiType={handleSetSessionAiType}
              chatMode={chatMode}
              onToggleChatMode={() => setChatMode((value) => !value)}
              showPreviewNavigation={true}
              showConversationToggle={false}
              showDrawerViewTabs={true}
              singleRow={true}
            />
            <div className="app-workspace-surface">
            <main
              ref={mobileHistoryContentRef}
              className={`terminal-main${showSystemResources ? ' app-workspace-covered' : ''}`}
              style={{ '--mobile-keybar-offset': `${mobileKeybarOffset}px` }}
              inert={showSystemResources ? '' : undefined}
              aria-hidden={showSystemResources || undefined}
              onFocusCapture={rememberWorkspaceFocus}
            >
              {historyNavigationNotice && <div role="status" className="threads-history-navigation-notice">{historyNavigationNotice}</div>}
              {showBrowser && <WorkspacePanel kind="tools" forceSheet covered={showSystemResources} onClose={closeBrowser}><ErrorBoundary name="browser"><Suspense fallback={<p>Loading browser…</p>}><WorkspaceBrowser onClose={closeBrowser} /></Suspense></ErrorBoundary></WorkspacePanel>}
              <div className="mobile-workspace-body">
              <MountOnFirstOpen isOpen={mobileView === 'preview'}>
                <div className="mobile-workspace-surface" inert={mobileView !== 'preview' ? '' : undefined} aria-hidden={mobileView !== 'preview' || undefined}>
                <ErrorBoundary name="mobile-preview" resetKey={previewUrl}>
                  <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
                    <PreviewPanel
                      url={previewUrl}
                      onClose={closeMobilePreview}
                      onUrlChange={handlePreviewUrlChange}
                      projectInfo={projectInfo || (!activeSessionId ? { cwd: currentWorkspacePath, projectType: 'unknown' } : null)}
                      onStartProject={handleStartProject}
                      onOpenTerminal={handlePreviewOpenTerminal}
                      onSendToTerminal={handleSendToTerminal}
                      onSendToClaudeCode={handleSendToClaudeCode}
                      activeSessions={previewTerminalSessions}
                      activeSessionId={previewTerminalSessionId}
                      sessionActivity={sessionActivity}
                      onSessionBusyChange={handleSessionBusyChange}
                      fontSize={terminalFontSize}
                      webglEnabled={terminalWebglEnabled}
                      onUrlDetected={handlePreviewUrlChange}
                      mainTerminalMinimized={mainTerminalMinimized}
                      onToggleMainTerminal={handleToggleMainTerminal}
                      showStatusLabels={showTabStatusLabels}
                    />
                  </Suspense>
                </ErrorBoundary>
                </div>
              </MountOnFirstOpen>
              <div className="mobile-workspace-surface" inert={mobileView === 'preview' ? '' : undefined} aria-hidden={mobileView === 'preview' || undefined}>
                <MobileShell
                  visible={mobileView !== 'preview' && !showSystemResources}
                  onWorkspaceResponseChange={handleWorkspaceResponseChange}
                  showWorkspaceStart={showWorkspaceStart}
                  onSelectHistorySession={handleSelectHistorySession}
                  sessions={activeSessions}
                  terminalSessions={sessions}
                  threadTerminalOpen={mobileThreadTerminal?.sessionId === activeSessionId && mobileThreadTerminal.open}
                  activeSessionId={showWorkspaceStart ? null : activeSessionId}
                  onSelectSession={selectSession}
                  onCreateSession={path => typeof path === 'string' && path ? handleRequestNewSession(path) : openNewTerminal()}
                  onSubmitPrompt={handleSubmitWorkspaceStartPrompt}
                  onOpenImageConversation={handleOpenWorkspaceImageConversation}
                  onReviewImageConversation={handleSelectHistorySession}
                  startWorkspacePath={workspaceDraftPath || startupWorkspacePath}
                  startProjects={sidebarProjects}
                  recentFolders={recentFolders}
                  onSelectWorkspace={setWorkspaceDraftPath}
                  onAddWorkspace={openAddProjectModal}
                  projectInfo={projectInfo || (!activeSessionId ? { cwd: startupWorkspacePath, projectType: 'unknown' } : null)}
                  sessionActivity={sessionActivity}
                  onSessionBusyChange={handleSessionBusyChange}
                  fontSize={terminalFontSize}
                  webglEnabled={terminalWebglEnabled}
                  onUrlDetected={handleUrlDetected}
                  viewportHeight={viewportHeight}
                  accessoryOpen={keybarOpen}
                  onAccessoryHeightChange={handleKeybarHeightChange}
                  onRegisterFocusTerminal={handleRegisterFocusTerminal}
                  sessionAiTypes={sessionAiTypes}
                  customAiProviders={customAiProviders}
                  onSetSessionAiType={handleSetSessionAiType}
                  onAddCustomAiProvider={handleAddCustomAiProvider}
                  showSessionStrip={false}
                />
              </div>
              </div>
            </main>
            {showSystemResources && <section className="app-resources-surface" aria-label="System Resources" tabIndex={-1} ref={resourcesSurfaceRef}>
              <Suspense fallback={<div className="empty-state"><p>Loading System Resources...</p></div>}>
                <SystemResourcesView onClose={closeSystemResources} />
              </Suspense>
            </section>}
            </div>
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
              zIndex: 9999
            }}
          />
          <Suspense fallback={null}>
            <FileManager
              key={filesWorkspaceKey}
              initialPath={filesInitialPath}
              sessionId={navigationSession?.id || null}
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
    <GuestInvitationGate>
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
    </GuestInvitationGate>
  );
}

function AuthenticatedApp() {
  const { user, isAuthenticated, loading } = useAuth();
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const [directoryRevision,setDirectoryRevision]=useState(0);
  const isMobile = useMobileDetect();
  useEffect(() => { if (!loading && !isAuthenticated) setEnvironmentIdentity(null); }, [loading, isAuthenticated]);

  if (loading) {
    return (
      <main className="auth-loading" role="status" aria-live="polite">
        <div className="auth-loading-spinner" aria-hidden="true" />
        <p>Opening workspace…</p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <EnvironmentIdentityGate userId={user.id}>
    <div className={`environment-shell${isMobile ? ' mobile-chrome' : ''}`}>
    <div className="environment-workspace" key={environment?.id || "home"}>
    <ThemeProvider>
      <AutocorrectProvider>
      <NotesProvider>
        <FolderProvider>
          <TerminalSessionProvider>
            <BookmarkProvider>
              <PaneLayoutProvider>
                <PreviewProvider>
                  <AppContent serverControl={<RemoteEnvironmentSwitcher compact key={directoryRevision}><DeviceRelayPanel onPaired={saved=>{setActiveEnvironment(saved);setDirectoryRevision(value=>value+1);}} /><RemoteDesktopPanel /><RemoteTunnelsPanel /><RemoteHostPanel /></RemoteEnvironmentSwitcher>} />
                </PreviewProvider>
              </PaneLayoutProvider>
            </BookmarkProvider>
          </TerminalSessionProvider>
        </FolderProvider>
      </NotesProvider>
      </AutocorrectProvider>
    </ThemeProvider>
    </div>
    </div>
    </EnvironmentIdentityGate>
  );
}
