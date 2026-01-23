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
  showPreview,
  onMinimizeMainTerminal,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  sessionActivity,
  projectInfo,
  onCwdChange
}) {
  const paneRef = useRef(null);
  const imageInputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [currentCwd, setCurrentCwd] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [viewMode, setViewMode] = useState('terminal'); // 'terminal' | 'reader'

  const handleToggleViewMode = useCallback(() => {
    setViewMode(v => v === 'terminal' ? 'reader' : 'terminal');
  }, []);

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

  const handleConnectionChange = useCallback((connected) => {
    setIsConnected(connected);
  }, []);

  const handleCwdChange = useCallback((cwd) => {
    setCurrentCwd(cwd);
    onCwdChange?.(cwd);
  }, [onCwdChange]);

  const handleRefreshTerminal = useCallback(() => {
    setRefreshToken((value) => value + 1);
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
        {/* Session mini-tab with dropdown - only show in split-pane mode with multiple sessions */}
        {canClose && sessions.length > 1 && (
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
        )}

        <div className="pane-controls">
          <button
            className="pane-btn"
            onClick={(e) => { e.stopPropagation(); handleRefreshTerminal(); }}
            title="Reconnect terminal"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          {canSplit && !isFullscreen && (
            <>
              <button
                className="pane-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'horizontal'); }}
                title="Split horizontally"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="12" y1="3" x2="12" y2="21" />
                </svg>
              </button>
              <button
                className="pane-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'vertical'); }}
                title="Split vertically"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                </svg>
              </button>
            </>
          )}
          {showPreview && !isFullscreen && onMinimizeMainTerminal && (
            <button
              className="pane-btn"
              onClick={(e) => { e.stopPropagation(); onMinimizeMainTerminal(); }}
              title="Minimize terminal"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <path d="M14 9l3 3-3 3" />
              </svg>
            </button>
          )}
          <button
            className="pane-btn"
            onClick={(e) => { e.stopPropagation(); onFullscreen(pane.id); }}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            )}
          </button>
          {canClose && !isFullscreen && (
            <button
              className="pane-btn pane-close"
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              title="Close pane"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="pane-content">
        {pane.sessionId ? (
          <div className="terminal-with-status">
            <TerminalChat
              key={`${pane.sessionId}-${refreshToken}`}
              sessionId={pane.sessionId}
              keybarOpen={keybarOpen}
              viewportHeight={viewportHeight}
              onUrlDetected={onUrlDetected}
              fontSize={fontSize}
              webglEnabled={webglEnabled}
              usesTmux={currentSession?.usesTmux}
              viewMode={viewMode}
              onRegisterImageUpload={(trigger) => { imageInputRef.current = { click: trigger }; }}
              onConnectionChange={handleConnectionChange}
              onCwdChange={handleCwdChange}
            />
            <DesktopStatusBar
              sessionId={pane.sessionId}
              cwd={currentCwd || projectInfo?.cwd}
              gitBranch={projectInfo?.gitBranch}
              onImageUpload={handleImageUpload}
              isConnected={isConnected}
              viewMode={viewMode}
              onToggleViewMode={handleToggleViewMode}
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
