import { useCallback, useEffect, useState, useRef } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { BookmarkModal } from './components/BookmarkModal';
import { MobileHeader } from './components/MobileHeader';
import { MobileKeybar } from './components/MobileKeybar';
import { PreviewPanel } from './components/PreviewPanel';
import { PathBreadcrumb } from './components/PathBreadcrumb';
import { FolderBrowserModal } from './components/FolderBrowserModal';
import ClaudeCodePanel from './components/ClaudeCodePanel';
import ClaudeCodeSessionSelector from './components/ClaudeCodeSessionSelector';
import Sidebar from './components/Sidebar';
import LoginPage from './components/LoginPage';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { useMobileDetect } from './hooks/useMobileDetect';
import { useViewportHeight } from './hooks/useViewportHeight';
import { apiFetch } from './utils/api';

function SettingsModal({ isOpen, onClose, sessionId, sessionTitle, currentCwd, recentFolders, onSave, onAddRecentFolder }) {
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
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
    // Trigger download by navigating to the endpoint
    window.location.href = `/api/fs/download?path=${encodeURIComponent(pathToDownload)}`;
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

function SessionSelector({ sessions, activeSessionId, onSelectSession, onRestoreSession, onCreateSession, onCloseSession, isLoading }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (session) => {
    if (session.isActive) {
      onSelectSession(session.id);
    } else {
      // Restore inactive session
      onRestoreSession(session.id);
    }
    setIsOpen(false);
  };

  const handleClose = (e, sessionId) => {
    e.stopPropagation();
    onCloseSession(sessionId);
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
        <span className="session-selector-arrow">{isOpen ? '\u25B2' : '\u25BC'}</span>
      </button>

      {isOpen && (
        <div className="session-selector-dropdown">
          <div className="session-selector-list">
            {isLoading && <div className="session-selector-empty">Loading...</div>}
            {!isLoading && sessions.length === 0 && (
              <div className="session-selector-empty">No terminals</div>
            )}
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`session-selector-item${session.id === activeSessionId ? ' active' : ''}${!session.isActive ? ' inactive' : ''}`}
                onClick={() => handleSelect(session)}
                role="option"
                aria-selected={session.id === activeSessionId}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(session);
                  }
                }}
              >
                <div className="session-selector-item-info">
                  <span className="session-selector-item-title">
                    {!session.isActive && <span className="session-inactive-icon" title="Inactive - click to restore">{'\u23F8'}</span>}
                    {session.title}
                  </span>
                  <span className="session-selector-item-shell">{session.shell || 'Shell'}</span>
                </div>
                <button
                  type="button"
                  className="session-selector-item-close"
                  onClick={(e) => handleClose(e, session.id)}
                  aria-label="Close terminal"
                >
                  ×
                </button>
              </div>
            ))}
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
  const [sessions, setSessions] = useState([]);
  // Restore terminal session from localStorage
  const [activeSessionId, setActiveSessionId] = useState(() => {
    try {
      return localStorage.getItem('lastActiveSession') || null;
    } catch {
      return null;
    }
  });
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const [keybarHeight, setKeybarHeight] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [mobileView, setMobileView] = useState('terminal'); // 'terminal' | 'preview'
  const [splitPosition, setSplitPosition] = useState(50); // percentage
  const [isDragging, setIsDragging] = useState(false);
  const [projectInfo, setProjectInfo] = useState(null);
  // Claude Code state - restore from localStorage
  const [leftPanelMode, setLeftPanelMode] = useState(() => {
    try {
      return localStorage.getItem('leftPanelMode') || 'terminal';
    } catch {
      return 'terminal';
    }
  });
  const [claudeCodeSessions, setClaudeCodeSessions] = useState([]);
  const [activeClaudeCodeId, setActiveClaudeCodeId] = useState(() => {
    try {
      return localStorage.getItem('lastActiveClaudeCodeId') || null;
    } catch {
      return null;
    }
  });
  const mainContentRef = useRef(null);
  const isMountedRef = useRef(true);
  const isMobile = useMobileDetect();
  const viewportHeight = useViewportHeight();

  // Load recent folders from localStorage
  const [recentFolders, setRecentFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('recentFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Load pinned folders from localStorage
  const [pinnedFolders, setPinnedFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('pinnedFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Projects (git repos) state
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Add a folder to recent list (max 10, no duplicates)
  const addRecentFolder = useCallback((folder) => {
    if (!folder) return;
    setRecentFolders(prev => {
      const filtered = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      const updated = [folder, ...filtered].slice(0, 10);
      try {
        localStorage.setItem('recentFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save recent folders', e);
      }
      return updated;
    });
  }, []);

  // Pin a folder (max 20)
  const pinFolder = useCallback((folder) => {
    if (!folder) return;
    setPinnedFolders(prev => {
      if (prev.some(f => f.toLowerCase() === folder.toLowerCase())) {
        return prev; // Already pinned
      }
      const updated = [...prev, folder].slice(0, 20);
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Unpin a folder
  const unpinFolder = useCallback((folder) => {
    setPinnedFolders(prev => {
      const updated = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Toggle sidebar collapsed state
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

  // Fetch projects (git repos) on mount
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan');
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || []);
      }
    } catch (error) {
      console.error('Failed to load projects', error);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoadingSessions(true);
    try {
      const response = await apiFetch('/api/terminal');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }

      const data = await response.json();
      if (isMountedRef.current) {
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch (error) {
      console.error('Failed to load sessions', error);
    } finally {
      if (isMountedRef.current) {
        setLoadingSessions(false);
      }
    }
  }, []);

  const loadBookmarks = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      const response = await apiFetch('/api/bookmarks');
      if (!response.ok) {
        throw new Error(`Failed to load bookmarks (${response.status})`);
      }

      const data = await response.json();
      if (isMountedRef.current) {
        setBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
      }
    } catch (error) {
      console.error('Failed to load bookmarks', error);
    }
  }, []);

  const handleAddBookmark = useCallback(
    async (name, command, category) => {
      try {
        const response = await apiFetch('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, command, category })
        });

        if (!response.ok) {
          throw new Error(`Failed to create bookmark (${response.status})`);
        }

        await loadBookmarks();
      } catch (error) {
        console.error('Failed to create bookmark', error);
      }
    },
    [loadBookmarks]
  );

  const handleUpdateBookmark = useCallback(
    async (id, updates) => {
      try {
        const response = await apiFetch(`/api/bookmarks/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (!response.ok) {
          throw new Error(`Failed to update bookmark (${response.status})`);
        }

        await loadBookmarks();
      } catch (error) {
        console.error('Failed to update bookmark', error);
      }
    },
    [loadBookmarks]
  );

  const handleDeleteBookmark = useCallback(
    async (id) => {
      try {
        const response = await apiFetch(`/api/bookmarks/${id}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          throw new Error(`Failed to delete bookmark (${response.status})`);
        }

        await loadBookmarks();
      } catch (error) {
        console.error('Failed to delete bookmark', error);
      }
    },
    [loadBookmarks]
  );

  const handleExecuteBookmark = useCallback(
    async (command) => {
      if (!activeSessionId) {
        alert('Please select a terminal session first');
        return;
      }

      try {
        await apiFetch(`/api/terminal/${activeSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: command + '\r' })
        });
      } catch (error) {
        console.error('Failed to execute bookmark command', error);
      }
    },
    [activeSessionId]
  );

  // Initial load - restore last active session if needed
  useEffect(() => {
    // Reset mounted ref (needed for React StrictMode double-invocation)
    isMountedRef.current = true;

    const initializeSessions = async () => {
      await loadSessions();
      await loadBookmarks();

      // If we have a session ID from localStorage, ensure it's restored
      const lastSessionId = localStorage.getItem('lastActiveSession');
      if (lastSessionId) {
        try {
          // Fetch fresh session list to check session status
          const response = await apiFetch('/api/terminal');
          if (response.ok) {
            const data = await response.json();
            const sessionList = Array.isArray(data.sessions) ? data.sessions : [];
            const lastSession = sessionList.find(s => s.id === lastSessionId);

            if (lastSession) {
              if (!lastSession.isActive) {
                // Session is persisted but not active, restore it
                const restoreResponse = await apiFetch(`/api/terminal/${lastSessionId}/restore`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({})
                });
                if (restoreResponse.ok) {
                  await loadSessions();
                }
              }
              // Session exists and is active (or just restored) - keep activeSessionId as is
            } else {
              // Session doesn't exist anymore, try to find an active session
              const activeSession = sessionList.find(s => s.isActive);
              if (activeSession) {
                setActiveSessionId(activeSession.id);
                localStorage.setItem('lastActiveSession', activeSession.id);
              } else if (sessionList.length > 0) {
                // No active session, use the first available
                setActiveSessionId(sessionList[0].id);
                localStorage.setItem('lastActiveSession', sessionList[0].id);
              } else {
                // No sessions at all
                localStorage.removeItem('lastActiveSession');
                setActiveSessionId(null);
              }
            }
          }
        } catch (error) {
          console.error('Failed to restore last session', error);
        }
      } else {
        // No stored session ID, try to select an active session
        try {
          const response = await apiFetch('/api/terminal');
          if (response.ok) {
            const data = await response.json();
            const sessionList = Array.isArray(data.sessions) ? data.sessions : [];
            const activeSession = sessionList.find(s => s.isActive);
            if (activeSession) {
              setActiveSessionId(activeSession.id);
              localStorage.setItem('lastActiveSession', activeSession.id);
            }
          }
        } catch (error) {
          console.error('Failed to find active session', error);
        }
      }
    };

    initializeSessions();

    // Reload sessions every 5 seconds to keep list fresh
    const interval = setInterval(loadSessions, 5000);
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, [loadSessions, loadBookmarks]);

  // Load projects on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Poll for project info when there's an active session
  const lastCwdRef = useRef(null);
  useEffect(() => {
    if (!activeSessionId) {
      setProjectInfo(null);
      lastCwdRef.current = null;
      return;
    }

    const fetchProjectInfo = async () => {
      try {
        const response = await apiFetch(`/api/terminal/${activeSessionId}/project-info`);
        if (response.ok) {
          const data = await response.json();
          setProjectInfo(data);

          // Track directory changes as recent folders
          if (data.cwd && data.cwd !== lastCwdRef.current) {
            lastCwdRef.current = data.cwd;
            addRecentFolder(data.cwd);
          }
        }
      } catch (error) {
        console.error('Failed to fetch project info', error);
      }
    };

    // Fetch immediately
    fetchProjectInfo();

    // Poll every 3 seconds
    const interval = setInterval(fetchProjectInfo, 3000);
    return () => clearInterval(interval);
  }, [activeSessionId, addRecentFolder]);

  // Fetch Claude Code sessions
  useEffect(() => {
    const fetchClaudeCodeSessions = async () => {
      try {
        const res = await apiFetch('/api/claude-code');
        const data = await res.json();
        setClaudeCodeSessions(data.sessions || []);
      } catch (error) {
        console.error('Failed to fetch Claude Code sessions:', error);
      }
    };

    fetchClaudeCodeSessions();
    const interval = setInterval(fetchClaudeCodeSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Persist Claude Code state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('leftPanelMode', leftPanelMode);
    } catch (e) {
      console.error('Failed to save leftPanelMode', e);
    }
  }, [leftPanelMode]);

  useEffect(() => {
    try {
      if (activeClaudeCodeId) {
        localStorage.setItem('lastActiveClaudeCodeId', activeClaudeCodeId);
      }
    } catch (e) {
      console.error('Failed to save lastActiveClaudeCodeId', e);
    }
  }, [activeClaudeCodeId]);

  const handleCreateSession = useCallback(async () => {
    try {
      const requestBody = {};
      // Use most recent folder as default for new sessions
      if (recentFolders.length > 0) {
        requestBody.cwd = recentFolders[0];
      }

      const response = await apiFetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`Failed to create session (${response.status})`);
      }

      const data = await response.json();
      setActiveSessionId(data.session.id);
      await loadSessions();
    } catch (error) {
      console.error('Failed to create session', error);
    }
  }, [loadSessions, recentFolders]);

  const handleSelectSession = useCallback(
    (sessionId) => {
      setActiveSessionId(sessionId);
      // Remember the last active session
      try {
        localStorage.setItem('lastActiveSession', sessionId);
      } catch (error) {
        console.error('Failed to save last active session', error);
      }
    },
    []
  );

  const handleRestoreSession = useCallback(
    async (sessionId) => {
      try {
        const response = await apiFetch(`/api/terminal/${sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });

        if (!response.ok) {
          throw new Error(`Failed to restore session (${response.status})`);
        }

        setActiveSessionId(sessionId);
        await loadSessions();

        // Remember the last active session
        try {
          localStorage.setItem('lastActiveSession', sessionId);
        } catch (error) {
          console.error('Failed to save last active session', error);
        }
      } catch (error) {
        console.error('Failed to restore session', error);
      }
    },
    [loadSessions]
  );

  const handleCloseSession = useCallback(
    async (sessionId) => {
      try {
        await apiFetch(`/api/terminal/${sessionId}`, {
          method: 'DELETE'
        });

        // If we just closed the active terminal, switch to another one or clear
        // Use functional updates to avoid stale state
        setSessions((currentSessions) => {
          const remainingSessions = currentSessions.filter((s) => s.id !== sessionId);
          setActiveSessionId((currentActiveId) => {
            if (sessionId === currentActiveId) {
              return remainingSessions.length > 0 ? remainingSessions[0].id : null;
            }
            return currentActiveId;
          });
          return remainingSessions;
        });

        // Reload the session list to ensure sync with server
        await loadSessions();
      } catch (error) {
        console.error('Failed to close session', error);
      }
    },
    [loadSessions]
  );

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  // Claude Code handlers - uses styled panel with JSON output parsing
  const handleStartClaudeCode = useCallback(async (model = 'sonnet') => {
    const cwd = sessions.find(s => s.id === activeSessionId)?.cwd || projectInfo?.cwd || '.';

    try {
      const res = await apiFetch('/api/claude-code/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      const session = await res.json();
      setClaudeCodeSessions(prev => [session, ...prev]);
      setActiveClaudeCodeId(session.id);
      setLeftPanelMode('claude-code');
    } catch (error) {
      console.error('Failed to start Claude Code:', error);
    }
  }, [sessions, activeSessionId, projectInfo]);

  const handleSelectClaudeCode = useCallback(async (id) => {
    const session = claudeCodeSessions.find(s => s.id === id);
    if (session && !session.isActive) {
      // Restore inactive session
      try {
        await apiFetch(`/api/claude-code/${id}/restore`, { method: 'POST' });
      } catch (error) {
        console.error('Failed to restore session:', error);
      }
    }
    setActiveClaudeCodeId(id);
    setLeftPanelMode('claude-code');
  }, [claudeCodeSessions]);

  const handleDeleteClaudeCode = useCallback(async (id) => {
    try {
      await apiFetch(`/api/claude-code/${id}`, { method: 'DELETE' });
      setClaudeCodeSessions(prev => prev.filter(s => s.id !== id));
      if (activeClaudeCodeId === id) {
        setActiveClaudeCodeId(null);
        setLeftPanelMode('terminal');
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }, [activeClaudeCodeId]);

  const handleClaudeCodeModelChange = useCallback((updatedSession) => {
    setClaudeCodeSessions(prev =>
      prev.map(s => s.id === updatedSession.id ? updatedSession : s)
    );
  }, []);

  // Handle folder change from Claude Code panel - syncs both Claude Code and Terminal
  const handleClaudeCodeFolderChange = useCallback(async (newPath) => {
    // 1. Send cd command to active Terminal session
    if (activeSessionId) {
      try {
        await apiFetch(`/api/terminal/${activeSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: `cd "${newPath}"\r` })
        });
      } catch (error) {
        console.error('Failed to change terminal directory:', error);
      }
    }

    // 2. Update Claude Code session's cwd (persist to backend)
    if (activeClaudeCodeId) {
      try {
        const res = await apiFetch(`/api/claude-code/${activeClaudeCodeId}/cwd`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: newPath })
        });
        if (res.ok) {
          const updatedSession = await res.json();
          setClaudeCodeSessions(prev =>
            prev.map(s => s.id === activeClaudeCodeId ? { ...s, cwd: updatedSession.cwd } : s)
          );
        }
      } catch (error) {
        console.error('Failed to update Claude Code cwd:', error);
      }
    }

    // 3. Add to recent folders
    addRecentFolder(newPath);
  }, [activeSessionId, activeClaudeCodeId, addRecentFolder]);

  // Navigate a session to a specific directory
  const handleNavigateSession = useCallback(async (sessionId, path) => {
    if (!sessionId || !path) return;

    try {
      const cdCommand = `cd "${path}"\r`;
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cdCommand })
      });
      // Add to recent folders
      addRecentFolder(path);
    } catch (error) {
      console.error('Failed to navigate session', error);
    }
  }, [addRecentFolder]);

  // Handle folder selection from sidebar
  const handleSidebarFolderSelect = useCallback((path) => {
    if (!path) return;

    if (activeSessionId) {
      handleNavigateSession(activeSessionId, path);
    } else {
      // No active session, just add to recent folders
      addRecentFolder(path);
    }
  }, [activeSessionId, handleNavigateSession, addRecentFolder]);

  const handleKeybarHeightChange = useCallback((height) => {
    setKeybarHeight(Math.max(0, Math.round(height)));
  }, []);

  const handleUrlDetected = useCallback((url) => {
    setPreviewUrl(url);
    setShowPreview(true);
  }, []);

  const handlePreviewClose = useCallback(() => {
    setShowPreview(false);
  }, []);

  const handlePreviewUrlChange = useCallback((url) => {
    setPreviewUrl(url);
  }, []);

  const togglePreview = useCallback(() => {
    setShowPreview(prev => !prev);
  }, []);

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

  // Split handle drag handlers
  const handleSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      if (!mainContentRef.current) return;
      const rect = mainContentRef.current.getBoundingClientRect();
      const newPosition = ((e.clientX - rect.left) / rect.width) * 100;
      // Clamp between 20% and 80%
      setSplitPosition(Math.min(80, Math.max(20, newPosition)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const mobileKeybarOffset = isMobile && keybarOpen ? keybarHeight : 0;
  const layoutStyle =
    isMobile && viewportHeight
      ? { '--mobile-viewport-height': `${Math.round(viewportHeight)}px` }
      : undefined;

  return (
    <div className={`layout${isMobile ? ' mobile' : ''}`} style={layoutStyle}>
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        sessionId={activeSessionId}
        sessionTitle={sessions.find(s => s.id === activeSessionId)?.title}
        currentCwd={projectInfo?.cwd}
        recentFolders={recentFolders}
        onSave={handleNavigateSession}
        onAddRecentFolder={addRecentFolder}
      />
      <BookmarkModal
        isOpen={showBookmarks}
        onClose={() => setShowBookmarks(false)}
        bookmarks={bookmarks}
        onAdd={handleAddBookmark}
        onUpdate={handleUpdateBookmark}
        onDelete={handleDeleteBookmark}
        onExecute={handleExecuteBookmark}
      />

      {isMobile && (
        <>
          <MobileHeader
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onCreateSession={handleCreateSession}
            onOpenSettings={handleOpenSettings}
            onOpenBookmarks={() => setShowBookmarks(true)}
            keybarOpen={keybarOpen}
            onToggleKeybar={() => setKeybarOpen(!keybarOpen)}
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
                  ⚡ Terminal
                </button>
                <button
                  className={`mode-btn ${leftPanelMode === 'claude-code' ? 'active' : ''}`}
                  onClick={() => setLeftPanelMode('claude-code')}
                >
                  🤖 Claude
                </button>
              </div>
              {leftPanelMode === 'terminal' ? (
                <SessionSelector
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={handleSelectSession}
                  onRestoreSession={handleRestoreSession}
                  onCreateSession={handleCreateSession}
                  onCloseSession={handleCloseSession}
                  isLoading={loadingSessions}
                />
              ) : (
                <ClaudeCodeSessionSelector
                  sessions={claudeCodeSessions}
                  activeId={activeClaudeCodeId}
                  onSelect={handleSelectClaudeCode}
                  onNew={handleStartClaudeCode}
                  onDelete={handleDeleteClaudeCode}
                />
              )}
            </div>
            <div className="header-actions">
              <button
                className="header-btn"
                type="button"
                onClick={handleOpenSettings}
                aria-label="Settings"
                title="Settings"
              >
                {'\u2699'}
              </button>
              <button
                className={`header-btn${showPreview ? ' active' : ''}`}
                type="button"
                onClick={togglePreview}
                aria-label="Toggle Preview"
                title={showPreview ? 'Hide Preview' : 'Show Preview'}
              >
                {showPreview ? '\u25A6' : '\u25A3'}
              </button>
              <button
                className="header-btn"
                type="button"
                onClick={() => setShowBookmarks(true)}
                aria-label="Bookmarks"
                title="Bookmarks"
              >
                {'\u{1F4D1}'}
              </button>
              <span className="header-user" title={user?.username}>
                {user?.username}
              </span>
              <button
                className="header-btn logout-btn"
                type="button"
                onClick={logout}
                aria-label="Logout"
                title="Logout"
              >
                {'\u{1F6AA}'}
              </button>
            </div>
          </header>

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
              style={showPreview ? { flex: `0 0 ${splitPosition}%` } : undefined}
            >
              {leftPanelMode === 'terminal' ? (
                !activeSessionId ? (
                  <div className="empty-state">
                    <h2>Welcome to Terminal</h2>
                    <p>Create a new terminal session to get started.</p>
                    <button className="btn-primary" onClick={handleCreateSession}>
                      + New Terminal
                    </button>
                  </div>
                ) : (
                  <TerminalChat
                    sessionId={activeSessionId}
                    keybarOpen={keybarOpen}
                    viewportHeight={viewportHeight}
                    onUrlDetected={handleUrlDetected}
                  />
                )
              ) : (
                !activeClaudeCodeId ? (
                  <div className="empty-state">
                    <h2>Claude Code</h2>
                    <p>Start a new Claude Code session to get AI-powered assistance.</p>
                    <p className="empty-hint">Use /model to change models</p>
                    <button className="btn-primary" onClick={() => handleStartClaudeCode('sonnet')}>
                      + New Session
                    </button>
                  </div>
                ) : (
                  <ClaudeCodePanel
                    sessionId={activeClaudeCodeId}
                    cwd={claudeCodeSessions.find(s => s.id === activeClaudeCodeId)?.cwd}
                    model={claudeCodeSessions.find(s => s.id === activeClaudeCodeId)?.model}
                    recentFolders={recentFolders}
                    onFolderChange={handleClaudeCodeFolderChange}
                    onModelChange={handleClaudeCodeModelChange}
                    onSessionEnd={() => setLeftPanelMode('terminal')}
                  />
                )
              )}
            </div>

            {/* Preview pane */}
            {showPreview && (
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
            {/* Mobile view switcher */}
            {previewUrl && (
              <div className="mobile-view-switcher">
                <button
                  type="button"
                  className={`view-switch-btn${mobileView === 'terminal' ? ' active' : ''}`}
                  onClick={() => setMobileView('terminal')}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  className={`view-switch-btn${mobileView === 'preview' ? ' active' : ''}`}
                  onClick={() => setMobileView('preview')}
                >
                  Preview
                </button>
              </div>
            )}

            {/* Terminal pane */}
            <div className={`terminal-pane${mobileView === 'preview' ? ' hidden' : ''}`}>
              {!activeSessionId ? (
                <div className="empty-state">
                  <h2>Welcome to Terminal</h2>
                  <p>Create a new terminal session to get started.</p>
                </div>
              ) : (
                <TerminalChat
                  sessionId={activeSessionId}
                  keybarOpen={keybarOpen}
                  viewportHeight={viewportHeight}
                  onUrlDetected={handleUrlDetected}
                />
              )}
            </div>

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

  return <AppContent />;
}
