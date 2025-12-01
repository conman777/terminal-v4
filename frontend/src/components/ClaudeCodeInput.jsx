import { useState, useRef, useEffect } from 'react';

export default function ClaudeCodeInput({ onSend, disabled, isProcessing }) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }
  }, [text]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (text.trim() && !disabled && !isProcessing) {
      onSend(text);
      setText('');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form className="claude-code-input" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isProcessing ? 'Claude is working...' : 'Type a message...'}
        disabled={disabled || isProcessing}
        rows={1}
      />
      <button
        type="submit"
        disabled={disabled || isProcessing || !text.trim()}
        className={isProcessing ? 'processing' : ''}
      >
        {isProcessing ? '...' : '→'}
      </button>
    </form>
  );
}

