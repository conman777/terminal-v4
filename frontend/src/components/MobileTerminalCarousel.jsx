import { useCallback, useEffect, useState } from 'react';
import { TerminalChat } from './TerminalChat';
import { MobileStatusBar } from './MobileStatusBar';

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
  onSessionBusyChange
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

  // Refresh token to force terminal reconnection
  const [refreshToken, setRefreshToken] = useState(0);
  const [reconnectTerminal, setReconnectTerminal] = useState(null);
  const handleRefreshTerminal = useCallback(() => {
    if (typeof reconnectTerminal === 'function') {
      reconnectTerminal();
      return;
    }
    setRefreshToken((value) => value + 1);
  }, [reconnectTerminal]);

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
  }, []);

  const handleRegisterReconnect = useCallback((trigger) => {
    setReconnectTerminal(() => (typeof trigger === 'function' ? trigger : null));
  }, []);

  const currentSession = sessions[currentIndex] || null;

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {}
  }, [viewMode]);

  useEffect(() => {
    setReconnectTerminal(null);
  }, [currentSession?.id]);

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
    <div className="mobile-terminal-carousel">
      {/* Terminal content */}
      <div className="carousel-content">
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
          onRegisterReconnect={handleRegisterReconnect}
          onConnectionChange={handleConnectionChange}
          onActivityChange={(isBusy) => onSessionBusyChange?.(currentSession.id, isBusy)}
        />
      </div>

      {/* Status bar with integrated mic and image buttons */}
      <MobileStatusBar
        sessionId={currentSession.id}
        onImageUpload={triggerImageUpload}
        onOpenHistory={triggerHistoryPanel}
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        isConnected={isConnected}
        onRefreshTerminal={handleRefreshTerminal}
      />
    </div>
  );
}
