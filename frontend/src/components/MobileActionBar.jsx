/**
 * Floating action bar for mobile view.
 * Provides quick access to common terminal actions.
 */
export function MobileActionBar({
  onToggleKeybar,
  keybarOpen,
  onScrollToLive,
  onOpenMic,
  sessionId
}) {
  return (
    <div className="mobile-action-bar">
      <button
        type="button"
        className="action-bar-btn"
        onClick={onToggleKeybar}
        aria-label={keybarOpen ? 'Hide keyboard' : 'Show keyboard'}
      >
        {keybarOpen ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
            <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="action-bar-btn primary"
        onClick={onScrollToLive}
        aria-label="Jump to live output"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>Live</span>
      </button>

      <button
        type="button"
        className="action-bar-btn"
        onClick={onOpenMic}
        aria-label="Voice input"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
    </div>
  );
}
