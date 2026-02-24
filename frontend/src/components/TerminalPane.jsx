import { useRef, useState, useCallback, useEffect, memo } from 'react';
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
  sessionAiTypes,
  onCwdChange,
  onSessionBusyChange,
  currentDesktopId,
  fitSignal
}) {
  const paneRef = useRef(null);
  const imageInputRef = useRef(null);
  const menuRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isHeaderDragging, setIsHeaderDragging] = useState(false);
  const [showSessionMenu, setShowSessionMenu] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [currentCwd, setCurrentCwd] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [viewMode, setViewMode] = useState('terminal'); // 'terminal' | 'reader'

  const handleToggleViewMode = useCallback(() => {
    setViewMode(v => v === 'terminal' ? 'reader' : 'terminal');
  }, []);

  const currentSession = sessions.find(s => s.id === pane.sessionId);

  // Close session menu on outside click
  useEffect(() => {
    if (!showSessionMenu) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setShowSessionMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSessionMenu]);

  const handlePaneClick = (e) => {
    if (!e.target.closest('.ph-controls') && !e.target.closest('.ph-session-menu')) {
      onFocus(pane.id);
    }
  };

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

  const handleHeaderDragStart = useCallback((e) => {
    if (!pane.sessionId) return;
    e.dataTransfer.setData('pane-drag', JSON.stringify({
      paneId: pane.id,
      sessionId: pane.sessionId,
      fromDesktopId: currentDesktopId
    }));
    e.dataTransfer.effectAllowed = 'move';
    setIsHeaderDragging(true);
  }, [pane.id, pane.sessionId, currentDesktopId]);

  const handleHeaderDragEnd = useCallback(() => {
    setIsHeaderDragging(false);
  }, []);

  return (
    <div
      ref={paneRef}
      className={`split-terminal-pane ${isActive ? 'active' : ''} ${isFullscreen ? 'fullscreen' : ''} ${isDragOver ? 'drag-over' : ''}${sessionAiTypes?.[pane.sessionId] ? ` pane-ai-${sessionAiTypes[pane.sessionId]}` : ''}`}
      onClick={handlePaneClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`ph-bar${isHeaderDragging ? ' is-dragging-pane' : ''}`}
        draggable={Boolean(pane.sessionId)}
        onDragStart={handleHeaderDragStart}
        onDragEnd={handleHeaderDragEnd}
      >
        <div className="ph-left">
          {/* Session selector - only in split mode with multiple sessions */}
          {canClose && sessions.length > 1 && (
            <div className="ph-session" ref={menuRef}>
              <button
                type="button"
                className="ph-session-btn"
                onClick={handleSessionClick}
              >
                <span className="ph-session-dot" />
                <span className="ph-session-name">
                  {currentSession?.title || 'No session'}
                </span>
                <svg className="ph-session-chevron" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {showSessionMenu && (
                <div className="ph-session-menu">
                  <div className="ph-menu-label">Switch session</div>
                  {sessions.map(session => {
                    const hasUnread = sessionActivity?.[session.id]?.hasUnread;
                    const isCurrentSession = session.id === pane.sessionId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={`ph-menu-item ${isCurrentSession ? 'active' : ''}`}
                        onClick={() => handleSessionSelect(session.id)}
                      >
                        {hasUnread && <span className="ph-menu-dot" />}
                        <span className="ph-menu-title">{session.title}</span>
                        {isCurrentSession && (
                          <svg className="ph-menu-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                  {sessions.length === 0 && (
                    <div className="ph-menu-empty">No sessions available</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session topic summary */}
          {currentSession?.thread?.topic && (
            <>
              {canClose && sessions.length > 1 && <span className="ph-topic-sep">·</span>}
              <span className="ph-topic" title={currentSession.thread.topic}>
                {currentSession.thread.topic}
              </span>
            </>
          )}
        </div>

        <div className="ph-controls">
          {/* Reconnect */}
          <button
            className="ph-btn"
            onClick={(e) => { e.stopPropagation(); handleRefreshTerminal(); }}
            title="Reconnect terminal"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1 2.13-9" />
            </svg>
          </button>

          {/* Split buttons */}
          {canSplit && !isFullscreen && (
            <>

              <button
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'horizontal'); }}
                title="Split horizontally"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1" y="2" width="5" height="10" rx="1" />
                  <rect x="8" y="2" width="5" height="10" rx="1" />
                </svg>
              </button>
              <button
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onSplit(pane.id, 'vertical'); }}
                title="Split vertically"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="1" width="10" height="5" rx="1" />
                  <rect x="2" y="8" width="10" height="5" rx="1" />
                </svg>
              </button>
            </>
          )}

          {/* Minimize to show preview */}
          {showPreview && !isFullscreen && onMinimizeMainTerminal && (
            <>

              <button
                className="ph-btn"
                onClick={(e) => { e.stopPropagation(); onMinimizeMainTerminal(); }}
                title="Minimize terminal (show browser)"
              >
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="2" width="6" height="10" rx="1" />
                  <polyline points="8 5 11 7 8 9" />
                </svg>
              </button>
            </>
          )}

          {/* Fullscreen */}
          <span className="ph-divider" />
          <button
            className="ph-btn"
            onClick={(e) => { e.stopPropagation(); onFullscreen(pane.id); }}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="4 10 1 10 1 13" />
                <polyline points="10 4 13 4 13 1" />
                <line x1="1" y1="13" x2="5" y2="9" />
                <line x1="9" y1="5" x2="13" y2="1" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <polyline points="10 1 13 1 13 4" />
                <polyline points="4 13 1 13 1 10" />
                <line x1="13" y1="1" x2="9" y2="5" />
                <line x1="1" y1="13" x2="5" y2="9" />
              </svg>
            )}
          </button>

          {/* Close pane */}
          {canClose && !isFullscreen && (
            <button
              className="ph-btn ph-btn-close"
              onClick={(e) => { e.stopPropagation(); onClose(pane.id); }}
              title="Close pane"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
              isPrimary={isActive}
              fitSignal={fitSignal}
              onRegisterImageUpload={(trigger) => { imageInputRef.current = { click: trigger }; }}
              onConnectionChange={handleConnectionChange}
              onCwdChange={handleCwdChange}
              onActivityChange={(isBusy) => onSessionBusyChange?.(pane.sessionId, isBusy)}
            />
            <DesktopStatusBar
              sessionId={pane.sessionId}
              sessionTitle={currentSession?.title}
              cwd={currentCwd || projectInfo?.cwd}
              gitBranch={projectInfo?.gitBranch}
              onImageUpload={handleImageUpload}
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

      <style jsx>{`
        /* ── Pane header bar ── */
        .ph-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 36px;
          padding: 0 6px 0 10px;
          background: var(--bg-surface);
          border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }

        .ph-bar[draggable=true] { cursor: grab; }
        .ph-bar.is-dragging-pane { opacity: 0.5; cursor: grabbing; }

        .ph-left {
          display: flex;
          align-items: center;
          min-width: 0;
          flex: 1;
        }

        /* ── Topic summary ── */
        .ph-topic-sep {
          color: var(--text-muted);
          opacity: 0.5;
          padding: 0 6px;
          flex-shrink: 0;
          font-size: 12px;
        }

        .ph-topic {
          font-size: 11px;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 220px;
          flex-shrink: 1;
        }

        /* ── Session selector ── */
        .ph-session {
          position: relative;
        }

        .ph-session-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px 4px 8px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm, 4px);
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all var(--transition-fast, 0.15s ease);
        }

        .ph-session-btn:hover {
          border-color: var(--accent-primary);
          color: var(--accent-primary);
        }

        .ph-session-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent-primary);
          opacity: 0.7;
          flex-shrink: 0;
        }

        .ph-session-name {
          max-width: 140px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .ph-session-chevron {
          opacity: 0.5;
          flex-shrink: 0;
        }

        /* ── Session dropdown menu ── */
        .ph-session-menu {
          position: absolute;
          top: calc(100% + 4px);
          left: 0;
          min-width: 200px;
          max-height: 260px;
          overflow-y: auto;
          background: var(--bg-elevated);
          border: 1px solid var(--border-default);
          border-radius: var(--radius-md, 8px);
          box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
          z-index: 1000;
          padding: 4px;
        }

        .ph-menu-label {
          padding: 6px 10px 4px;
          font-size: 10px;
          font-weight: 650;
          text-transform: uppercase;
          letter-spacing: 0.4px;
          color: var(--text-muted);
        }

        .ph-menu-item {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 6px 10px;
          background: transparent;
          border: none;
          border-radius: var(--radius-sm, 4px);
          color: var(--text-secondary);
          font-size: 12px;
          text-align: left;
          cursor: pointer;
          transition: all var(--transition-fast, 0.15s ease);
        }

        .ph-menu-item:hover {
          background: var(--bg-surface);
          color: var(--text-primary);
        }

        .ph-menu-item.active {
          background: var(--accent-primary-dim);
          color: var(--accent-primary);
        }

        .ph-menu-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent-primary);
          flex-shrink: 0;
        }

        .ph-menu-title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .ph-menu-check {
          flex-shrink: 0;
          opacity: 0.8;
          color: var(--accent-primary);
        }

        .ph-menu-empty {
          padding: 12px 10px;
          font-size: 11px;
          color: var(--text-muted);
          text-align: center;
        }

        /* ── Control buttons ── */
        .ph-controls {
          display: flex;
          align-items: center;
          gap: 4px;
          flex-shrink: 0;
        }

        .ph-btn {
          background: var(--bg-elevated);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm, 4px);
          padding: 5px;
          color: var(--text-muted);
          cursor: pointer;
          transition: all var(--transition-fast, 0.15s ease);
          display: flex;
          align-items: center;
          justify-content: center;
          line-height: 1;
        }

        .ph-btn svg {
          display: block;
        }

        .ph-btn:hover {
          background: var(--bg-surface);
          border-color: var(--accent-primary);
          color: var(--accent-primary);
        }

        .ph-btn-close:hover {
          background: rgba(244, 63, 94, 0.1);
          border-color: var(--error);
          color: var(--error);
        }

        @media (max-width: 768px) {
          .ph-btn {
            min-width: 44px;
            min-height: 44px;
            padding: 10px;
          }
        }
      `}</style>
    </div>
  );
});
