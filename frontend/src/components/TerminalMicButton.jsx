import { useCallback, useEffect } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { apiFetch } from '../utils/api';
import { AudioWaveform } from './AudioWaveform';

export function TerminalMicButton({ sessionId, disabled, inline = false, onRecordingChange, onStateChange, provider }) {
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

  const { isRecording, isChecking, isRequesting, isTranscribing, error, audioStream, toggleRecording } = useVoiceInput(sendToTerminal, { provider });

  useEffect(() => {
    onRecordingChange?.(isRecording && !!audioStream);
  }, [isRecording, audioStream, onRecordingChange]);

  useEffect(() => {
    onStateChange?.({
      isRecording,
      isChecking,
      isRequesting,
      isTranscribing,
      error: error || null,
      hasAudioStream: Boolean(audioStream)
    });
  }, [isRecording, isChecking, isRequesting, isTranscribing, error, audioStream, onStateChange]);

  // Icon size based on inline mode
  const iconSize = inline ? 16 : 20;

  // Determine tooltip/aria label based on provider and state
  const providerLabel = provider === 'local' ? 'Voice input (local Whisper)' : provider === 'groq' ? 'Voice input (Groq cloud)' : 'Start voice input';
  const ariaLabel = isChecking
    ? 'Checking API...'
    : isRequesting
      ? 'Requesting microphone access'
      : isRecording
        ? 'Stop recording'
        : providerLabel;

  // Show waveform when recording with active stream
  if (isRecording && audioStream) {
    return (
      <div className={inline ? "terminal-mic-inline-container recording-active" : "terminal-mic-container recording-active"}>
        {error && <div className="terminal-mic-error">{error}</div>}
        <div className="audio-waveform-container">
          <AudioWaveform
            audioStream={audioStream}
            width={inline ? 100 : 140}
            height={inline ? 28 : 36}
            barCount={inline ? 20 : 28}
          />
          <button
            type="button"
            onClick={toggleRecording}
            className={inline ? "terminal-mic-stop-inline" : "terminal-mic-stop"}
            aria-label="Stop recording"
            title="Stop recording"
          >
            <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Determine button state classes
  const buttonClasses = [
    inline ? 'terminal-mic-button-inline' : 'terminal-mic-button',
    isRecording ? 'recording' : '',
    isChecking ? 'checking' : '',
    isRequesting ? 'requesting' : ''
  ].filter(Boolean).join(' ');

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
      ) : provider === 'local' ? (
        // Chip/computer icon for local Whisper
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
          <line x1="20" y1="9" x2="23" y2="9" />
          <line x1="20" y1="14" x2="23" y2="14" />
          <line x1="1" y1="9" x2="4" y2="9" />
          <line x1="1" y1="14" x2="4" y2="14" />
        </svg>
      ) : provider === 'groq' ? (
        // Cloud icon for Groq cloud
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
      ) : (
        // Default mic icon (no provider specified)
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
