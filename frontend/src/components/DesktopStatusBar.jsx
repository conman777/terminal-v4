import { TerminalMicButton } from './TerminalMicButton';
import { useAutocorrect } from '../contexts/AutocorrectContext';
import { getAiDisplayLabel } from '../utils/aiProviders';

/**
 * Desktop status bar at the bottom of the terminal pane.
 * Shows connection status, current directory, git branch, and action buttons.
 */
export function DesktopStatusBar({
  sessionId,
  sessionTitle,
  cwd,
  gitBranch,
  onImageUpload,
  isTerminalPanelOpen = false,
  showTerminalToggle = true,
  onToggleTerminalPanel,
  connectionState = 'connecting',
  aiType = null
}) {
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();

  // Extract folder name from cwd, fall back to session title
  const normalizedCwd = typeof cwd === 'string' ? cwd.replace(/\\/g, '/') : '';
  const folderName = normalizedCwd ? normalizedCwd.split('/').filter(Boolean).pop() || normalizedCwd : '';
  const displayName = folderName || sessionTitle || '';
  const aiLabel = getAiDisplayLabel(aiType);

  const connectionLabel = connectionState === 'online'
    ? 'Online'
    : connectionState === 'offline'
      ? 'Offline'
      : 'Connecting';

  return (
    <div className="desktop-status-bar">
      <div className="status-bar-left">
        <span className={`status-connection ${connectionState}`} title={connectionLabel}>
          {connectionLabel}
        </span>
        {displayName && (
          <span className="status-cwd" title={cwd || sessionTitle}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            {displayName}
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
        {aiLabel && (
          <span className="status-ai-chip ultra-minimal" title={`Assistant: ${aiLabel}`}>
            <span style={{width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--accent-primary)', opacity: 0.6}}></span>
            {aiLabel.toLowerCase()}
          </span>
        )}
      </div>

      <div className="status-bar-right">
        {showTerminalToggle && (
          <button
            type="button"
            className={`status-terminal-toggle ${isTerminalPanelOpen ? 'active' : ''}`}
            onClick={onToggleTerminalPanel}
            disabled={!onToggleTerminalPanel}
            aria-label={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
            title={isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
          >
            {isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
          </button>
        )}

        {/* Autocorrect toggle button */}
        <button
          type="button"
          className={`status-bar-btn ${autocorrectEnabled ? 'active' : ''}`}
          onClick={toggleAutocorrect}
          aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
          title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
        >
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>ABC</span>
        </button>

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

        {/* Mic buttons - local Whisper + Groq cloud */}
        <TerminalMicButton sessionId={sessionId} provider="local" inline />
        <TerminalMicButton sessionId={sessionId} provider="groq" inline />
      </div>
    </div>
  );
}
