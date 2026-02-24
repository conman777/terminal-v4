import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useAutocorrectInput } from '../hooks/useAutocorrectInput';
import { useAutocorrect } from '../contexts/AutocorrectContext';

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
  const { autocorrectEnabled } = useAutocorrect();
  const { handleKeyDown: autocorrectKeyDown } = useAutocorrectInput(text, setText, autocorrectEnabled);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef(null);

  // Use the shared voice input hook - one per provider
  const handleTranscription = useCallback((transcribedText) => {
    setText(prev => prev + (prev ? ' ' : '') + transcribedText);
    textareaRef.current?.focus();
  }, []);

  const localVoice = useVoiceInput(handleTranscription, { provider: 'local' });
  const groqVoice = useVoiceInput(handleTranscription, { provider: 'groq' });

  // Aggregate states from both providers
  const isRecording = localVoice.isRecording || groqVoice.isRecording;
  const isTranscribing = localVoice.isTranscribing || groqVoice.isTranscribing;
  const isChecking = localVoice.isChecking || groqVoice.isChecking;
  const isRequesting = localVoice.isRequesting || groqVoice.isRequesting;
  const recordingError = localVoice.error || groqVoice.error;

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
    const handled = autocorrectKeyDown(e);
    if (handled) return;

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

  // Determine mic button classes per provider
  const localMicClasses = [
    'mic-button',
    localVoice.isRecording ? 'recording' : '',
    localVoice.isChecking ? 'checking' : '',
    localVoice.isRequesting ? 'requesting' : ''
  ].filter(Boolean).join(' ');

  const groqMicClasses = [
    'mic-button',
    groqVoice.isRecording ? 'recording' : '',
    groqVoice.isChecking ? 'checking' : '',
    groqVoice.isRequesting ? 'requesting' : ''
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

  // Determine aria labels for mic buttons
  const localAriaLabel = localVoice.isChecking ? 'Checking local...' : localVoice.isRequesting ? 'Requesting mic...' : localVoice.isRecording ? 'Stop recording' : 'Voice input (local Whisper)';
  const groqAriaLabel = groqVoice.isChecking ? 'Checking Groq...' : groqVoice.isRequesting ? 'Requesting mic...' : groqVoice.isRecording ? 'Stop recording' : 'Voice input (Groq cloud)';

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
        {/* Local Whisper mic button */}
        <button
          type="button"
          onClick={localVoice.toggleRecording}
          disabled={disabled || isProcessing || isTranscribing || isRequesting || isChecking}
          className={localMicClasses}
          aria-label={localAriaLabel}
          title={localAriaLabel}
        >
          {localVoice.isTranscribing ? '...' : localVoice.isRecording ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          )}
        </button>
        {/* Groq cloud mic button */}
        <button
          type="button"
          onClick={groqVoice.toggleRecording}
          disabled={disabled || isProcessing || isTranscribing || isRequesting || isChecking}
          className={groqMicClasses}
          aria-label={groqAriaLabel}
          title={groqAriaLabel}
        >
          {groqVoice.isTranscribing ? '...' : groqVoice.isRecording ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
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
