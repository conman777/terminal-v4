import { useState, useRef, useCallback } from 'react';
import { TerminalMicButton } from './TerminalMicButton';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { useTerminalSession } from '../contexts/TerminalSessionContext';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { useAutocorrect } from '../contexts/AutocorrectContext';

export function MobileStatusBar({ sessionId, onImageUpload, onOpenHistory, viewMode = 'terminal', onToggleViewMode, isConnected = true }) {
  const [inputText, setInputText] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const inputRef = useRef(null);
  const { sendToSession } = useTerminalSession();
  const { autocorrectEnabled, toggleAutocorrect } = useAutocorrect();
  const { handleKeyDown: autocorrectKeyDown } = useAutocorrectInput(inputText, setInputText, autocorrectEnabled);

  const sendToTerminal = useCallback(async (text) => {
    if (!sessionId || !text.trim()) return;
    const payload = text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\r`;

    try {
      await sendToSession?.(sessionId, payload);
      setInputText('');
      setIsExpanded(false);
    } catch (error) {
      console.error('Failed to send input to terminal:', error);
    }
  }, [sendToSession, sessionId]);

  const sendRawToTerminal = useCallback(async (text) => {
    if (!sessionId || !text) return;
    try {
      await sendToSession?.(sessionId, text);
    } catch (error) {
      console.error('Failed to send raw input to terminal:', error);
    }
  }, [sendToSession, sessionId]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    sendToTerminal(inputText);
  }, [inputText, sendToTerminal]);

  const handleKeyDown = useCallback((e) => {
    const handled = autocorrectKeyDown(e);
    if (handled) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToTerminal(inputText);
    } else if (e.key === 'Escape') {
      setIsExpanded(false);
      setInputText('');
    }
  }, [inputText, sendToTerminal, autocorrectKeyDown]);

  const handlePaste = useCallback(async (e) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;
    const imageFile = await getImageFileFromDataTransfer(clipboardData);

    if (!imageFile) return;

    e.preventDefault();
    e.stopPropagation();
    try {
      const path = await uploadScreenshot(imageFile);
      if (path) {
        await sendRawToTerminal(`${path} `);
      }
    } catch (error) {
      console.error('Failed to paste image in mobile input:', error);
    }
  }, [sendRawToTerminal]);

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
    <div className={`mobile-status-bar ${isExpanded ? 'expanded' : ''} ${isMicRecording ? 'recording' : ''}`}>
      {isExpanded ? (
        <form className="mobile-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="mobile-terminal-input"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
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
          {!isMicRecording && (
            <div className="mobile-status-left">
              <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
            </div>
          )}

          <div className={`mobile-status-right ${isMicRecording ? 'mic-recording-full' : ''}`}>
            {!isMicRecording && (
              <>
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

                {/* Reader view toggle button */}
                <button
                  type="button"
                  className={`status-bar-btn ${viewMode === 'reader' ? 'active' : ''}`}
                  onClick={onToggleViewMode}
                  disabled={!onToggleViewMode}
                  aria-label={viewMode === 'terminal' ? 'Switch to Reader View' : 'Switch to Terminal View'}
                  title={viewMode === 'terminal' ? 'Reader View' : 'Terminal View'}
                >
                  {viewMode === 'terminal' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <line x1="10" y1="9" x2="8" y2="9" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                  )}
                </button>

                {/* Autocorrect toggle button */}
                <button
                  type="button"
                  className={`status-bar-btn ${autocorrectEnabled ? 'active' : ''}`}
                  onClick={toggleAutocorrect}
                  aria-label={autocorrectEnabled ? 'Disable autocorrect' : 'Enable autocorrect'}
                  title={autocorrectEnabled ? 'Autocorrect: On' : 'Autocorrect: Off'}
                >
                  <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1 }}>ABC</span>
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

                {/* History copy panel */}
                <button
                  type="button"
                  className="status-bar-btn"
                  onClick={onOpenHistory}
                  disabled={!onOpenHistory}
                  aria-label="Open history copy panel"
                  title="Open history copy panel"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </>
            )}

            {/* Mic buttons - local Whisper + Groq cloud */}
            <TerminalMicButton sessionId={sessionId} provider="local" inline onRecordingChange={setIsMicRecording} />
            <TerminalMicButton sessionId={sessionId} provider="groq" inline onRecordingChange={setIsMicRecording} />
          </div>
        </>
      )}
    </div>
  );
}
