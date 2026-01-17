import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';

const SLASH_COMMANDS = [
  { cmd: '/model', desc: 'Change AI model' },
  { cmd: '/clear', desc: 'Clear conversation' },
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/compact', desc: 'Toggle compact mode' },
  { cmd: '/cost', desc: 'Show token usage' },
];

export default function ClaudeCodeInput({
  onSend,
  disabled,
  isProcessing,
  history = [],
  onCancel,
  onCommandPreview
}) {
  const [text, setText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef(null);

  // Use the shared voice input hook
  const handleTranscription = useCallback((transcribedText) => {
    setText(prev => prev + (prev ? ' ' : '') + transcribedText);
    textareaRef.current?.focus();
  }, []);

  const { isRecording, isChecking, isRequesting, isTranscribing, error: recordingError, toggleRecording } = useVoiceInput(handleTranscription);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }
  }, [text]);

  useEffect(() => {
    if (onCommandPreview) {
      onCommandPreview(text);
    }
  }, [text, onCommandPreview]);

  // Filter commands based on input
  const suggestions = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const query = text.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.cmd.startsWith(query));
  }, [text]);

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions.length]);

  // Reset history index when history changes or text is manually edited
  useEffect(() => {
    setHistoryIndex(-1);
  }, [history.length]);

  const handleSubmit = (e) => {
    e.preventDefault();

    // On mobile, Enter might bypass keyDown and come straight here
    // If dropdown is visible, complete instead of submit
    if (suggestions.length > 0) {
      setText(suggestions[selectedIndex].cmd + ' ');
      return;
    }

    if (text.trim() && !disabled && !isProcessing) {
      onSend(text);
      setText('');
    }
  };

  const handleComplete = (cmd, addSpace = false) => {
    setText(addSpace ? cmd + ' ' : cmd);
    setSelectedIndex(0);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    // Escape to cancel when processing
    if (e.key === 'Escape') {
      if (isProcessing && onCancel) {
        e.preventDefault();
        onCancel();
        return;
      }
      // Clear text if there's input (slash command or regular)
      if (text) {
        setText('');
        setHistoryIndex(-1);
        return;
      }
    }

    // Handle autocomplete navigation (only when dropdown is visible)
    const dropdownVisible = suggestions.length > 0;
    if (dropdownVisible) {
      // Enter completes the command with a space so user can continue typing
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleComplete(suggestions[selectedIndex].cmd, true);
        return;
      }
      // Tab completes without space
      if (e.key === 'Tab') {
        e.preventDefault();
        handleComplete(suggestions[selectedIndex].cmd);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
    }

    // History navigation (when no suggestions showing)
    if (suggestions.length === 0 && history.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setText(history[history.length - 1 - newIndex] || '');
        return;
      }
      if (e.key === 'ArrowDown' && historyIndex > -1) {
        e.preventDefault();
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setText(newIndex === -1 ? '' : history[history.length - 1 - newIndex]);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Determine mic button classes
  const micButtonClasses = [
    'mic-button',
    isRecording ? 'recording' : '',
    isChecking ? 'checking' : '',
    isRequesting ? 'requesting' : ''
  ].filter(Boolean).join(' ');

  // Determine placeholder text
  const getPlaceholder = () => {
    if (isChecking) return 'Checking API...';
    if (isRequesting) return 'Requesting microphone...';
    if (isRecording) return 'Recording... tap mic to stop';
    if (isTranscribing) return 'Transcribing...';
    if (isProcessing) return 'Claude is working...';
    return 'Type a message... (/ for commands)';
  };

  // Determine aria label for mic button
  const micAriaLabel = isChecking
    ? 'Checking API...'
    : isRequesting
      ? 'Requesting microphone access'
      : isRecording
        ? 'Stop recording'
        : 'Start voice input';

  return (
    <div className="claude-code-input-wrapper">
      {recordingError && (
        <div className="recording-error">{recordingError}</div>
      )}

      {/* Slash command autocomplete dropdown */}
      {suggestions.length > 0 && (
        <div className="slash-autocomplete">
          {suggestions.map((s, i) => (
            <div
              key={s.cmd}
              className={`slash-option${i === selectedIndex ? ' selected' : ''}`}
              onClick={() => handleComplete(s.cmd, true)}
            >
              <span className="slash-cmd">{s.cmd}</span>
              <span className="slash-desc">{s.desc}</span>
            </div>
          ))}
        </div>
      )}

      <form className="claude-code-input" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder()}
          aria-label="Claude message"
          disabled={disabled || isProcessing || isRecording || isTranscribing}
          rows={1}
        />
        <button
          type="button"
          onClick={toggleRecording}
          disabled={disabled || isProcessing || isTranscribing || isRequesting || isChecking}
          className={micButtonClasses}
          aria-label={micAriaLabel}
          title={micAriaLabel}
        >
          {isTranscribing ? '...' : isChecking ? (
            // Pulsing mic icon while checking API
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          ) : isRequesting ? (
            // Pulsing mic icon while requesting permission
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          ) : isRecording ? (
            // Filled circle when recording
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
            // Mic icon when idle
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          )}
        </button>
        <button
          type="submit"
          disabled={disabled || isProcessing || isRecording || isTranscribing || !text.trim()}
          className={isProcessing ? 'processing' : ''}
          aria-label="Send message"
        >
          {isProcessing ? '...' : '→'}
        </button>
      </form>
    </div>
  );
}
