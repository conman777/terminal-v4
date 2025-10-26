import { useState } from 'react';
import { SessionDropdown } from './SessionDropdown';
import { MobileDrawer } from './MobileDrawer';

export function MobileHeader({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onOpenSettings,
  onOpenBookmarks,
  keybarOpen,
  onToggleKeybar
}) {
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const sessionName = activeSession?.title || 'No Session';

  return (
    <>
      <header className="mobile-header">
        <button className="mobile-header-btn" onClick={() => setShowDrawer(true)} aria-label="Menu" type="button">
          ☰
        </button>

        <button
          className="mobile-header-session"
          onClick={() => setShowSessionDropdown(true)}
          aria-label="Select session"
          type="button"
        >
          {sessionName} ▾
        </button>

        <div className="mobile-header-actions">
          <button
            className="mobile-header-btn"
            onClick={onToggleKeybar}
            aria-label={keybarOpen ? 'Hide keyboard' : 'Show keyboard'}
            type="button"
          >
            {keybarOpen ? '✕' : '⌨'}
          </button>
          <button className="mobile-header-btn" onClick={onOpenBookmarks} aria-label="Bookmarks" type="button">
            📑
          </button>
        </div>
      </header>

      <SessionDropdown
        isOpen={showSessionDropdown}
        onClose={() => setShowSessionDropdown(false)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
      />

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}
