import { useState, useRef, useEffect, useMemo } from 'react';

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
  const textareaRef = useRef(null);

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

      <form className="claude-code-input" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isProcessing ? 'Claude is working...' : 'Type a message... (/ for commands)'}
          aria-label="Claude message"
          disabled={disabled || isProcessing}
          rows={1}
        />
        <button
          type="submit"
          disabled={disabled || isProcessing || !text.trim()}
          className={isProcessing ? 'processing' : ''}
          aria-label="Send message"
        >
          {isProcessing ? '...' : '→'}
        </button>
      </form>
    </div>
  );
}
