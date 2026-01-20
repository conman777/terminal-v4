import { useState, useEffect } from 'react';
import { apiFetch } from '../../utils/api';

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  return `${hours}h ago`;
}

export function SessionSwitcher({ onClose }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newSessionName, setNewSessionName] = useState('');
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);

  const fetchSessions = async () => {
    try {
      const response = await apiFetch('/api/browser/sessions');
      setSessions(response.sessions || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
    // Refresh sessions every 5 seconds
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateSession = async () => {
    if (!newSessionName.trim()) {
      setError('Session name is required');
      return;
    }

    try {
      await apiFetch('/api/browser/sessions', {
        method: 'POST',
        body: JSON.stringify({ name: newSessionName })
      });
      setNewSessionName('');
      setShowNewSessionForm(false);
      await fetchSessions();
    } catch (err) {
      setError(err.message || 'Failed to create session');
    }
  };

  const handleSwitchSession = async (sessionId) => {
    try {
      await apiFetch(`/api/browser/sessions/${sessionId}/switch`, {
        method: 'PUT'
      });
      await fetchSessions();
    } catch (err) {
      setError(err.message || 'Failed to switch session');
    }
  };

  const handleCloseSession = async (sessionId, e) => {
    e.stopPropagation();
    try {
      await apiFetch(`/api/browser/sessions/${sessionId}`, {
        method: 'DELETE'
      });
      await fetchSessions();
    } catch (err) {
      setError(err.message || 'Failed to close session');
    }
  };

  if (loading) {
    return (
      <div className="session-switcher-modal">
        <div className="session-switcher-header">
          <h3>Browser Sessions</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="session-switcher-loading">Loading sessions...</div>
      </div>
    );
  }

  return (
    <div className="session-switcher-modal">
      <div className="session-switcher-header">
        <h3>Browser Sessions</h3>
        <button
          className="new-session-button"
          onClick={() => setShowNewSessionForm(!showNewSessionForm)}
        >
          + New Session
        </button>
        <button className="close-button" onClick={onClose}>×</button>
      </div>

      {error && (
        <div className="session-switcher-error">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {showNewSessionForm && (
        <div className="new-session-form">
          <input
            type="text"
            placeholder="Session name..."
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateSession()}
            autoFocus
          />
          <button onClick={handleCreateSession}>Create</button>
          <button onClick={() => setShowNewSessionForm(false)}>Cancel</button>
        </div>
      )}

      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="no-sessions">
            No active sessions. Create a new session to get started.
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.isActive ? 'active' : ''}`}
              onClick={() => !session.isActive && handleSwitchSession(session.id)}
            >
              <div className="session-info">
                <div className="session-name">{session.name}</div>
                <div className="session-url">{session.currentUrl || 'about:blank'}</div>
                <div className="session-meta">
                  <span>Created: {formatTime(session.createdAt)}</span>
                  <span>Last activity: {formatRelativeTime(session.lastActivity)}</span>
                  <span>{session.logCount} logs</span>
                </div>
              </div>
              <div className="session-actions">
                {session.isActive && (
                  <span className="active-badge">Active</span>
                )}
                <button
                  className="close-session-button"
                  onClick={(e) => handleCloseSession(session.id, e)}
                  title="Close session"
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <style jsx>{`
        .session-switcher-modal {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          width: 600px;
          max-width: 90vw;
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          z-index: 10000;
        }

        .session-switcher-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .session-switcher-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          flex: 1;
        }

        .new-session-button {
          padding: 8px 16px;
          background: var(--accent-color, #007acc);
          border: none;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }

        .new-session-button:hover {
          background: var(--accent-hover, #0066b3);
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-primary, #d4d4d4);
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
        }

        .session-switcher-loading {
          padding: 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .session-switcher-error {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: rgba(255, 0, 0, 0.1);
          border-bottom: 1px solid rgba(255, 0, 0, 0.3);
          color: #ff6b6b;
          font-size: 13px;
        }

        .session-switcher-error button {
          background: none;
          border: none;
          color: #ff6b6b;
          font-size: 20px;
          cursor: pointer;
          padding: 0 8px;
        }

        .new-session-form {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #2a2a2a);
        }

        .new-session-form input {
          flex: 1;
          padding: 8px 12px;
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          font-size: 14px;
        }

        .new-session-form button {
          padding: 8px 16px;
          background: var(--accent-color, #007acc);
          border: none;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }

        .new-session-form button:last-child {
          background: var(--bg-secondary, #2a2a2a);
          color: var(--text-primary, #d4d4d4);
          border: 1px solid var(--border-color, #3a3a3a);
        }

        .new-session-form button:hover {
          opacity: 0.9;
        }

        .session-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }

        .no-sessions {
          padding: 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .session-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px;
          margin-bottom: 8px;
          background: var(--bg-secondary, #2a2a2a);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .session-item:hover {
          background: var(--bg-hover, #333);
          border-color: var(--accent-color, #007acc);
        }

        .session-item.active {
          background: rgba(0, 122, 204, 0.1);
          border-color: var(--accent-color, #007acc);
          cursor: default;
        }

        .session-info {
          flex: 1;
          min-width: 0;
        }

        .session-name {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 4px;
          color: var(--text-primary, #d4d4d4);
        }

        .session-url {
          font-size: 12px;
          color: var(--text-secondary, #999);
          margin-bottom: 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .session-meta {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: var(--text-tertiary, #666);
        }

        .session-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: 12px;
        }

        .active-badge {
          padding: 4px 8px;
          background: var(--accent-color, #007acc);
          color: white;
          border-radius: 3px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .close-session-button {
          padding: 4px;
          width: 24px;
          height: 24px;
          background: none;
          border: none;
          color: var(--text-secondary, #999);
          cursor: pointer;
          font-size: 20px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .close-session-button:hover {
          background: rgba(255, 0, 0, 0.2);
          color: #ff6b6b;
        }
      `}</style>
    </div>
  );
}
