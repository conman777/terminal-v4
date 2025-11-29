import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { BookmarkModal } from './components/BookmarkModal';
import { MobileHeader } from './components/MobileHeader';
import { MobileKeybar } from './components/MobileKeybar';
import { PreviewPanel } from './components/PreviewPanel';
import { useMobileDetect } from './hooks/useMobileDetect';
import { useViewportHeight } from './hooks/useViewportHeight';

function SettingsModal({ isOpen, onClose, settings, onSave }) {
  const [workingDir, setWorkingDir] = useState(settings.workingDir || '');

  const handleSave = () => {
    onSave({ workingDir });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="working-dir">Default Working Directory</label>
            <input
              id="working-dir"
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="e.g., C:\Users\YourName\Projects or /home/user/projects"
            />
            <small>Leave empty to use the backend's default directory</small>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
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

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
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
  const mainContentRef = useRef(null);
  const isMobile = useMobileDetect();
  const viewportHeight = useViewportHeight();

  // Load settings from localStorage
  const [settings, setSettings] = useState(() => {
    try {
      const stored = localStorage.getItem('terminalSettings');
      return stored ? JSON.parse(stored) : { workingDir: '' };
    } catch {
      return { workingDir: '' };
    }
  });

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const response = await fetch('/api/terminal');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }

      const data = await response.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (error) {
      console.error('Failed to load sessions', error);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const loadBookmarks = useCallback(async () => {
    try {
      const response = await fetch('/api/bookmarks');
      if (!response.ok) {
        throw new Error(`Failed to load bookmarks (${response.status})`);
      }

      const data = await response.json();
      setBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
    } catch (error) {
      console.error('Failed to load bookmarks', error);
    }
  }, []);

  const handleAddBookmark = useCallback(
    async (name, command, category) => {
      try {
        const response = await fetch('/api/bookmarks', {
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
        const response = await fetch(`/api/bookmarks/${id}`, {
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
        const response = await fetch(`/api/bookmarks/${id}`, {
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
        await fetch(`/api/terminal/${activeSessionId}/input`, {
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

  // Initial load - check for last active session and auto-restore if available
  useEffect(() => {
    const initializeSessions = async () => {
      await loadSessions();
      await loadBookmarks();

      // Try to restore last active session
      try {
        const lastSessionId = localStorage.getItem('lastActiveSession');
        if (lastSessionId) {
          // Fetch fresh session list to check if this session exists
          const response = await fetch('/api/terminal');
          if (response.ok) {
            const data = await response.json();
            const sessionList = Array.isArray(data.sessions) ? data.sessions : [];
            const lastSession = sessionList.find(s => s.id === lastSessionId);

            if (lastSession) {
              if (lastSession.isActive) {
                // Session is already active, just select it
                setActiveSessionId(lastSessionId);
              } else {
                // Session is persisted but not active, restore it
                const restoreResponse = await fetch(`/api/terminal/${lastSessionId}/restore`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({})
                });
                if (restoreResponse.ok) {
                  setActiveSessionId(lastSessionId);
                  await loadSessions();
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to restore last session', error);
      }
    };

    initializeSessions();

    // Reload sessions every 5 seconds to keep list fresh
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions, loadBookmarks]);

  // Poll for project info when there's an active session
  useEffect(() => {
    if (!activeSessionId) {
      setProjectInfo(null);
      return;
    }

    const fetchProjectInfo = async () => {
      try {
        const response = await fetch(`/api/terminal/${activeSessionId}/project-info`);
        if (response.ok) {
          const data = await response.json();
          setProjectInfo(data);
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
  }, [activeSessionId]);

  const handleCreateSession = useCallback(async () => {
    try {
      const requestBody = {};
      if (settings.workingDir) {
        requestBody.cwd = settings.workingDir;
      }

      const response = await fetch('/api/terminal', {
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
  }, [loadSessions, settings.workingDir]);

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
        const response = await fetch(`/api/terminal/${sessionId}/restore`, {
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
        await fetch(`/api/terminal/${sessionId}`, {
          method: 'DELETE'
        });

        // If we just closed the active terminal, switch to another one or clear
        if (sessionId === activeSessionId) {
          const remainingSessions = sessions.filter((s) => s.id !== sessionId);
          if (remainingSessions.length > 0) {
            setActiveSessionId(remainingSessions[0].id);
          } else {
            setActiveSessionId(null);
          }
        }

        // Reload the session list
        await loadSessions();
      } catch (error) {
        console.error('Failed to close session', error);
      }
    },
    [activeSessionId, sessions, loadSessions]
  );

  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const handleSaveSettings = useCallback((newSettings) => {
    setSettings(newSettings);
    try {
      localStorage.setItem('terminalSettings', JSON.stringify(newSettings));
    } catch (error) {
      console.error('Failed to save settings', error);
    }
  }, []);

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
      await fetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command + '\r' })
      });
    } catch (error) {
      console.error('Failed to run command', error);
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
        settings={settings}
        onSave={handleSaveSettings}
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

      {/* Desktop layout - no sidebar, header with session selector */}
      {!isMobile && (
        <div className="main-container">
          <header className="app-header">
            <div className="header-left">
              <h1 className="app-title">Terminal</h1>
              <SessionSelector
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelectSession={handleSelectSession}
                onRestoreSession={handleRestoreSession}
                onCreateSession={handleCreateSession}
                onCloseSession={handleCloseSession}
                isLoading={loadingSessions}
              />
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
            </div>
          </header>

          <main
            ref={mainContentRef}
            className={`main-content${showPreview ? ' with-preview' : ''}${isDragging ? ' dragging' : ''}`}
          >
            {/* Terminal pane */}
            <div
              className="terminal-pane"
              style={showPreview ? { flex: `0 0 ${splitPosition}%` } : undefined}
            >
              {!activeSessionId ? (
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
