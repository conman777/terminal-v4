import { useLayoutEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';

export function MobileKeybar({ sessionId, isOpen, onHeightChange }) {
  const keybarRef = useRef(null);

  useLayoutEffect(() => {
    if (!onHeightChange) {
      return;
    }

    if (typeof window === 'undefined') {
      onHeightChange(0);
      return;
    }

    const updateHeight = () => {
      if (!keybarRef.current) {
        onHeightChange(0);
        return;
      }
      const measured = keybarRef.current.offsetHeight || 0;
      onHeightChange(isOpen ? measured : 0);
    };

    updateHeight();

    window.addEventListener('resize', updateHeight);
    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', updateHeight);
      viewport.addEventListener('scroll', updateHeight);
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
    };
  }, [isOpen, onHeightChange]);

  const handleKeyPress = () => {
    // Haptic feedback on mobile
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };

  // Send key directly without ESC prefix (for ESC button itself)
  const sendKeyRaw = async (data) => {
    if (!sessionId) return;

    try {
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: data }
      });
    } catch (error) {
      console.error('Failed to send key:', error);
    }
  };

  // Send key with ESC prefix to exit any tmux copy-mode state
  // ESC is safe: exits copy-mode, or does minimal harm at shell prompt
  const sendKey = async (data) => {
    if (!sessionId) return;

    try {
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: '\x1b' + data }
      });
    } catch (error) {
      console.error('Failed to send key:', error);
    }
  };

  const keys = [
    // Row 1: Common control keys
    { label: 'ESC', key: '\x1b', title: 'Escape' },
    { label: '^C', key: '\x03', title: 'Ctrl+C (Interrupt)' },
    { label: 'TAB', key: '\t', title: 'Tab' },
    { label: '⇧TAB', key: '\x1b[Z', title: 'Shift+Tab' },
    { label: '↵', key: '\r', title: 'Enter' },
    { label: 'DEL', key: '\x7f', title: 'Delete/Backspace' },

    // Row 2: Arrow keys + paste
    { label: '←', key: '\x1b[D', title: 'Left Arrow' },
    { label: '↑', key: '\x1b[A', title: 'Up Arrow' },
    { label: '↓', key: '\x1b[B', title: 'Down Arrow' },
    { label: '→', key: '\x1b[C', title: 'Right Arrow' },
    { label: 'PASTE', key: 'paste', title: 'Paste from Clipboard', special: true }
  ];

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sendKey(text);
      }
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      alert('Clipboard access denied. Please enable clipboard permissions.');
    }
  };

  const handleButtonPress = (keyData) => {
    handleKeyPress();

    if (keyData.special && keyData.key === 'paste') {
      handlePaste();
    } else if (keyData.key === '\x1b') {
      // ESC button - send as-is, don't prepend another ESC
      sendKeyRaw(keyData.key);
    } else {
      sendKey(keyData.key);
    }
  };

  return (
    <div ref={keybarRef} className={`mobile-keybar${isOpen ? ' open' : ''}`}>
      <div className="mobile-keybar-handle">
        <div className="mobile-keybar-drag-indicator"></div>
      </div>
      <div className="mobile-keybar-row">
        {keys.slice(0, 6).map((keyData) => (
          <button
            key={keyData.label}
            className="mobile-key"
            onClick={() => handleButtonPress(keyData)}
            title={keyData.title}
            type="button"
          >
            {keyData.label}
          </button>
        ))}
      </div>
      <div className="mobile-keybar-row">
        {keys.slice(6).map((keyData) => (
          <button
            key={keyData.label}
            className={`mobile-key${keyData.special ? ' mobile-key-special' : ''}`}
            onClick={() => handleButtonPress(keyData)}
            title={keyData.title}
            type="button"
          >
            {keyData.label}
          </button>
        ))}
      </div>
    </div>
  );
}
