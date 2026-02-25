import { useRef, useEffect, useState, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import './MobileChatView.css';

/**
 * Renders terminal output as a chat message with basic markdown support.
 * Handles ``` code blocks and `inline code`.
 */
function ChatMessageContent({ content }) {
  const codeBlockParts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {codeBlockParts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          // Remove optional language identifier on first line
          const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '');
          return (
            <pre key={i} className="chat-code-block">
              <code>{inner}</code>
            </pre>
          );
        }

        // Inline code within regular text
        const inlineParts = part.split(/(`[^`\n]+`)/g);
        return (
          <span key={i}>
            {inlineParts.map((p, j) => {
              if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
                return <code key={j} className="chat-inline-code">{p.slice(1, -1)}</code>;
              }
              return <span key={j}>{p}</span>;
            })}
          </span>
        );
      })}
    </>
  );
}

export function MobileChatView({ turns, streamingContent, onSend }) {
  const { theme } = useTheme();
  const [inputValue, setInputValue] = useState('');
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const autoScrollRef = useRef(true);
  const textareaRef = useRef(null);

  // Auto-scroll to bottom, but pause if user has scrolled up
  useEffect(() => {
    if (autoScrollRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [turns, streamingContent]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 80;
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    onSend(text);
    setInputValue('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    // Re-enable auto-scroll when user sends
    autoScrollRef.current = true;
  }, [inputValue, onSend]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // Auto-grow textarea up to 5 lines
  const handleInputChange = useCallback((e) => {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const allMessages = [
    ...turns,
    ...(streamingContent
      ? [{ role: 'assistant', content: streamingContent, ts: Date.now(), streaming: true }]
      : []),
  ];

  return (
    <div className={`mobile-chat-view ${theme}`}>
      <div
        ref={containerRef}
        className="chat-messages"
        onScroll={handleScroll}
      >
        {allMessages.length === 0 && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon">C</div>
            <p>Start typing below to chat with Claude.</p>
          </div>
        )}

        {allMessages.map((msg, i) => (
          <div key={i} className={`chat-message-row ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="chat-avatar">C</div>
            )}
            <div className={`chat-bubble ${msg.role}${msg.streaming ? ' streaming' : ''}`}>
              <div className="chat-bubble-content">
                <ChatMessageContent content={msg.content} />
                {msg.streaming && <span className="chat-cursor" aria-hidden="true">▌</span>}
              </div>
              <div className="chat-timestamp">
                {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <div className="chat-input-bar">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
        />
        <button
          type="button"
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!inputValue.trim()}
          aria-label="Send message"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
