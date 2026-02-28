import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalChat } from './TerminalChat';
import { MobileStatusBar } from './MobileStatusBar';
import { useMobileChatTurns } from '../hooks/useMobileChatTurns';
import { MobileChatView } from './MobileChatView';
import { ContextMenu } from './ContextMenu';
import { useLongPress } from '../hooks/useLongPress';

export function MobileTerminalCarousel({
  sessions,
  currentIndex,
  onIndexChange,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize,
  webglEnabled,
  onScrollDirection,
  onRegisterFocusTerminal,
  onSessionBusyChange,
  sessionAiTypes,
  chatMode = false,
  onChatModeChange,
}) {
  // Clamp index to valid range when sessions change
  useEffect(() => {
    if (sessions.length === 0) return;
    if (currentIndex < 0) {
      onIndexChange(0);
    } else if (currentIndex >= sessions.length) {
      onIndexChange(sessions.length - 1);
    }
  }, [sessions.length, currentIndex, onIndexChange]);

  const [refreshToken, setRefreshToken] = useState(0);
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);
  const [triggerHistoryPanel, setTriggerHistoryPanel] = useState(null);
  const [triggerScrollToBottom, setTriggerScrollToBottom] = useState(null);
  const [isTerminalScrolledUp, setIsTerminalScrolledUp] = useState(false);
  const [isClaudeBusy, setIsClaudeBusy] = useState(false);
  const [selectionActions, setSelectionActions] = useState(null);
  const [viewMode, setViewMode] = useState(() => {
    try {
      const stored = localStorage.getItem('mobileTerminalViewMode');
      return stored === 'reader' ? 'reader' : 'terminal';
    } catch {
      return 'terminal';
    }
  });
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectBannerState, setReconnectBannerState] = useState('idle');
  const [terminalContextMenu, setTerminalContextMenu] = useState(null);

  const currentSession = sessions[currentIndex] || null;
  const currentAiType = currentSession ? sessionAiTypes?.[currentSession.id] : null;

  // Auto-remount watchdog: if disconnected for 5 continuous minutes, force remount
  const disconnectStartRef = useRef(null);
  const autoRemountTimerRef = useRef(null);
  const reconnectFeedbackTimerRef = useRef(null);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(v => v === 'terminal' ? 'reader' : 'terminal');
  }, []);

  const handleRegisterImageUpload = useCallback((trigger) => {
    setTriggerImageUpload(() => trigger);
  }, []);

  const handleRegisterHistoryPanel = useCallback((trigger) => {
    setTriggerHistoryPanel(() => trigger);
  }, []);

  const handleRegisterScrollToBottom = useCallback((trigger) => {
    setTriggerScrollToBottom(() => trigger);
  }, []);

  const handleScrollDirection = useCallback((direction) => {
    if (direction === 'up') setIsTerminalScrolledUp(true);
    else if (direction === 'down') setIsTerminalScrolledUp(false);
    onScrollDirection?.(direction);
  }, [onScrollDirection]);

  const handleScrollToBottom = useCallback(() => {
    triggerScrollToBottom?.();
    setIsTerminalScrolledUp(false);
  }, [triggerScrollToBottom]);

  const handleActivityChange = useCallback((isBusy) => {
    setIsClaudeBusy(isBusy);
    onSessionBusyChange?.(currentSession?.id, isBusy);
  }, [onSessionBusyChange]);

  const handleRegisterSelectionActions = useCallback((actions) => {
    setSelectionActions(() => actions || null);
  }, []);

  const handleConnectionChange = useCallback((connected) => {
    setIsConnected(connected);
    if (connected) {
      disconnectStartRef.current = null;
      if (autoRemountTimerRef.current) {
        clearTimeout(autoRemountTimerRef.current);
        autoRemountTimerRef.current = null;
      }
      setReconnectBannerState((previousState) => {
        if (previousState !== 'reconnecting') {
          return previousState;
        }

        if (reconnectFeedbackTimerRef.current) {
          clearTimeout(reconnectFeedbackTimerRef.current);
          reconnectFeedbackTimerRef.current = null;
        }
        reconnectFeedbackTimerRef.current = setTimeout(() => {
          setReconnectBannerState('idle');
          reconnectFeedbackTimerRef.current = null;
        }, 2000);
        return 'reconnected';
      });
    } else if (!disconnectStartRef.current) {
      disconnectStartRef.current = Date.now();
      autoRemountTimerRef.current = setTimeout(() => {
        setReconnectBannerState('reconnecting');
        setRefreshToken(v => v + 1);
        disconnectStartRef.current = null;
        autoRemountTimerRef.current = null;
      }, 5 * 60 * 1000);
    }
  }, []);

  const handleTerminalLongPress = useCallback((coords) => {
    const items = [];
    const hasSelection = Boolean(selectionActions?.hasSelection?.());

    if (hasSelection) {
      items.push({
        label: 'Copy selection',
        onClick: () => selectionActions?.copySelection?.()
      });
    }

    if (triggerHistoryPanel) {
      items.push({
        label: 'Open copy panel',
        onClick: () => triggerHistoryPanel?.()
      });
    }

    items.push({
      label: viewMode === 'reader' ? 'Switch to Terminal' : 'Switch to Reader',
      onClick: () => handleToggleViewMode()
    });

    if (items.length === 0) {
      return;
    }

    setTerminalContextMenu({
      x: coords?.x || 12,
      y: coords?.y || 12,
      items
    });
  }, [handleToggleViewMode, selectionActions, triggerHistoryPanel, viewMode]);

  const longPressHandlers = useLongPress(handleTerminalLongPress);

  // Cleanup watchdog timer on unmount
  useEffect(() => {
    return () => {
      clearTimeout(autoRemountTimerRef.current);
      if (reconnectFeedbackTimerRef.current) {
        clearTimeout(reconnectFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSelectionActions(null);
  }, [currentSession?.id]);

  const {
    turns,
    isLoading: isChatHistoryLoading,
    handleTurn,
    handleRegisterSendText,
    handleChatSend,
    handleInterrupt,
  } = useMobileChatTurns({
    sessionId: currentSession?.id ?? null,
    chatMode,
  });

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {}
  }, [viewMode]);

  if (sessions.length === 0) {
    return (
      <div className="mobile-terminal-carousel">
        <div className="empty-state">
          <h2>Welcome to Terminal</h2>
          <p>Create a new terminal session to get started.</p>
        </div>
      </div>
    );
  }

  if (!currentSession) {
    return <div className="mobile-terminal-carousel" />;
  }

  return (
    <div className={`mobile-terminal-carousel${currentAiType ? ` pane-ai-${currentAiType}` : ''}`}>
      {!isConnected && reconnectBannerState !== 'reconnecting' && (
        <div className="mobile-terminal-disconnected-pill" role="status" aria-live="polite">
          Disconnected
        </div>
      )}
      {reconnectBannerState === 'reconnecting' && (
        <div className="mobile-reconnect-banner reconnecting" role="status" aria-live="assertive">
          <span className="mobile-reconnect-spinner" aria-hidden="true" />
          Reconnecting...
        </div>
      )}
      {reconnectBannerState === 'reconnected' && (
        <div className="mobile-reconnect-banner reconnected" role="status" aria-live="polite">
          Reconnected
        </div>
      )}
      {/* Terminal content — always mounted to keep WebSocket alive.
          In chat mode: opacity:0 hides WebGL canvas at compositor level. */}
      <div
        className="carousel-content"
        style={chatMode ? {
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: 'none',
          zIndex: 0,
        } : undefined}
        aria-hidden={chatMode ? 'true' : undefined}
        {...longPressHandlers}
      >
        <TerminalChat
          key={`${currentSession.id}-${refreshToken}`}
          sessionId={currentSession.id}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          webglEnabled={webglEnabled}
          usesTmux={currentSession?.usesTmux}
          viewMode={viewMode}
          onScrollDirection={handleScrollDirection}
          onRegisterImageUpload={handleRegisterImageUpload}
          onRegisterHistoryPanel={handleRegisterHistoryPanel}
          onRegisterSelectionActions={handleRegisterSelectionActions}
          onRegisterFocusTerminal={onRegisterFocusTerminal}
          onRegisterScrollToBottom={handleRegisterScrollToBottom}
          onConnectionChange={handleConnectionChange}
          onActivityChange={handleActivityChange}
          onRegisterSendText={handleRegisterSendText}
          onTurn={handleTurn}
        />
      </div>

      {/* Chat view — in normal flex flow so iOS keyboard handling works correctly. */}
      {chatMode && (
        <MobileChatView
          turns={turns}
          isStreaming={isClaudeBusy}
          isLoadingHistory={isChatHistoryLoading}
          onSend={handleChatSend}
          onInterrupt={handleInterrupt}
          onImageUpload={triggerImageUpload ?? undefined}
          sessionId={currentSession?.id ?? null}
        />
      )}

      {/* Status bar — terminal mode only */}
      {!chatMode && (
        <MobileStatusBar
          sessionId={currentSession.id}
          onImageUpload={triggerImageUpload}
          onOpenHistory={triggerHistoryPanel}
          viewMode={viewMode}
          onToggleViewMode={handleToggleViewMode}
          isConnected={isConnected}
        />
      )}

      {/* Scroll-to-bottom button — terminal mode only */}
      {!chatMode && isTerminalScrolledUp && (
        <button
          type="button"
          className="mobile-scroll-bottom-btn"
          onClick={handleScrollToBottom}
          aria-label="Scroll to bottom"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {terminalContextMenu && (
        <ContextMenu
          x={terminalContextMenu.x}
          y={terminalContextMenu.y}
          items={terminalContextMenu.items}
          onClose={() => setTerminalContextMenu(null)}
        />
      )}
    </div>
  );
}
