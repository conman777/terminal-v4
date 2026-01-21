import { useCallback } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { apiFetch } from '../utils/api';

export function TerminalMicButton({ sessionId, disabled, inline = false }) {
  const sendToTerminal = useCallback(async (text) => {
    if (!sessionId || !text) return;

    try {
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: text }
      });
    } catch (error) {
      console.error('Failed to send voice input to terminal:', error);
    }
  }, [sessionId]);

  const { isRecording, isChecking, isRequesting, isTranscribing, error, toggleRecording } = useVoiceInput(sendToTerminal);

  // Determine button state classes
  const buttonClasses = [
    inline ? 'terminal-mic-button-inline' : 'terminal-mic-button',
    isRecording ? 'recording' : '',
    isChecking ? 'checking' : '',
    isRequesting ? 'requesting' : ''
  ].filter(Boolean).join(' ');

  // Icon size based on inline mode
  const iconSize = inline ? 16 : 20;

  // Determine aria label based on state
  const ariaLabel = isChecking
    ? 'Checking API...'
    : isRequesting
      ? 'Requesting microphone access'
      : isRecording
        ? 'Stop recording'
        : 'Start voice input';

  const buttonElement = (
    <button
      type="button"
      onClick={toggleRecording}
      disabled={disabled || isTranscribing || isRequesting || isChecking}
      className={buttonClasses}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {isTranscribing ? (
        <span className="mic-loading">...</span>
      ) : isChecking ? (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      ) : isRequesting ? (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      ) : isRecording ? (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="8" />
        </svg>
      ) : (
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      )}
    </button>
  );

  // Always show error tooltip, even in inline mode
  return (
    <div className={inline ? "terminal-mic-inline-container" : "terminal-mic-container"}>
      {error && <div className="terminal-mic-error">{error}</div>}
      {buttonElement}
    </div>
  );
}
