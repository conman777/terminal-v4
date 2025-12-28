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
                className="pane-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'horizontal'); }}
                title="Split horizontally"
              >
                ⬜|⬜
              </button>
              <button
                className="pane-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'vertical'); }}
                title="Split vertically"
              >
                ⬜/⬜
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
