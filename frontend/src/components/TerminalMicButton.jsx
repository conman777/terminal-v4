import { useCallback } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { apiFetch } from '../utils/api';

export function TerminalMicButton({ sessionId, disabled }) {
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

  const { isRecording, isTranscribing, error, toggleRecording } = useVoiceInput(sendToTerminal);

  return (
    <div className="terminal-mic-container">
      {error && <div className="terminal-mic-error">{error}</div>}
      <button
        type="button"
        onClick={toggleRecording}
        disabled={disabled || isTranscribing}
        className={`terminal-mic-button ${isRecording ? 'recording' : ''}`}
        aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
        title={isRecording ? 'Stop recording' : 'Voice input'}
      >
        {isTranscribing ? (
          <span className="mic-loading">...</span>
        ) : isRecording ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}
      </button>
    </div>
  );
}
