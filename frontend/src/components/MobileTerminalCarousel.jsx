import { useCallback, useEffect, useState } from 'react';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
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
  onRegisterFocusTerminal
}) {
  // Clamp index to valid range when sessions change
  useEffect(() => {
    if (sessions.length === 0) return;
    if (currentIndex >= sessions.length) {
      onIndexChange(sessions.length - 1);
    }
  }, [sessions.length, currentIndex, onIndexChange]);

  const handleSwipeLeft = useCallback(() => {
    // Go to next terminal
    if (currentIndex < sessions.length - 1) {
      onIndexChange(currentIndex + 1);
    }
  }, [currentIndex, sessions.length, onIndexChange]);

  const handleSwipeRight = useCallback(() => {
    // Go to previous terminal
    if (currentIndex > 0) {
      onIndexChange(currentIndex - 1);
    }
  }, [currentIndex, onIndexChange]);

  // Swipe gesture for changing sessions
  const { containerRef: swipeRef } = useSwipeGesture({
    onSwipeLeft: handleSwipeLeft,
    onSwipeRight: handleSwipeRight,
    enabled: sessions.length > 1
  });

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

  useEffect(() => {
    try {
      localStorage.setItem('mobileTerminalViewMode', viewMode);
    } catch {}
  }, [viewMode]);

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

  const currentSession = sessions[currentIndex];

  return (
    <div className="mobile-terminal-carousel">
      {/* Terminal content - swipe to change sessions */}
      <div className="carousel-content" ref={swipeRef}>
        <TerminalChat
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
      />
    </div>
  );
}
