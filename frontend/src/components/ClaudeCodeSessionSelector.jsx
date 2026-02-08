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
    <div className="claude-selector-modern" ref={dropdownRef}>
      <button
        className={`claude-selector-btn-modern ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <span className="claude-icon-modern">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
        </span>
        <span className="claude-label-modern">
          {activeSession ? `Claude ${activeIndex + 1}` : 'Claude Code'}
        </span>
        <span className={`claude-arrow-modern ${isOpen ? 'open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className="claude-dropdown-modern">
          <div className="claude-list-modern">
            {sessions.map((session, index) => {
              const messageCount = session.messageCount ?? session.events?.length ?? 0;
              return (
                <div
                  key={session.id}
                  className={`claude-item-modern ${session.id === activeId ? 'active' : ''}`}
                  onClick={() => { onSelect(session.id); setIsOpen(false); }}
                >
                  <div className="claude-item-info-modern">
                    <span className="claude-item-title-modern">
                      <span className={`status-dot-modern ${session.isActive ? 'active' : 'inactive'}`} />
                      Claude Code {index + 1}
                    </span>
                    <span className="claude-item-meta-modern">
                      {messageCount} events
                    </span>
                  </div>
                  <button
                    className="claude-delete-btn-modern"
                    onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                    aria-label="Delete session"
                    title="Delete"
                    type="button"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
            
            {sessions.length === 0 && (
              <div className="claude-empty-modern">No active sessions</div>
            )}
          </div>

          <button 
            className="claude-new-btn-modern" 
            type="button" 
            onClick={() => { onNew(); setIsOpen(false); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Claude Session
          </button>
        </div>
      )}

      <style jsx>{`
        .claude-selector-modern {
          position: relative;
          display: inline-block;
        }

        .claude-selector-btn-modern {
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

        .claude-selector-btn-modern:hover {
          border-color: var(--border-hover, #52525b);
          background: var(--bg-elevated, #1e1e21);
        }

        .claude-selector-btn-modern.open {
          border-color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 2px var(--accent-primary-dim);
        }

        .claude-icon-modern {
          display: flex;
          align-items: center;
          color: var(--accent-primary, #f59e0b);
        }

        .claude-label-modern {
          white-space: nowrap;
        }

        .claude-arrow-modern {
          display: flex;
          align-items: center;
          opacity: 0.5;
          transition: transform 0.2s ease;
        }

        .claude-arrow-modern.open {
          transform: rotate(180deg);
          opacity: 1;
          color: var(--accent-primary, #f59e0b);
        }

        .claude-dropdown-modern {
          position: absolute;
          top: calc(100% + 8px);
          left: 0;
          width: 240px;
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

        .claude-list-modern {
          max-height: 300px;
          overflow-y: auto;
          padding: 6px;
        }

        .claude-item-modern {
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

        .claude-item-modern:hover {
          background: var(--bg-elevated, #1e1e21);
        }

        .claude-item-modern.active {
          background: var(--accent-primary-dim);
        }

        .claude-item-info-modern {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .claude-item-title-modern {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #fafafa);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .claude-item-modern.active .claude-item-title-modern {
          color: var(--accent-primary, #f59e0b);
        }

        .status-dot-modern {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .status-dot-modern.active {
          background: var(--success, #10b981);
          box-shadow: 0 0 8px var(--success);
        }

        .status-dot-modern.inactive {
          background: var(--text-muted, #71717a);
        }

        .claude-item-meta-modern {
          font-size: 11px;
          color: var(--text-muted, #71717a);
          margin-left: 14px;
        }

        .claude-delete-btn-modern {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
          opacity: 0;
        }

        .claude-item-modern:hover .claude-delete-btn-modern {
          opacity: 1;
        }

        .claude-delete-btn-modern:hover {
          background: rgba(244, 63, 94, 0.15);
          color: var(--error, #f43f5e);
        }

        .claude-new-btn-modern {
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

        .claude-new-btn-modern:hover {
          background: var(--bg-surface, #141416);
        }

        .claude-empty-modern {
          padding: 16px;
          text-align: center;
          color: var(--text-muted, #71717a);
          font-style: italic;
          font-size: 12px;
        }
      `}</style>
    </div>
  );
}
