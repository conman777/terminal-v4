import { useCallback, useEffect, useRef, useState } from 'react';
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
  onScrollDirection
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

  // Swipe gesture for changing sessions - attached to content area only
  // (not the tab bar, which needs its own horizontal scroll)
  const { containerRef: swipeRef } = useSwipeGesture({
    onSwipeLeft: handleSwipeLeft,
    onSwipeRight: handleSwipeRight,
    enabled: sessions.length > 1
  });

  // Ref for auto-scrolling tab bar
  const tabBarRef = useRef(null);

  // Image upload trigger function from TerminalChat
  const [triggerImageUpload, setTriggerImageUpload] = useState(null);

  const handleRegisterImageUpload = useCallback((trigger) => {
    setTriggerImageUpload(() => trigger);
  }, []);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (tabBarRef.current && sessions.length > 1) {
      const activeTab = tabBarRef.current.querySelector('.session-tab.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    }
  }, [currentIndex, sessions.length]);

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
      {/* Session tab bar - horizontal scrollable */}
      {sessions.length > 1 && (
        <div className="session-tab-bar" ref={tabBarRef}>
          {sessions.map((session, index) => (
            <button
              key={session.id}
              type="button"
              className={`session-tab${index === currentIndex ? ' active' : ''}`}
              onClick={() => onIndexChange(index)}
              aria-label={`Terminal ${index + 1}: ${session.title}`}
            >
              <span className="session-tab-title">{session.title || `Terminal ${index + 1}`}</span>
            </button>
          ))}
        </div>
      )}

      {/* Terminal content - swipe here to change sessions */}
      <div className="carousel-content" ref={swipeRef}>
        <TerminalChat
          sessionId={currentSession.id}
          keybarOpen={keybarOpen}
          viewportHeight={viewportHeight}
          onUrlDetected={onUrlDetected}
          fontSize={fontSize}
          onScrollDirection={onScrollDirection}
          onRegisterImageUpload={handleRegisterImageUpload}
        />
      </div>

      {/* Status bar with integrated mic and image buttons */}
      <MobileStatusBar
        sessionId={currentSession.id}
        onImageUpload={triggerImageUpload}
      />
    </div>
  );
}
