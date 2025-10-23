import { useCallback, useEffect, useState } from 'react';
import { TerminalChat } from './components/TerminalChat';

function TerminalSidebar({ sessions, activeSessionId, onSelectSession, onCreateSession, isLoading }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <h1>Terminals</h1>
          <span className="sidebar-subtitle">Web Shell</span>
        </div>
        <button className="sidebar-new" type="button" onClick={onCreateSession}>
          New
        </button>
      </div>
      <div className="session-list">
        {isLoading && <div className="session-placeholder">Loading terminals…</div>}
        {!isLoading && sessions.length === 0 && <div className="session-placeholder">No terminals yet</div>}
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`session-card${session.id === activeSessionId ? ' active' : ''}`}
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
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(false);

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

  useEffect(() => {
    loadSessions();
    // Reload sessions every 5 seconds to keep list fresh
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const handleCreateSession = useCallback(async () => {
    try {
      const response = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
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
  }, [loadSessions]);

  const handleSelectSession = useCallback(
    (sessionId) => {
      setActiveSessionId(sessionId);
    },
    []
  );

  return (
    <div className="layout">
      <TerminalSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
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
