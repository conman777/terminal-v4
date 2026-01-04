import { TerminalMicButton } from './TerminalMicButton';

export function MobileStatusBar({ sessionId, onImageUpload }) {
  return (
    <div className="mobile-status-bar">
      <div className="mobile-status-left">
        <span className="status-dot connected" />
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
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>

        {/* Mic button */}
        <TerminalMicButton sessionId={sessionId} inline />
      </div>
    </div>
  );
}
