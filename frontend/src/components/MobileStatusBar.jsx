import { useState, useRef, useCallback } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { apiFetch } from '../utils/api';

export function MobileStatusBar({ sessionId, onImageUpload }) {
  const [inputText, setInputText] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const inputRef = useRef(null);

  const sendToTerminal = useCallback(async (text) => {
    if (!sessionId || !text.trim()) return;

    try {
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: text }
      });
      setInputText('');
      setIsExpanded(false);
    } catch (error) {
      console.error('Failed to send input to terminal:', error);
    }
  }, [sessionId]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    sendToTerminal(inputText);
  }, [inputText, sendToTerminal]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToTerminal(inputText);
    } else if (e.key === 'Escape') {
      setIsExpanded(false);
      setInputText('');
    }
  }, [inputText, sendToTerminal]);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => {
      if (!prev) {
        // Focusing after state update
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      return !prev;
    });
  }, []);

  return (
    <div className={`mobile-status-bar ${isExpanded ? 'expanded' : ''}`}>
      {isExpanded ? (
        <form className="mobile-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="mobile-terminal-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type or dictate..."
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
          />
          <button
            type="submit"
            className="mobile-input-send"
            disabled={!inputText.trim()}
            aria-label="Send to terminal"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
          <button
            type="button"
            className="mobile-input-close"
            onClick={() => { setIsExpanded(false); setInputText(''); }}
            aria-label="Close input"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      ) : (
        <>
          <div className="mobile-status-left">
            <span className="status-dot connected" />
          </div>

          <div className="mobile-status-right">
            {/* Type button */}
            <button
              type="button"
              className="mobile-input-toggle"
              onClick={toggleExpanded}
              aria-label="Open text input"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="9" x2="15" y2="9" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <span>Type</span>
            </button>

            {/* Image upload button */}
            <button
              type="button"
              className="status-bar-btn"
              onClick={onImageUpload}
              disabled={!onImageUpload}
              aria-label="Upload image"
              title="Upload image"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>

            {/* Mic button */}
            <TerminalMicButton sessionId={sessionId} inline />
          </div>
        </>
      )}
    </div>
  );
}
