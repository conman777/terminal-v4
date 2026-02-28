import { useCallback, useEffect, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

const STORAGE_KEY = 'gestureHintsSeen';

const GESTURE_HINTS = [
  {
    glyph: '\u2192',
    title: 'Swipe right from left edge',
    description: 'Opens the session drawer.'
  },
  {
    glyph: '\u2193',
    title: 'Swipe down on header',
    description: 'Shows the keyboard bar.'
  },
  {
    glyph: '\u22ef',
    title: 'Long-press a session tab',
    description: 'Rename, change AI, or close.'
  }
];

export function MobileGestureHints() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(STORAGE_KEY) === '1';
      if (!seen) {
        setIsVisible(true);
      }
    } catch {
      setIsVisible(true);
    }
  }, []);

  const dismiss = useCallback(() => {
    setIsVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  useBodyScrollLock(isVisible);

  if (!isVisible) return null;

  return (
    <div className="mobile-gesture-hints-overlay" role="dialog" aria-modal="true" aria-label="Mobile gesture tips">
      <div className="mobile-gesture-hints-sheet">
        <button
          type="button"
          className="mobile-gesture-hints-close"
          onClick={dismiss}
          aria-label="Close gesture tips"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <h2>Mobile gestures</h2>
        <div className="mobile-gesture-hints-list">
          {GESTURE_HINTS.map((hint) => (
            <div key={hint.title} className="mobile-gesture-hint-row">
              <span className="mobile-gesture-hint-glyph" aria-hidden="true">{hint.glyph}</span>
              <div className="mobile-gesture-hint-copy">
                <div className="mobile-gesture-hint-title">{hint.title}</div>
                <div className="mobile-gesture-hint-description">{hint.description}</div>
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="mobile-gesture-hints-cta" onClick={dismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}

