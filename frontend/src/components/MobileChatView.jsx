import { useRef, useState, useCallback } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { TerminalMicButton } from './TerminalMicButton';
import { uploadScreenshot } from '../utils/api';
import { getImageFileFromDataTransfer } from '../utils/clipboardImage';
import { apiFetch } from '../utils/api';
import { useConversationScroll } from '../hooks/useConversationScroll';
import './MobileChatView.css';

function SparkleIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z" />
    </svg>
  );
}

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
          const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '');
          return (
            <pre key={i} className="chat-code-block">
              <code>{inner}</code>
            </pre>
          );
        }

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

/** Animated three-dot typing indicator shown while Claude is responding. */
function TypingIndicator() {
  return (
    <div className="chat-typing-indicator">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  );
}

export function MobileChatView({
  turns,
  isStreaming = false,
  onSend,
  onInterrupt,
  onImageUpload,
  sessionId,
  isLoadingHistory = false,
  onViewportStateChange,
}) {
  const { theme } = useTheme();
  const [inputValue, setInputValue] = useState('');
  const [isMicRecording, setIsMicRecording] = useState(false);
  const textareaRef = useRef(null);
  const {
    containerRef,
    bottomRef,
    showScrollBtn,
    handleScroll,
    jumpToBottom,
    markShouldStickToBottom,
  } = useConversationScroll({
    deps: [turns, isStreaming],
    followBehavior: 'auto',
    onViewportStateChange,
  });

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    onSend(text);
    setInputValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    markShouldStickToBottom();
  }, [inputValue, onSend, markShouldStickToBottom]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleInputChange = useCallback((e) => {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  // Handle image paste into the textarea
  const handlePaste = useCallback(async (e) => {
    if (!sessionId || !e.clipboardData) return;
    const imageFile = await getImageFileFromDataTransfer(e.clipboardData);
    if (!imageFile) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const path = await uploadScreenshot(imageFile);
      if (path) {
        await apiFetch(`/api/terminal/${sessionId}/input`, {
          method: 'POST',
          body: { command: `${path} ` }
        });
      }
    } catch (err) {
      console.error('Failed to paste image in chat:', err);
    }
  }, [sessionId]);


  return (
    <div className={`mobile-chat-view ${theme}`}>
      <div
        ref={containerRef}
        className="chat-messages"
        onScroll={handleScroll}
      >
        {turns.length === 0 && !isStreaming && isLoadingHistory && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><SparkleIcon size={22} /></div>
            <p>Loading session history…</p>
          </div>
        )}

        {turns.length === 0 && !isStreaming && !isLoadingHistory && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><SparkleIcon size={22} /></div>
            <p>Send a message — Claude will respond here.</p>
          </div>
        )}

        {turns.map((msg) => (
          <div key={msg.ts} className={`chat-message-row ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="chat-avatar"><SparkleIcon size={13} /></div>
            )}
            <div className={`chat-bubble ${msg.role}`}>
              <div className="chat-bubble-content">
                <ChatMessageContent content={msg.content} />
              </div>
              <div className="chat-timestamp">
                {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          </div>
        ))}

        {/* Typing indicator while Claude is streaming */}
        {isStreaming && (
          <div className="chat-message-row assistant">
            <div className="chat-avatar"><SparkleIcon size={13} /></div>
            <div className="chat-bubble assistant">
              <div className="chat-bubble-content">
                <TypingIndicator />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {showScrollBtn && (
        <button
          type="button"
          className="mobile-scroll-bottom-btn chat-scroll-bottom-btn"
          onClick={() => {
            jumpToBottom();
          }}
          aria-label="Scroll to bottom"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      <div className="chat-input-bar">
        {!isMicRecording && (
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Message Claude…"
            rows={1}
          />
        )}

        {sessionId && (
          <TerminalMicButton
            sessionId={sessionId}
            provider="groq"
            inline
            onRecordingChange={setIsMicRecording}
          />
        )}

        {!isMicRecording && (
          <>
            {onImageUpload && (
              <button
                type="button"
                className="chat-icon-btn"
                onClick={onImageUpload}
                aria-label="Upload image"
                title="Upload image"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
            )}

            {onInterrupt && (
              <button
                type="button"
                className="chat-icon-btn chat-interrupt-btn"
                onClick={onInterrupt}
                aria-label="Interrupt (Ctrl+C)"
                title="Interrupt"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            )}

            <button
              type="button"
              className="chat-send-btn"
              onClick={handleSend}
              disabled={!inputValue.trim()}
              aria-label="Send message"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
