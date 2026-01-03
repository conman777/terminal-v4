import { TerminalMicButton } from './TerminalMicButton';

export function MobileStatusBar({ sessionId, onImageUpload }) {
  return (
    <div className="mobile-status-bar">
      <div className="mobile-status-left">
        <span className="status-dot connected" />
        <span className="status-text">Terminal</span>
      </div>

      <div className="mobile-status-right">
        {/* Image upload button */}
        <button
          type="button"
          className="status-bar-btn"
          onClick={onImageUpload}
          disabled={!onImageUpload}
          aria-label="Upload image"
          title="Upload image"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>

        {/* Mic button */}
        <TerminalMicButton sessionId={sessionId} inline />
      </div>
    </div>
  );
}
