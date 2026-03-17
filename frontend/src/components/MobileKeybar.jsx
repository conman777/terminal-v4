import { useLayoutEffect, useRef } from 'react';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { uploadScreenshot } from '../utils/api';
import {
  getImageFileFromClipboardItems,
  hasMeaningfulClipboardText,
  shouldPreferImageOverText
} from '../utils/clipboardImage';
import { quoteTerminalPath } from '../utils/mobileTerminalInput';

export function MobileKeybar({ sessionId, isOpen, onHeightChange }) {
  const keybarRef = useRef(null);
  const { sendToSession } = useTerminalSession();

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
      viewport.addEventListener('resize', updateHeight, { passive: true });
      viewport.addEventListener('scroll', updateHeight, { passive: true });
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight, { passive: true });
        viewport.removeEventListener('scroll', updateHeight, { passive: true });
      }
    };
  }, [isOpen, onHeightChange]);

  const handleKeyPress = () => {
    // Haptic feedback on mobile
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };

  const sendKeyRaw = async (data) => {
    if (!sessionId) return;

    try {
      await sendToSession?.(sessionId, data);
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
      let clipboardText = '';
      if (navigator.clipboard?.readText) {
        try {
          clipboardText = await navigator.clipboard.readText();
        } catch {
          // Continue to image clipboard checks below.
        }
      }

      if (navigator.clipboard?.read) {
        try {
          const clipboardItems = await navigator.clipboard.read();
          const imageFile = await getImageFileFromClipboardItems(clipboardItems);
          const shouldUseImage = imageFile && (
            !hasMeaningfulClipboardText(clipboardText || '') ||
            shouldPreferImageOverText(clipboardText || '')
          );
          if (shouldUseImage) {
            const path = await uploadScreenshot(imageFile);
            if (path) {
              await sendKeyRaw(`${quoteTerminalPath(path)} `);
              return;
            }
          }
        } catch {
          // Continue to text fallback below.
        }
      }

      if (hasMeaningfulClipboardText(clipboardText)) {
        await sendKeyRaw(clipboardText);
      }
    } catch (error) {
      console.error('Failed to read clipboard:', error);
    }
  };

  const handleButtonPress = (keyData) => {
    handleKeyPress();

    if (keyData.special && keyData.key === 'paste') {
      handlePaste();
    } else {
      sendKeyRaw(keyData.key);
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
