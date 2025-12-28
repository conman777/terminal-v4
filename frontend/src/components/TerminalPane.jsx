import { useRef } from 'react';
import { TerminalChat } from './TerminalChat';
import { TerminalMicButton } from './TerminalMicButton';

export function TerminalPane({
  pane,
  isActive,
  sessions,
  canSplit,
  canClose,
  onSessionSelect,
  onSplit,
  onClose,
  onFocus,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize
}) {
  const paneRef = useRef(null);

  const handlePaneClick = (e) => {
    // Only focus if clicking on the pane itself or terminal area, not controls
    if (!e.target.closest('.pane-controls')) {
      onFocus(pane.id);
    }
  };

  return (
    <div
      ref={paneRef}
      className={`split-terminal-pane ${isActive ? 'active' : ''}`}
      onClick={handlePaneClick}
    >
      <div className="pane-header">
        <select
          className="pane-session-select"
          value={pane.sessionId || ''}
          onChange={(e) => onSessionSelect(pane.id, e.target.value || null)}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">Select session...</option>
          {sessions.map(session => (
            <option key={session.id} value={session.id}>
              {session.title || `Session ${session.id.slice(0, 8)}`}
            </option>
          ))}
        </select>

        <div className="pane-controls">
          {canSplit && (
            <>
              <button
                className="pane-btn pane-split-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'horizontal'); }}
                title="Split horizontally"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1" y="2" width="5" height="10" rx="1" />
                  <rect x="8" y="2" width="5" height="10" rx="1" />
                </svg>
              </button>
              <button
                className="pane-btn pane-split-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'vertical'); }}
                title="Split vertically"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="1" width="10" height="5" rx="1" />
                  <rect x="2" y="8" width="10" height="5" rx="1" />
                </svg>
              </button>
            </>
          )}
          {canClose && (
            <button
              className="pane-btn pane-close"
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              title="Close pane"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="pane-content">
        {pane.sessionId ? (
          <div className="terminal-with-mic">
            <TerminalChat
              sessionId={pane.sessionId}
              keybarOpen={keybarOpen}
              viewportHeight={viewportHeight}
              onUrlDetected={onUrlDetected}
              fontSize={fontSize}
            />
            <TerminalMicButton sessionId={pane.sessionId} />
          </div>
        ) : (
          <div className="pane-empty">
            <p>Select a session above</p>
          </div>
        )}
      </div>
    </div>
  );
}
