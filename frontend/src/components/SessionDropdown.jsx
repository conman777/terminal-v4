import { useEffect } from 'react';

export function SessionDropdown({ isOpen, onClose, sessions, activeSessionId, onSelectSession, onCreateSession }) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  return (
    <>
      <div className={`session-dropdown-overlay${isOpen ? ' open' : ''}`} onClick={onClose}></div>
      <div className={`session-dropdown${isOpen ? ' open' : ''}`}>
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session-dropdown-item${session.id === activeSessionId ? ' active' : ''}`}
            onClick={() => {
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
        ))}
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
