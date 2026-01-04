import { TerminalMicButton } from './TerminalMicButton';

/**
 * Desktop status bar at the bottom of the terminal pane.
 * Shows connection status, current directory, git branch, and action buttons.
 */
export function DesktopStatusBar({
  sessionId,
  cwd,
  gitBranch,
  onImageUpload,
  isConnected = true
}) {
  // Extract folder name from cwd
  const folderName = cwd ? cwd.split('/').pop() || cwd : '';

  return (
    <div className="desktop-status-bar">
      <div className="status-bar-left">
        <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
        {folderName && (
          <span className="status-cwd" title={cwd}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {folderName}
          </span>
        )}
        {gitBranch && (
          <span className="status-git-branch" title={`Branch: ${gitBranch}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {gitBranch}
          </span>
        )}
      </div>

      <div className="status-bar-right">
        {/* Image upload button */}
        <button
          type="button"
          className="status-bar-btn"
          onClick={onImageUpload}
          disabled={!onImageUpload}
          aria-label="Upload image"
          title="Upload image"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
