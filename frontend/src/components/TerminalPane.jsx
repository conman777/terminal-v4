import { useRef, useState, useCallback, memo } from 'react';
import { TerminalChat } from './TerminalChat';
import { DesktopStatusBar } from './DesktopStatusBar';

export const TerminalPane = memo(function TerminalPane({
  pane,
  isActive,
  isFullscreen,
  sessions,
  canSplit,
  canClose,
  onSessionSelect,
  onSplit,
  onClose,
  onFocus,
  onFullscreen,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  sessionActivity,
  projectInfo
}) {
  const paneRef = useRef(null);
  const imageInputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);

  const currentSession = sessions.find(s => s.id === pane.sessionId);

  const handlePaneClick = (e) => {
    // Only focus if clicking on the pane itself or terminal area, not controls
    if (!e.target.closest('.pane-controls') && !e.target.closest('.pane-session-menu')) {
      onFocus(pane.id);
    }
  };

  // Drag-drop handlers for session assignment
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const sessionId = e.dataTransfer.getData('session-id');
    if (sessionId) {
      onSessionSelect(pane.id, sessionId);
    }
  }, [pane.id, onSessionSelect]);

  const handleSessionClick = useCallback((e) => {
    e.stopPropagation();
    setShowSessionMenu(prev => !prev);
  }, []);

  const handleSessionSelect = useCallback((sessionId) => {
    onSessionSelect(pane.id, sessionId);
    setShowSessionMenu(false);
  }, [pane.id, onSessionSelect]);

  const handleImageUpload = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  return (
    <div
      ref={paneRef}
      className={`split-terminal-pane ${isActive ? 'active' : ''} ${isFullscreen ? 'fullscreen' : ''} ${isDragOver ? 'drag-over' : ''}`}
      onClick={handlePaneClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="pane-header">
        {/* Session mini-tab with dropdown */}
        <div className="pane-session-tab">
          <button
            type="button"
            className="pane-session-btn"
            onClick={handleSessionClick}
          >
            <span className="pane-session-title">
              {currentSession?.title || 'No session'}
            </span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showSessionMenu && (
            <div className="pane-session-menu">
              {sessions.map(session => {
                const hasUnread = sessionActivity?.[session.id]?.hasUnread;
                return (
                  <button
                    key={session.id}
                    type="button"
                    className={`pane-session-option ${session.id === pane.sessionId ? 'active' : ''} ${hasUnread ? 'unread' : ''}`}
                    onClick={() => handleSessionSelect(session.id)}
                  >
                    {hasUnread && <span className="session-unread-dot" />}
                    <span className="session-option-title">{session.title}</span>
                  </button>
                );
              })}
              {sessions.length === 0 && (
                <div className="pane-session-empty">No sessions available</div>
              )}
            </div>
          )}
        </div>

        <div className="pane-controls">
          {canSplit && !isFullscreen && (
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
          <button
            className="pane-btn pane-fullscreen-btn"
            onClick={(e) => { e.stopPropagation(); onFullscreen(pane.id); }}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="4 10 1 10 1 13" />
                <polyline points="10 4 13 4 13 1" />
                <line x1="1" y1="13" x2="5" y2="9" />
                <line x1="9" y1="5" x2="13" y2="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="10 1 13 1 13 4" />
                <polyline points="4 13 1 13 1 10" />
                <line x1="13" y1="1" x2="9" y2="5" />
                <line x1="1" y1="13" x2="5" y2="9" />
              </svg>
            )}
          </button>
          {canClose && !isFullscreen && (
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
          <div className="terminal-with-status">
            <TerminalChat
              sessionId={pane.sessionId}
              keybarOpen={keybarOpen}
              viewportHeight={viewportHeight}
              onUrlDetected={onUrlDetected}
              fontSize={fontSize}
              onRegisterImageUpload={(trigger) => { imageInputRef.current = { click: trigger }; }}
            />
            <DesktopStatusBar
              sessionId={pane.sessionId}
              cwd={projectInfo?.cwd}
              gitBranch={projectInfo?.gitBranch}
              onImageUpload={handleImageUpload}
            />
          </div>
        ) : (
          <div className="pane-empty">
            <p>Select a session or drag one here</p>
          </div>
        )}
      </div>
    </div>
  );
});
