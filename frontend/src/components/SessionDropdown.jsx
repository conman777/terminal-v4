import { useEffect, useState } from 'react';

export function SessionDropdown({
  isOpen,
  onClose,
  activeSessions,
  inactiveSessions,
  activeSessionId,
  onSelectSession,
  onRestoreSession,
  onCreateSession,
  onRenameSession,
  onCloseSession
}) {
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      setRenamingId(null);
      setRenameValue('');
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const startRename = (session) => {
    setRenamingId(session.id);
    setRenameValue(session.title);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const commitRename = async (sessionId) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      cancelRename();
      return;
    }
    const clipped = trimmed.slice(0, 60);
    await onRenameSession(sessionId, clipped);
    setRenamingId(null);
    setRenameValue('');
  };

  return (
    <>
      <div className={`session-dropdown-overlay${isOpen ? ' open' : ''}`} onClick={onClose}></div>
      <div className={`session-dropdown${isOpen ? ' open' : ''}`}>
        {activeSessions.length === 0 && (
          <div className="session-dropdown-empty">No active terminals</div>
        )}
        {activeSessions.map((session) => {
          const isRenaming = renamingId === session.id;
          return (
            <div
              key={session.id}
              className={`session-dropdown-item${session.id === activeSessionId ? ' active' : ''}`}
            >
              <button
                className="session-dropdown-select"
                onClick={() => {
                  if (isRenaming) return;
                  onSelectSession(session.id);
                  onClose();
                }}
                type="button"
              >
                <div className="session-dropdown-name">{session.title}</div>
                <div className="session-dropdown-meta">
                  {session.shell || 'Shell'} • {session.messageCount || 0} lines
                </div>
              </button>
              {isRenaming ? (
                <div className="session-dropdown-rename">
                  <input
                    className="session-dropdown-rename-input"
                    value={renameValue}
                    maxLength={60}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        commitRename(session.id);
                      }
                      if (e.key === 'Escape') {
                        cancelRename();
                      }
                    }}
                    autoFocus
                  />
                  <div className="session-dropdown-actions">
                    <button
                      type="button"
                      className="session-dropdown-action"
                      onClick={() => commitRename(session.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="session-dropdown-action muted"
                      onClick={cancelRename}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="session-dropdown-actions">
                  <button
                    type="button"
                    className="session-dropdown-action"
                    onClick={() => startRename(session)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="session-dropdown-action danger"
                    onClick={() => {
                      onCloseSession(session.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {inactiveSessions.length > 0 && <div className="session-dropdown-section">Inactive</div>}
        {inactiveSessions.map((session) => {
          const isRenaming = renamingId === session.id;
          return (
            <div key={session.id} className="session-dropdown-item inactive">
              <button
                className="session-dropdown-select"
                onClick={() => {
                  if (isRenaming) return;
                  onRestoreSession(session.id);
                  onClose();
                }}
                type="button"
              >
                <div className="session-dropdown-name">{session.title}</div>
                <div className="session-dropdown-meta">
                  {session.shell || 'Shell'} • {session.messageCount || 0} lines
                </div>
              </button>
              {isRenaming ? (
                <div className="session-dropdown-rename">
                  <input
                    className="session-dropdown-rename-input"
                    value={renameValue}
                    maxLength={60}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        commitRename(session.id);
                      }
                      if (e.key === 'Escape') {
                        cancelRename();
                      }
                    }}
                    autoFocus
                  />
                  <div className="session-dropdown-actions">
                    <button
                      type="button"
                      className="session-dropdown-action"
                      onClick={() => commitRename(session.id)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="session-dropdown-action muted"
                      onClick={cancelRename}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="session-dropdown-actions">
                  <button
                    type="button"
                    className="session-dropdown-action"
                    onClick={() => startRename(session)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="session-dropdown-action"
                    onClick={() => {
                      onRestoreSession(session.id);
                      onClose();
                    }}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="session-dropdown-action danger"
                    onClick={() => {
                      onCloseSession(session.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <button
          className="session-dropdown-new"
          onClick={() => {
            onCreateSession();
            onClose();
          }}
          type="button"
        >
          + New Session
        </button>
      </div>
    </>
  );
}
