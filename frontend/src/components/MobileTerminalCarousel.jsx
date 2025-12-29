import { useCallback, useEffect } from 'react';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { TerminalChat } from './TerminalChat';
import { TerminalMicButton } from './TerminalMicButton';

export function MobileTerminalCarousel({
  sessions,
  currentIndex,
  onIndexChange,
  keybarOpen,
  viewportHeight,
  onUrlDetected,
  fontSize
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

  const { containerRef } = useSwipeGesture({
    onSwipeLeft: handleSwipeLeft,
    onSwipeRight: handleSwipeRight,
    enabled: sessions.length > 1
  });

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
    <div
      ref={containerRef}
      className="mobile-terminal-carousel"
    >
      {/* Dot indicators - only show if more than 1 session */}
      {sessions.length > 1 && (
        <div className="carousel-indicators">
          {sessions.map((session, index) => (
            <button
              key={session.id}
              type="button"
              className={`carousel-dot${index === currentIndex ? ' active' : ''}`}
              onClick={() => onIndexChange(index)}
              aria-label={`Terminal ${index + 1}: ${session.title}`}
            />
          ))}
        </div>
      )}

      {/* Terminal content */}
      <div className="carousel-content">
        <div className="terminal-with-mic">
          <TerminalChat
            sessionId={currentSession.id}
            keybarOpen={keybarOpen}
            viewportHeight={viewportHeight}
            onUrlDetected={onUrlDetected}
            fontSize={fontSize}
          />
          <TerminalMicButton sessionId={currentSession.id} />
        </div>
      </div>
    </div>
  );
}
