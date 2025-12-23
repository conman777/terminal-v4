import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { apiPost } from '../utils/api';

const SLASH_COMMANDS = [
  { cmd: '/model', desc: 'Change AI model' },
  { cmd: '/clear', desc: 'Clear conversation' },
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/compact', desc: 'Toggle compact mode' },
  { cmd: '/cost', desc: 'Show token usage' },
];

export default function ClaudeCodeInput({ onSend, disabled, isProcessing, history = [], onCancel }) {
  const [text, setText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingError, setRecordingError] = useState(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }
  }, [text]);

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

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Clear recording error after 3 seconds
  useEffect(() => {
    if (recordingError) {
      const timer = setTimeout(() => setRecordingError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [recordingError]);

  const startRecording = useCallback(async () => {
    setRecordingError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Try webm first, fall back to other formats
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : 'audio/wav';

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        // Skip if too small (likely no audio)
        if (audioBlob.size < 1000) {
          setRecordingError('No audio recorded');
          return;
        }

        // Send to backend for transcription
        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', audioBlob, `recording.${mimeType.split('/')[1]}`);

          const result = await apiPost('/api/transcribe', formData);

          if (result.text) {
            setText(prev => prev + (prev ? ' ' : '') + result.text);
            textareaRef.current?.focus();
          } else if (result.message) {
            setRecordingError(result.message);
          }
        } catch (error) {
          setRecordingError(error.message || 'Transcription failed');
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        setRecordingError('Microphone access denied');
      } else {
        setRecordingError('Could not start recording');
      }
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (text.trim() && !disabled && !isProcessing) {
      onSend(text);
      setText('');
    }
  };

  const handleComplete = (cmd) => {
    setText(cmd);
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
    const dropdownVisible = suggestions.length > 0 && text !== suggestions[0]?.cmd;
    if (dropdownVisible) {
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length === 1)) {
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

  return (
    <div className="claude-code-input-wrapper">
      {/* Autocomplete dropdown */}
      {suggestions.length > 0 && text !== suggestions[0]?.cmd && (
        <div className="slash-autocomplete">
          {suggestions.map((s, i) => (
            <button
              key={s.cmd}
              type="button"
              className={`slash-option ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => handleComplete(s.cmd)}
            >
              <span className="slash-cmd">{s.cmd}</span>
              <span className="slash-desc">{s.desc}</span>
            </button>
          ))}
        </div>
      )}

      {recordingError && (
        <div className="recording-error">{recordingError}</div>
      )}

      <form className="claude-code-input" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRecording ? 'Recording... tap mic to stop' :
            isTranscribing ? 'Transcribing...' :
            isProcessing ? 'Claude is working...' :
            'Type a message... (/ for commands)'
          }
          aria-label="Claude message"
          disabled={disabled || isProcessing || isRecording || isTranscribing}
          rows={1}
        />
        <button
          type="button"
          onClick={toggleRecording}
          disabled={disabled || isProcessing || isTranscribing}
          className={`mic-button ${isRecording ? 'recording' : ''}`}
          aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
          title={isRecording ? 'Stop recording' : 'Voice input'}
        >
          {isTranscribing ? '...' : isRecording ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
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
