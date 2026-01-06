import { useCallback, useEffect, useState, useRef, useMemo, lazy, Suspense } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { TerminalMicButton } from './components/TerminalMicButton';
import { SplitPaneContainer } from './components/SplitPaneContainer';
import { BookmarkModal } from './components/BookmarkModal';
import { MobileHeader } from './components/MobileHeader';
import { MobileKeybar } from './components/MobileKeybar';
import { PreviewPanel } from './components/PreviewPanel';
import { PreviewPip } from './components/PreviewPip';
import { PathBreadcrumb } from './components/PathBreadcrumb';
import { FolderBrowserModal } from './components/FolderBrowserModal';
import { SessionTabBar } from './components/SessionTabBar';
const ClaudeCodePanel = lazy(() => import('./components/ClaudeCodePanel'));
import ClaudeCodeSessionSelector from './components/ClaudeCodeSessionSelector';
import Sidebar from './components/Sidebar';
import { FileManager } from './components/FileManager';
import { MobileTerminalCarousel } from './components/MobileTerminalCarousel';
import LoginPage from './components/LoginPage';
import ApiSettingsModal from './components/ApiSettingsModal';
import { ProcessManagerModal } from './components/ProcessManagerModal';
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
import { apiFetch, apiGet } from './utils/api';
import { getAccessToken } from './utils/auth';

// Format bytes to human-readable GB
function formatBytes(bytes) {
  const gb = bytes / (1024 ** 3);
  return `${gb.toFixed(1)} GB`;
}

function SettingsModal({ isOpen, onClose, sessionId, sessionTitle, currentCwd, recentFolders, onSave, onAddRecentFolder, terminalFontSize, onFontSizeChange }) {
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [systemStats, setSystemStats] = useState(null);
  const dropdownRef = useRef(null);

  // Update local state when modal opens
  useEffect(() => {
    if (isOpen) {
      setWorkingDir(currentCwd || '');
    }
  }, [isOpen, currentCwd]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Poll system stats while modal is open
  useEffect(() => {
    if (!isOpen) {
      setSystemStats(null);
      return;
    }

    const fetchStats = async () => {
      try {
        const stats = await apiGet('/api/system/stats');
        if (stats.memory) {
          setSystemStats(stats);
        }
      } catch (err) {
        // Silently fail - stats are optional
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // 5s is sufficient for system stats
    return () => clearInterval(interval);
  }, [isOpen]);

  const handleSave = () => {
    if (workingDir && workingDir.trim()) {
      onAddRecentFolder(workingDir.trim());
    }
    onSave(sessionId, workingDir.trim());
    onClose();
  };

  const handleDownload = () => {
    const pathToDownload = workingDir || currentCwd;
    if (!pathToDownload) return;
    const params = new URLSearchParams({ path: pathToDownload });
    const token = getAccessToken();
    if (token) {
      params.set('token', token);
    }
    // Trigger download by navigating to the endpoint
    window.location.href = `/api/fs/download?${params.toString()}`;
  };

  const handleSelectFolder = (folder) => {
    setWorkingDir(folder);
    setShowDropdown(false);
  };

  const handleClear = () => {
    setWorkingDir('');
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Session Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Session: <strong>{sessionTitle || 'New Terminal'}</strong></label>
          </div>
          <div className="form-group">
            <label htmlFor="working-dir">Working Directory</label>
            <div className="input-with-actions">
              <div className="input-with-dropdown" ref={dropdownRef}>
                <input
                  id="working-dir"
                  type="text"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="e.g., C:\Users\YourName\Projects"
                  onFocus={() => recentFolders.length > 0 && setShowDropdown(true)}
                />
                {recentFolders.length > 0 && (
                  <button
                    type="button"
                    className="dropdown-toggle"
                    onClick={() => setShowDropdown(!showDropdown)}
                    aria-label="Show recent folders"
                  >
                    ▼
                  </button>
                )}
                {showDropdown && recentFolders.length > 0 && (
                  <div className="folder-dropdown">
                    <div className="folder-dropdown-header">Recent Folders</div>
                    {recentFolders.map((folder, index) => (
                      <button
                        key={index}
                        type="button"
                        className="folder-dropdown-item"
                        onClick={() => handleSelectFolder(folder)}
                      >
                        <span className="folder-icon">📁</span>
                        <span className="folder-path" title={folder}>
                          {folder}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="input-actions">
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => setShowFolderBrowser(true)}
                  title="Browse folders"
                >
                  Browse
                </button>
                {currentCwd && currentCwd !== workingDir && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => setWorkingDir(currentCwd)}
                    title="Use current terminal directory"
                  >
                    Use Current
                  </button>
                )}
                {workingDir && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={handleClear}
                    title="Clear directory"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <small>
              {currentCwd ? (
                <>Current: <code>{currentCwd}</code></>
              ) : (
                'Leave empty to use backend default'
              )}
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="font-size">Terminal Font Size</label>
            <div className="font-size-selector">
              <input
                id="font-size"
                type="range"
                min="10"
                max="24"
                value={terminalFontSize}
                onChange={(e) => onFontSizeChange(parseInt(e.target.value, 10))}
              />
              <span className="font-size-value">{terminalFontSize}px</span>
            </div>
            <small>Adjust terminal text size (changes apply immediately)</small>
          </div>

          {/* System Resources Section */}
          {systemStats && (
            <div className="settings-section" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-dim)' }}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>System Resources</h3>
              <div className="stat-row">
                <label>RAM</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${systemStats.memory.percentage}%` }}
                  />
                </div>
                <span>
                  {formatBytes(systemStats.memory.used)} / {formatBytes(systemStats.memory.total)}
                </span>
              </div>
              <div className="stat-row">
                <label>CPU</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${systemStats.cpu.percentage}%` }}
                  />
                </div>
                <span>{systemStats.cpu.percentage}% ({systemStats.cpu.cores} cores)</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-secondary"
            onClick={handleDownload}
            disabled={!workingDir && !currentCwd}
            title="Download folder as .zip"
          >
            ⬇ Download
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save & Navigate
          </button>
        </div>

        <FolderBrowserModal
          isOpen={showFolderBrowser}
          onClose={() => setShowFolderBrowser(false)}
          currentPath={workingDir || currentCwd}
          recentFolders={recentFolders}
          onSelect={(path) => {
            setWorkingDir(path);
            setShowFolderBrowser(false);
          }}
        />
      </div>
    </div>
  );
}

function SessionSelector({
  activeSessions,
  inactiveSessions,
  activeSessionId,
  onSelectSession,
  onRestoreSession,
  onCreateSession,
  onCloseSession,
  onRenameSession,
  isLoading
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const activeSession = activeSessions.find(s => s.id === activeSessionId);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [isOpen]);

  const handleSelect = (session) => {
    onSelectSession(session.id);
    setIsOpen(false);
  };

  const handleClose = (e, sessionId) => {
    e.stopPropagation();
    onCloseSession(sessionId);
  };

  const startRename = (e, session) => {
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const cancelRename = (e) => {
    if (e) {
      e.stopPropagation();
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = async (e, sessionId) => {
    e.stopPropagation();
    const trimmed = renameValue.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }
    const clipped = trimmed.slice(0, 60);
    if (clipped !== renameValue) {
      setRenameValue(clipped);
    }
    await onRenameSession(sessionId, clipped);
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <div className="session-selector" ref={dropdownRef}>
      <button
        type="button"
        className="session-selector-btn"
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="session-selector-label">
          {activeSession ? activeSession.title : 'No Terminal'}
        </span>
        <span className={`session-selector-arrow${isOpen ? ' open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className="session-selector-dropdown">
          <div className="session-selector-list">
            {isLoading && <div className="session-selector-empty">Loading...</div>}
            {!isLoading && activeSessions.length === 0 && (
              <div className="session-selector-empty">No active terminals</div>
            )}
            {activeSessions.map((session) => {
              const isRenaming = renamingId === session.id;
              return (
                <div
                  key={session.id}
                  className={`session-selector-item${session.id === activeSessionId ? ' active' : ''}`}
                  onClick={() => {
                    if (!isRenaming) {
                      handleSelect(session);
                    }
                  }}
                  role="option"
                  aria-selected={session.id === activeSessionId}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (isRenaming) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelect(session);
                    }
                  }}
                >
                  <div className="session-selector-item-info">
                    {isRenaming ? (
                      <input
                        className="session-selector-rename-input"
                        value={renameValue}
                        maxLength={60}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitRename(e, session.id);
                          }
                          if (e.key === 'Escape') {
                            cancelRename(e);
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <>
                        <span className="session-selector-item-title">{session.title}</span>
                        <span className="session-selector-item-shell">{session.shell || 'Shell'}</span>
                      </>
                    )}
                  </div>
                  <div className="session-selector-item-actions">
                    {isRenaming ? (
                      <>
                        <button
                          type="button"
                          className="session-selector-item-save"
                          onClick={(e) => commitRename(e, session.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="session-selector-item-cancel"
                          onClick={cancelRename}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-selector-item-rename"
                          onClick={(e) => startRename(e, session)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="session-selector-item-close"
                          onClick={(e) => handleClose(e, session.id)}
                          aria-label="Close terminal"
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {!isLoading && inactiveSessions.length > 0 && (
              <div className="session-selector-section-title">Inactive</div>
            )}
            {inactiveSessions.map((session) => {
              const isRenaming = renamingId === session.id;
              return (
                <div
                  key={session.id}
                  className="session-selector-item inactive"
                  onClick={() => {
                    if (!isRenaming) {
                      onRestoreSession(session.id);
                      setIsOpen(false);
                    }
                  }}
                  role="option"
                  aria-selected={session.id === activeSessionId}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (isRenaming) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onRestoreSession(session.id);
                      setIsOpen(false);
                    }
                  }}
                >
                  <div className="session-selector-item-info">
                    {isRenaming ? (
                      <input
                        className="session-selector-rename-input"
                        value={renameValue}
                        maxLength={60}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitRename(e, session.id);
                          }
                          if (e.key === 'Escape') {
                            cancelRename(e);
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <>
                        <span className="session-selector-item-title">
                          <span className="session-inactive-icon" title="Inactive terminal">{'\u23F8'}</span>
                          {session.title}
                        </span>
                        <span className="session-selector-item-shell">{session.shell || 'Shell'}</span>
                      </>
                    )}
                  </div>
                  <div className="session-selector-item-actions">
                    {isRenaming ? (
                      <>
                        <button
                          type="button"
                          className="session-selector-item-save"
                          onClick={(e) => commitRename(e, session.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="session-selector-item-cancel"
                          onClick={cancelRename}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-selector-item-restore"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRestoreSession(session.id);
                            setIsOpen(false);
                          }}
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          className="session-selector-item-rename"
                          onClick={(e) => startRename(e, session)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="session-selector-item-close"
                          onClick={(e) => handleClose(e, session.id)}
                          aria-label="Delete terminal"
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="session-selector-new"
            onClick={() => {
              onCreateSession();
              setIsOpen(false);
            }}
          >
            + New Terminal
          </button>
        </div>
      )}
    </div>
  );
}

function AppContent() {
  const { logout, user } = useAuth();

  // Context hooks
  const {
    sessions,
    activeSessionId,
    activeSessions,
    inactiveSessions,
    loadingSessions,
    restoringSessionId,
    projectInfo,
    createSession,
    selectSession,
    restoreSession,
    renameSession,
    closeSession,
    navigateSession,
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
    executeBookmark
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
    deleteClaudeCode,
    handleModelChange: handleClaudeCodeModelChange,
    handleFolderChange: handleClaudeCodeFolderChange
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
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showProcessManager, setShowProcessManager] = useState(false);
  const [showFileManager, setShowFileManager] = useState(false);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const [keybarHeight, setKeybarHeight] = useState(0);
  const [mobileView, setMobileView] = useState('terminal');
  const [mobileTerminalIndex, setMobileTerminalIndex] = useState(0);

  const mainContentRef = useRef(null);
  const isMobile = useMobileDetect();
  const viewportHeight = useViewportHeight();
  const { isCollapsed: isNavCollapsed, handleScroll: handleScrollDirection, reset: resetScrollDirection } = useScrollDirection();

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

  // Sidebar collapsed state (local UI setting)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Terminal font size (local UI setting)
  const [terminalFontSize, setTerminalFontSize] = useState(() => {
    try {
      const stored = localStorage.getItem('terminalFontSize');
      if (stored) return parseInt(stored, 10);
      return isMobile ? 20 : 14;
    } catch {
      return isMobile ? 20 : 14;
    }
  });

  const updateTerminalFontSize = useCallback((size) => {
    setTerminalFontSize(size);
    try {
      localStorage.setItem('terminalFontSize', String(size));
    } catch (e) {
      console.error('Failed to save terminal font size', e);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const newValue = !prev;
      try {
        localStorage.setItem('sidebarCollapsed', String(newValue));
      } catch (e) {
        console.error('Failed to save sidebar state', e);
      }
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

  const mobileKeybarOffset = isMobile && keybarOpen ? keybarHeight : 0;
  const layoutStyle =
    isMobile && viewportHeight
      ? {
          '--mobile-viewport-height': `${Math.round(viewportHeight)}px`
        }
      : undefined;

  return (
    <div className={`layout${isMobile ? ' mobile' : ''}${isNavCollapsed ? ' nav-collapsed' : ''}`} style={layoutStyle}>
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
      <ApiSettingsModal
        isOpen={showApiSettings}
        onClose={() => setShowApiSettings(false)}
      />
      <ProcessManagerModal
        isOpen={showProcessManager}
        onClose={() => setShowProcessManager(false)}
        projects={projects}
      />

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
            onOpenBookmarks={() => setShowBookmarks(true)}
            keybarOpen={keybarOpen}
            onToggleKeybar={() => setKeybarOpen(!keybarOpen)}
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
                />
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
                aria-label="Toggle Preview"
                title={showPreview ? 'Hide Preview' : 'Show Preview'}
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

          {projectInfo?.cwd && (
            <div className="breadcrumb-bar">
              <PathBreadcrumb
                cwd={projectInfo.cwd}
                onNavigate={handleNavigateToPath}
              />
            </div>
          )}

          <main
            ref={mainContentRef}
            className={`main-content${showPreview ? ' with-preview' : ''}${isDragging ? ' dragging' : ''}`}
          >
            {/* Left pane - switches between Terminal and Claude Code */}
            <div
              className="terminal-pane"
              style={showPreview && !fullscreenPaneId ? { flex: `0 0 ${splitPosition}%` } : undefined}
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
                    <p>Start a new Claude Code session to get AI-powered assistance.</p>
                    <p className="empty-hint">Use /model to change models</p>
                    <button className="btn-primary" onClick={() => startClaudeCode('sonnet')}>
                      + New Session
                    </button>
                  </div>
                ) : (
                  <Suspense fallback={<div className="empty-state"><p>Loading Claude Code...</p></div>}>
                    <ClaudeCodePanel
                      sessionId={activeClaudeCodeId}
                      cwd={claudeCodeSessions.find(s => s.id === activeClaudeCodeId)?.cwd}
                      model={claudeCodeSessions.find(s => s.id === activeClaudeCodeId)?.model}
                      recentFolders={recentFolders}
                      onFolderChange={handleClaudeCodeFolderChange}
                      onModelChange={handleClaudeCodeModelChange}
                      onSessionEnd={() => setLeftPanelMode('terminal')}
                    />
                  </Suspense>
                )
              )}
            </div>

            {/* Preview pane - hidden during fullscreen */}
            {showPreview && !fullscreenPaneId && (
              <>
                <div
                  className={`split-handle${isDragging ? ' active' : ''}`}
                  onMouseDown={handleSplitMouseDown}
                />
                <PreviewPanel
                  url={previewUrl}
                  onClose={handlePreviewClose}
                  onUrlChange={handlePreviewUrlChange}
                  projectInfo={projectInfo}
                  onStartProject={handleStartProject}
                />
              </>
            )}
          </main>

          {/* File Manager Sidebar */}
          {showFileManager && (
            <FileManager
              isOpen={showFileManager}
              onClose={() => setShowFileManager(false)}
              onNavigateTerminal={handleNavigateToPath}
            />
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
                  onScrollDirection={handleScrollDirection}
                />
              </div>
            )}

            {/* Claude Code pane */}
            {mobileView === 'claude' && (
              <div className="claude-code-pane">
                <Suspense fallback={<div className="empty-state"><p>Loading...</p></div>}>
                  <ClaudeCodePanel
                    sessionId={activeClaudeCodeId}
                    onSessionChange={handleClaudeCodeSessionChange}
                  />
                </Suspense>
              </div>
            )}

            {/* Mobile preview - full screen when active */}
            {mobileView === 'preview' && (
              <PreviewPanel
                url={previewUrl}
                onClose={() => setMobileView('terminal')}
                onUrlChange={handlePreviewUrlChange}
                projectInfo={projectInfo}
                onStartProject={handleStartProject}
              />
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
          <FileManager
            isOpen={showFileManager}
            onClose={() => setShowFileManager(false)}
            onNavigateTerminal={handleNavigateToPath}
          />
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
