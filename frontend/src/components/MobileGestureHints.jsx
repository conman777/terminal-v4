import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import './MobileUI.css';

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
    title: 'Open More actions',
    description: 'Rename or close the current session.'
  }
];

export function MobileGestureHints() {
  const [isVisible, setIsVisible] = useState(false);
  const sheetRef = useRef(null);
  const closeRef = useRef(null);

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

  useEffect(() => {
    if (!isVisible) return;
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      } else if (event.key === 'Tab') {
        const controls = sheetRef.current?.querySelectorAll('button');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (!sheetRef.current.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [dismiss, isVisible]);

  if (!isVisible) return null;

  return (
    <div className="mobile-gesture-hints-overlay mobile-ui" role="dialog" aria-modal="true" aria-label="Mobile gesture tips">
      <div ref={sheetRef} className="mobile-gesture-hints-sheet">
        <button
          ref={closeRef}
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

