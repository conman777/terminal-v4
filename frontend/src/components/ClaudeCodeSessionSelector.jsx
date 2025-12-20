import { useState, useRef, useEffect } from 'react';

export default function ClaudeCodeSessionSelector({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const activeSession = sessions.find(s => s.id === activeId);
  const activeIndex = sessions.findIndex(s => s.id === activeId);

  return (
    <div className="claude-session-selector" ref={dropdownRef}>
      <button
        className="session-dropdown-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <span className="session-icon">🤖</span>
        <span className="session-label">
          {activeSession ? `CC ${activeIndex + 1}` : 'Claude Code'}
        </span>
        <span className="dropdown-arrow">{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div className="session-dropdown claude-dropdown">
          <button className="new-session-btn" type="button" onClick={() => { onNew(); setIsOpen(false); }}>
            + New Claude Code Session
          </button>

          {sessions.length > 0 && <div className="dropdown-divider" />}

          {sessions.map((session, index) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeId ? 'active' : ''}`}
            >
              <button
                className="session-select-btn"
                onClick={() => { onSelect(session.id); setIsOpen(false); }}
                type="button"
              >
                <span className={`status-dot ${session.isActive ? 'active' : 'inactive'}`} />
                <span>Claude Code {index + 1}</span>
                <span className="session-meta">
                  {session.events?.length || 0} messages
                </span>
              </button>
              <button
                className="session-delete-btn"
                onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                aria-label="Delete Claude Code session"
                type="button"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

