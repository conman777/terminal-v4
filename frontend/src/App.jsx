import { useCallback, useEffect, useState } from 'react';
import { TerminalChat } from './components/TerminalChat';
import { BookmarkModal } from './components/BookmarkModal';

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

function TerminalSidebar({ sessions, activeSessionId, onSelectSession, onCreateSession, onCloseSession, onOpenSettings, isLoading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <h1>Terminals</h1>
          <span className="sidebar-subtitle">Web Shell</span>
        </div>
        <div className="sidebar-actions">
          <button
            className="sidebar-settings"
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            ⚙
          </button>
          <button className="sidebar-new" type="button" onClick={onCreateSession}>
            New
          </button>
        </div>
      </div>
      <div className="session-list">
        {isLoading && <div className="session-placeholder">Loading terminals…</div>}
        {!isLoading && sessions.length === 0 && <div className="session-placeholder">No terminals yet</div>}
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`session-card${session.id === activeSessionId ? ' active' : ''}`}
          >
            <button
              type="button"
              className="session-card-content"
              onClick={() => onSelectSession(session.id)}
            >
              <div className="session-title">{session.title}</div>
              <div className="session-preview">
                {session.shell || 'Unknown shell'}
              </div>
              <div className="session-meta">
                <span>{session.messageCount || 0} lines</span>
                <span>{new Date(session.createdAt).toLocaleTimeString()}</span>
              </div>
            </button>
            <button
              type="button"
              className="session-close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession(session.id);
              }}
              aria-label="Close terminal"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [showBookmarks, setShowBookmarks] = useState(false);

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

  useEffect(() => {
    loadSessions();
    loadBookmarks();
    // Reload sessions every 5 seconds to keep list fresh
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions, loadBookmarks]);

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
    },
    []
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

  return (
    <div className="layout">
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
      <TerminalSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onCloseSession={handleCloseSession}
        onOpenSettings={handleOpenSettings}
        isLoading={loadingSessions}
      />
      <div className="main-pane">
        <header className="app-header">
          <div>
            <h2>Web Terminal</h2>
            {activeSessionId && sessions.length > 0 && (
              <span className="badge">
                {sessions.find((s) => s.id === activeSessionId)?.title || 'Terminal'}
              </span>
            )}
          </div>
          <div className="header-actions">
            <button
              className="header-btn"
              type="button"
              onClick={() => setShowBookmarks(true)}
              aria-label="Bookmarks"
              title="Bookmarks"
            >
              📑
            </button>
          </div>
        </header>

        <main className="terminal-main">
          {!activeSessionId ? (
            <div className="empty-state">
              <h2>Welcome to Web Terminal</h2>
              <p>Create a new terminal session to get started. Click the "New" button in the sidebar or use the terminal to run shell commands.</p>
            </div>
          ) : (
            <TerminalChat sessionId={activeSessionId} />
          )}
        </main>
      </div>
    </div>
  );
}
