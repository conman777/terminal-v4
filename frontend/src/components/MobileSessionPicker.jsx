import { useEffect, useMemo, useRef, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

const SWIPE_CLOSE_THRESHOLD = 64;
const SWIPE_AXIS_BIAS = 16;

function formatRelativeTime(timestamp) {
  if (!timestamp) return null;

  const now = Date.now();
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = now - time;
  if (!Number.isFinite(diff)) return null;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(days / 7)}w ago`;
}

export function MobileSessionPicker({
  isOpen,
  onClose,
  sessions = [],
  activeSessionId,
  sessionActivity,
  sessionAiTypes,
  onSelectSession
}) {
  const [query, setQuery] = useState('');
  const touchStartRef = useRef(null);

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const filteredSessions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sessions;
    return sessions.filter((session) => (session.title || 'Terminal').toLowerCase().includes(trimmed));
  }, [query, sessions]);

  const handleTouchStart = (event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event) => {
    const origin = touchStartRef.current;
    touchStartRef.current = null;
    if (!origin) return;

    const touch = event.changedTouches?.[0];
    if (!touch) return;

    const deltaX = touch.clientX - origin.x;
    const deltaY = touch.clientY - origin.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const isDownSwipe = deltaY >= SWIPE_CLOSE_THRESHOLD && absY > absX + SWIPE_AXIS_BIAS;
    if (isDownSwipe) {
      onClose?.();
    }
  };

  const handleTouchCancel = () => {
    touchStartRef.current = null;
  };

  const handleSelectSession = (sessionId) => {
    onSelectSession?.(sessionId);
    onClose?.();
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="mobile-session-picker-overlay open"
        aria-hidden="true"
        onClick={() => onClose?.()}
      />
      <div
        className="mobile-session-picker-sheet open"
        role="dialog"
        aria-modal="true"
        aria-label="Session picker"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        <div className="mobile-session-picker-handle" aria-hidden="true" />
        <div className="mobile-session-picker-header">
          <h2>Jump to session</h2>
          <button
            type="button"
            className="mobile-session-picker-close"
            onClick={() => onClose?.()}
            aria-label="Close session picker"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {sessions.length > 6 && (
          <div className="mobile-session-picker-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions..."
              aria-label="Search sessions"
            />
          </div>
        )}

        <div className="mobile-session-picker-list">
          {filteredSessions.length === 0 ? (
            <div className="mobile-session-picker-empty">No sessions found</div>
          ) : (
            filteredSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const activity = sessionActivity?.[session.id];
              const isBusy = typeof session?.isBusy === 'boolean'
                ? session.isBusy
                : Boolean(activity?.isBusy);
              const lastActivity = activity?.lastActivity || session.updatedAt;
              const relativeTime = formatRelativeTime(lastActivity);
              const aiType = sessionAiTypes?.[session.id] || null;

              return (
                <button
                  key={session.id}
                  type="button"
                  className={`mobile-session-picker-item${isActive ? ' active' : ''}`}
                  onClick={() => handleSelectSession(session.id)}
                >
                  <div className="mobile-session-picker-item-main">
                    <div className="mobile-session-picker-item-title">{session.title || 'Terminal'}</div>
                    <div className="mobile-session-picker-item-meta">
                      <span className={`mobile-session-picker-ai-dot${aiType ? ` ai-${aiType}` : ''}`} />
                      <span className={`mobile-session-picker-item-status ${isBusy ? 'busy' : 'idle'}`}>
                        {isBusy ? 'Busy' : 'Idle'}
                      </span>
                      {relativeTime && (
                        <span className="mobile-session-picker-item-time">{relativeTime}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
