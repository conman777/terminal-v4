import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalChat } from './TerminalChat';
import { MobileStatusBar } from './MobileStatusBar';
import { useChatTurns } from '../hooks/useChatTurns';
import { MobileChatView } from './MobileChatView';

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
    // Handle negative index when first session is added after all were closed
    if (currentIndex < 0) {
      onIndexChange(0);
    } else if (currentIndex >= sessions.length) {
      onIndexChange(sessions.length - 1);
    }
  }, [sessions.length, currentIndex, onIndexChange]);

  // Refresh token to force terminal remount (used by auto-remount watchdog)
  const [refreshToken, setRefreshToken] = useState(0);

  // Image upload trigger function from TerminalChat
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);
  const [triggerHistoryPanel, setTriggerHistoryPanel] = useState(null);
  const [viewMode, setViewMode] = useState(() => {
    try {
      const stored = localStorage.getItem('mobileTerminalViewMode');
      return stored === 'reader' ? 'reader' : 'terminal';
    } catch {
      return 'terminal';
    }
  }); // 'terminal' | 'reader'
  const [isConnected, setIsConnected] = useState(false);

  const { turns, streamingContent, handleUserSend, handleOutputChunk, clearTurns } = useChatTurns();

  // Auto-remount watchdog: if disconnected for 5 continuous minutes, force remount
  const disconnectStartRef = useRef(null);
  const autoRemountTimerRef = useRef(null);

  const sendToTerminalRef = useRef(null);
  const handleRegisterSendText = useCallback((fn) => {
    sendToTerminalRef.current = fn;
  }, []);

  const handleChatSend = useCallback((text) => {
    sendToTerminalRef.current?.(text + '\n');
  }, []);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(v => v === 'terminal' ? 'reader' : 'terminal');
  }, []);

  const handleRegisterImageUpload = useCallback((trigger) => {
    setTriggerImageUpload(() => trigger);
  }, []);

  const handleRegisterHistoryPanel = useCallback((trigger) => {
    setTriggerHistoryPanel(() => trigger);
  }, []);

  const handleConnectionChange = useCallback((connected) => {
    setIsConnected(connected);
    if (connected) {
      disconnectStartRef.current = null;
      if (autoRemountTimerRef.current) {
        clearTimeout(autoRemountTimerRef.current);
        autoRemountTimerRef.current = null;
      }
    } else if (!disconnectStartRef.current) {
      disconnectStartRef.current = Date.now();
      autoRemountTimerRef.current = setTimeout(() => {
        setRefreshToken(v => v + 1);
        disconnectStartRef.current = null;
      }, 5 * 60 * 1000);
    }
  }, []);

  // Cleanup watchdog timer on unmount
  useEffect(() => {
    return () => clearTimeout(autoRemountTimerRef.current);
  }, []);

  const currentSession = sessions[currentIndex] || null;
  const currentAiType = currentSession ? sessionAiTypes?.[currentSession.id] : null;

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {}
  }, [viewMode]);

  // Clear turns when session changes
  useEffect(() => {
    clearTurns();
  }, [currentSession?.id, clearTurns]);

  // No sessions - show empty state
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

  return (
    <div className={`mobile-terminal-carousel${currentAiType ? ` pane-ai-${currentAiType}` : ''}`}>
      {/* Terminal content - always mounted to keep WebSocket alive */}
      <div className="carousel-content" style={chatMode ? { display: 'none' } : undefined}>
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
          onScrollDirection={onScrollDirection}
          onRegisterImageUpload={handleRegisterImageUpload}
          onRegisterHistoryPanel={handleRegisterHistoryPanel}
          onRegisterFocusTerminal={onRegisterFocusTerminal}
          onConnectionChange={handleConnectionChange}
          onActivityChange={(isBusy) => onSessionBusyChange?.(currentSession.id, isBusy)}
          onSendMessage={handleUserSend}
          onOutputChunk={handleOutputChunk}
          onRegisterSendText={handleRegisterSendText}
        />
      </div>

      {chatMode && (
        <MobileChatView
          turns={turns}
          streamingContent={streamingContent}
          onSend={handleChatSend}
        />
      )}

      {/* Status bar with integrated mic and image buttons */}
      <MobileStatusBar
        sessionId={currentSession.id}
        onImageUpload={triggerImageUpload}
        onOpenHistory={triggerHistoryPanel}
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        isConnected={isConnected}
      />
    </div>
  );
}
