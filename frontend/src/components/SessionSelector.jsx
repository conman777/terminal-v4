import { useState, useRef, useEffect } from 'react';

export function SessionSelector({
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

export default SessionSelector;
