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
  isLoading,
  sessionLoadError,
  onRetryLoad
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
    <div className="session-selector-modern" ref={dropdownRef}>
      <button
        type="button"
        className={`session-selector-btn-modern ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="session-selector-label-modern">
          {activeSession ? activeSession.title : 'No Terminal'}
        </span>
        <span className={`session-selector-arrow-modern ${isOpen ? 'open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className="session-selector-dropdown-modern">
          <div className="session-selector-list-modern">
            {isLoading && <div className="session-selector-empty-modern">Loading...</div>}
            {sessionLoadError && (
              <div className="session-selector-error-modern">
                <span>{sessionLoadError}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); onRetryLoad?.(); }}>
                  Retry
                </button>
              </div>
            )}
            {!isLoading && !sessionLoadError && activeSessions.length === 0 && (
              <div className="session-selector-empty-modern">No active terminals</div>
            )}
            {activeSessions.map((session) => {
              const isRenaming = renamingId === session.id;
              return (
                <div
                  key={session.id}
                  className={`session-selector-item-modern ${session.id === activeSessionId ? 'active' : ''}`}
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
                  <div className="session-selector-item-info-modern">
                    {isRenaming ? (
                      <input
                        className="session-selector-rename-input-modern"
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
                        <span className="session-selector-item-title-modern">{session.title}</span>
                        <span className="session-selector-item-shell-modern">{session.shell || 'Shell'}</span>
                      </>
                    )}
                  </div>
                  <div className="session-selector-item-actions-modern">
                    {isRenaming ? (
                      <>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern save"
                          onClick={(e) => commitRename(e, session.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern"
                          onClick={cancelRename}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern"
                          onClick={(e) => startRename(e, session)}
                          title="Rename"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern delete"
                          onClick={(e) => handleClose(e, session.id)}
                          aria-label="Close terminal"
                          title="Close"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {!isLoading && inactiveSessions.length > 0 && (
              <div className="session-selector-section-title-modern">Inactive</div>
            )}
            {inactiveSessions.map((session) => {
              const isRenaming = renamingId === session.id;
              return (
                <div
                  key={session.id}
                  className="session-selector-item-modern inactive"
                  onClick={() => {
                    if (!isRenaming) {
                      onRestoreSession(session.id);
                      setIsOpen(false);
                    }
                  }}
                  role="option"
                  tabIndex={0}
                >
                  <div className="session-selector-item-info-modern">
                    {isRenaming ? (
                      <input
                        className="session-selector-rename-input-modern"
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
                        <span className="session-selector-item-title-modern">
                          <span className="session-inactive-icon-modern">⏸</span>
                          {session.title}
                        </span>
                        <span className="session-selector-item-shell-modern">{session.shell || 'Shell'}</span>
                      </>
                    )}
                  </div>
                  <div className="session-selector-item-actions-modern">
                    {isRenaming ? (
                      <>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern save"
                          onClick={(e) => commitRename(e, session.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern"
                          onClick={cancelRename}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern restore"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRestoreSession(session.id);
                            setIsOpen(false);
                          }}
                          title="Restore"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="23 4 23 10 17 10" />
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern"
                          onClick={(e) => startRename(e, session)}
                          title="Rename"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="session-selector-action-btn-modern delete"
                          onClick={(e) => handleClose(e, session.id)}
                          aria-label="Delete terminal"
                          title="Delete"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
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
            className="session-selector-new-modern"
            onClick={() => {
              onCreateSession();
              setIsOpen(false);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Terminal
          </button>
        </div>
      )}

      <style>{`
        .session-selector-modern {
          position: relative;
          display: inline-block;
        }

        .session-selector-btn-modern {
          height: 32px;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 12px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          border-radius: 8px;
          color: var(--text-primary, #fafafa);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .session-selector-btn-modern:hover {
          border-color: var(--border-hover, #52525b);
          background: var(--bg-elevated, #1e1e21);
        }

        .session-selector-btn-modern.open {
          border-color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 2px var(--accent-primary-dim);
        }

        .session-selector-label-modern {
          max-width: 150px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .session-selector-arrow-modern {
          display: flex;
          align-items: center;
          opacity: 0.5;
          transition: transform 0.2s ease;
        }

        .session-selector-arrow-modern.open {
          transform: rotate(180deg);
          opacity: 1;
          color: var(--accent-primary, #f59e0b);
        }

        .session-selector-dropdown-modern {
          position: absolute;
          top: calc(100% + 8px);
          left: 0;
          width: 320px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          border-radius: 10px;
          box-shadow: var(--shadow-lg);
          z-index: 1000;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          animation: dropdownFadeIn 0.2s ease-out;
        }

        @keyframes dropdownFadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .session-selector-list-modern {
          max-height: 400px;
          overflow-y: auto;
          padding: 6px;
        }

        .session-selector-item-modern {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease;
          gap: 12px;
          margin-bottom: 2px;
        }

        .session-selector-item-modern:hover {
          background: var(--bg-elevated, #1e1e21);
        }

        .session-selector-item-modern.active {
          background: var(--accent-primary-dim);
        }

        .session-selector-item-info-modern {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .session-selector-item-title-modern {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #fafafa);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .session-selector-item-modern.active .session-selector-item-title-modern {
          color: var(--accent-primary, #f59e0b);
        }

        .session-selector-item-shell-modern {
          font-size: 11px;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .session-selector-item-actions-modern {
          display: flex;
          align-items: center;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.15s ease;
        }

        .session-selector-item-modern:hover .session-selector-item-actions-modern,
        .session-selector-item-modern.active .session-selector-item-actions-modern {
          opacity: 1;
        }

        .session-selector-action-btn-modern {
          width: 26px;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          color: var(--text-muted, #71717a);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .session-selector-action-btn-modern:hover {
          background: var(--bg-elevated, #1e1e21);
          color: var(--text-primary, #fafafa);
          border-color: var(--border-default, #2a2a2e);
        }

        .session-selector-action-btn-modern.delete:hover {
          background: rgba(244, 63, 94, 0.15);
          color: var(--error, #f43f5e);
          border-color: rgba(244, 63, 94, 0.2);
        }

        .session-selector-action-btn-modern.restore:hover {
          background: rgba(16, 185, 129, 0.15);
          color: var(--success, #10b981);
          border-color: rgba(16, 185, 129, 0.2);
        }

        .session-selector-action-btn-modern.save {
          background: var(--accent-primary, #f59e0b);
          color: var(--bg-primary, #0a0a0c);
          border: none;
          width: auto;
          padding: 0 8px;
          font-size: 11px;
          font-weight: 700;
        }

        .session-selector-rename-input-modern {
          width: 100%;
          height: 24px;
          background: var(--bg-primary, #0a0a0c);
          border: 1px solid var(--accent-primary, #f59e0b);
          border-radius: 4px;
          color: var(--text-primary, #fafafa);
          font-size: 12px;
          padding: 0 6px;
          outline: none;
        }

        .session-selector-section-title-modern {
          padding: 10px 10px 6px;
          font-size: 10px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .session-selector-new-modern {
          width: 100%;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          background: var(--bg-elevated, #1e1e21);
          border: none;
          border-top: 1px solid var(--border-subtle, #1e1e21);
          color: var(--accent-primary, #f59e0b);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s ease;
        }

        .session-selector-new-modern:hover {
          background: var(--bg-surface, #141416);
        }

        .session-inactive-icon-modern {
          opacity: 0.5;
          font-size: 10px;
        }

        .session-selector-empty-modern {
          padding: 20px;
          text-align: center;
          color: var(--text-muted, #71717a);
          font-style: italic;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

export default SessionSelector;
