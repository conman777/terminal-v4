# Mobile Chat View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a WhatsApp-style chat UI on mobile that renders the Claude Code terminal session as a conversation, toggled via a "Chat" tab in the mobile header.

**Architecture:** A new `useChatTurns` hook intercepts outgoing user input and incoming output chunks from the existing `TerminalChat` WebSocket connection. It groups them into `{ role, content, ts }` turns using an 800ms idle timer to close assistant responses. A new `MobileChatView` component renders these turns as styled bubbles with a bottom input bar. No backend changes required.

**Tech Stack:** React, existing WebSocket session infrastructure, custom CSS (project uses BEM-style class names, not Tailwind)

---

## Task 1: Add output + send callbacks to TerminalChat

**Files:**
- Modify: `frontend/src/components/TerminalChat.jsx`

**Step 1: Find the two injection points**

Open `TerminalChat.jsx`. Search for:
1. `enqueueTerminalWrite` — this is called with each decoded output chunk. It is defined near the end of the file.
2. `socket.send` where user input is written — search for the function that sends keystrokes/text to the terminal (likely called `sendToTerminal` or similar, called from keyboard handlers).

**Step 2: Add the two props to the component signature**

Find the props destructuring at the top of the `TerminalChat` component (search for `function TerminalChat({` or the destructured props block). Add two new optional callbacks:

```js
onSendMessage,   // (text: string) => void — called when user sends input
onOutputChunk,   // (raw: string) => void — called with each raw output chunk
```

**Step 3: Call `onOutputChunk` inside `enqueueTerminalWrite`**

Find the `enqueueTerminalWrite` function. At the very start of the function body, after the `if (!data) return;` guard, add:

```js
onOutputChunk?.(data);
```

**Step 4: Call `onSendMessage` when user sends input**

Find where `socket.send` is called with keyboard input (not pings). This is typically in a keydown handler or a `sendData` / `sendToTerminal` helper. After the `socket.send(...)` call, add:

```js
onSendMessage?.(input);
```

Where `input` is the string being sent. If the send path is a function like `const sendToTerminal = (text) => { socket.send(text); }`, add the callback call inside that function.

**Step 5: Verify no regressions by running the dev server**

```bash
cd /home/conor/terminal-v4/frontend && npm run dev
```

Open the app on desktop — confirm terminal still works normally.

**Step 6: Commit**

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/TerminalChat.jsx
git commit -m "feat(chat): add onSendMessage and onOutputChunk callbacks to TerminalChat"
```

---

## Task 2: Create the `useChatTurns` hook

**Files:**
- Create: `frontend/src/hooks/useChatTurns.js`

**Step 1: Write the hook**

Create the file with this content:

```js
import { useState, useRef, useCallback } from 'react';

/**
 * Strips ANSI escape sequences and control characters from raw terminal output.
 * Handles CSI sequences, OSC sequences, and standalone escape chars.
 */
function stripAnsi(str) {
  return str
    // CSI sequences: ESC [ ... final-byte
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: ESC ] ... BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // Remaining 2-char escape sequences
    .replace(/\x1b./g, '')
    // Non-printable control characters except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

const IDLE_TIMEOUT_MS = 800;

/**
 * Tracks terminal I/O and groups it into conversation turns.
 *
 * Usage:
 *   const { turns, streamingContent, handleUserSend, handleOutputChunk } = useChatTurns();
 *
 * Pass handleUserSend as onSendMessage to TerminalChat.
 * Pass handleOutputChunk as onOutputChunk to TerminalChat.
 */
export function useChatTurns() {
  const [turns, setTurns] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');

  const bufferRef = useRef('');
  const idleTimerRef = useRef(null);

  const flushAssistantTurn = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    const content = bufferRef.current.trim();
    if (content) {
      setTurns(prev => [...prev, { role: 'assistant', content, ts: Date.now() }]);
    }
    bufferRef.current = '';
    setStreamingContent('');
  }, []);

  /**
   * Call this when the user sends a message to the terminal.
   * Flushes any in-progress assistant turn first.
   */
  const handleUserSend = useCallback((text) => {
    flushAssistantTurn();
    const cleaned = text.replace(/\r?\n$/, '').trim();
    if (cleaned) {
      setTurns(prev => [...prev, { role: 'user', content: cleaned, ts: Date.now() }]);
    }
  }, [flushAssistantTurn]);

  /**
   * Call this for each raw output chunk arriving from the terminal.
   */
  const handleOutputChunk = useCallback((raw) => {
    const stripped = stripAnsi(raw);
    if (!stripped) return;

    bufferRef.current += stripped;
    setStreamingContent(bufferRef.current);

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(flushAssistantTurn, IDLE_TIMEOUT_MS);
  }, [flushAssistantTurn]);

  const clearTurns = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    bufferRef.current = '';
    setTurns([]);
    setStreamingContent('');
  }, []);

  return { turns, streamingContent, handleUserSend, handleOutputChunk, clearTurns };
}
```

**Step 2: Write a unit test**

Create `frontend/src/hooks/useChatTurns.test.js`:

```js
import { renderHook, act } from '@testing-library/react';
import { useChatTurns } from './useChatTurns';

describe('useChatTurns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a user turn when handleUserSend is called', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleUserSend('hello');
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ]);
  });

  it('accumulates output chunks into streamingContent', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('Hello ');
      result.current.handleOutputChunk('world');
    });

    expect(result.current.streamingContent).toBe('Hello world');
  });

  it('flushes streaming content into an assistant turn after idle timeout', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('Claude response');
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Claude response' }),
    ]);
    expect(result.current.streamingContent).toBe('');
  });

  it('flushes assistant turn immediately when user sends a new message', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('partial response');
    });

    act(() => {
      result.current.handleUserSend('follow up');
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'partial response' }),
      expect.objectContaining({ role: 'user', content: 'follow up' }),
    ]);
  });

  it('strips ANSI codes from output chunks', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('\x1b[32mGreen text\x1b[0m');
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current.turns[0].content).toBe('Green text');
  });
});
```

**Step 3: Run the tests**

```bash
cd /home/conor/terminal-v4/frontend && npx vitest run src/hooks/useChatTurns.test.js
```

Expected: all 5 tests pass.

**Step 4: Commit**

```bash
cd /home/conor/terminal-v4
git add frontend/src/hooks/useChatTurns.js frontend/src/hooks/useChatTurns.test.js
git commit -m "feat(chat): add useChatTurns hook for turn detection"
```

---

## Task 3: Create the `MobileChatView` component

**Files:**
- Create: `frontend/src/components/MobileChatView.jsx`
- Create: `frontend/src/components/MobileChatView.css`

**Step 1: Create the component**

Create `frontend/src/components/MobileChatView.jsx`:

```jsx
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
```

**Step 2: Create the CSS**

Create `frontend/src/components/MobileChatView.css`:

```css
/* ── Container ── */
.mobile-chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--chat-bg, #f0f0f0);
}

.mobile-chat-view.dark {
  --chat-bg: #1a1a1a;
  --chat-bubble-assistant-bg: #2a2a2a;
  --chat-bubble-assistant-color: #e8e8e8;
  --chat-bubble-user-bg: #6c47ff;
  --chat-bubble-user-color: #ffffff;
  --chat-timestamp-color: #888;
  --chat-input-bg: #2a2a2a;
  --chat-input-color: #e8e8e8;
  --chat-input-placeholder: #666;
  --chat-input-bar-bg: #1a1a1a;
  --chat-input-border: #3a3a3a;
  --chat-avatar-bg: #ff6b2b;
  --chat-avatar-color: #fff;
  --chat-code-bg: #1e1e1e;
  --chat-code-color: #d4d4d4;
  --chat-inline-code-bg: #333;
  --chat-send-btn-color: #6c47ff;
  --chat-send-btn-disabled: #444;
}

.mobile-chat-view:not(.dark) {
  --chat-bg: #f0f0f0;
  --chat-bubble-assistant-bg: #ffffff;
  --chat-bubble-assistant-color: #1a1a1a;
  --chat-bubble-user-bg: #6c47ff;
  --chat-bubble-user-color: #ffffff;
  --chat-timestamp-color: #999;
  --chat-input-bg: #ffffff;
  --chat-input-color: #1a1a1a;
  --chat-input-placeholder: #aaa;
  --chat-input-bar-bg: #f8f8f8;
  --chat-input-border: #e0e0e0;
  --chat-avatar-bg: #ff6b2b;
  --chat-avatar-color: #fff;
  --chat-code-bg: #f5f5f5;
  --chat-code-color: #333;
  --chat-inline-code-bg: #eee;
  --chat-send-btn-color: #6c47ff;
  --chat-send-btn-disabled: #ccc;
}

/* ── Message list ── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  -webkit-overflow-scrolling: touch;
}

/* ── Empty state ── */
.chat-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin: auto;
  opacity: 0.5;
  text-align: center;
  color: var(--chat-bubble-assistant-color);
}

.chat-empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--chat-avatar-bg);
  color: var(--chat-avatar-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 20px;
}

/* ── Message row ── */
.chat-message-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.chat-message-row.user {
  flex-direction: row-reverse;
}

/* ── Avatar ── */
.chat-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--chat-avatar-bg);
  color: var(--chat-avatar-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
  margin-bottom: 18px; /* aligns with bottom of bubble above timestamp */
}

/* ── Bubble ── */
.chat-bubble {
  max-width: 78%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-bubble.assistant .chat-bubble-content {
  background: var(--chat-bubble-assistant-bg);
  color: var(--chat-bubble-assistant-color);
  border-radius: 18px 18px 18px 4px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}

.chat-bubble.user .chat-bubble-content {
  background: var(--chat-bubble-user-bg);
  color: var(--chat-bubble-user-color);
  border-radius: 18px 18px 4px 18px;
}

.chat-bubble-content {
  padding: 10px 14px;
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Streaming cursor ── */
.chat-cursor {
  animation: chat-blink 1s step-end infinite;
  margin-left: 1px;
}

@keyframes chat-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ── Timestamp ── */
.chat-timestamp {
  font-size: 11px;
  color: var(--chat-timestamp-color);
  padding: 0 4px;
}

.chat-message-row.user .chat-timestamp {
  text-align: right;
}

/* ── Code blocks ── */
.chat-code-block {
  background: var(--chat-code-bg);
  color: var(--chat-code-color);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 6px 0;
  overflow-x: auto;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  white-space: pre;
  -webkit-overflow-scrolling: touch;
}

.chat-code-block code {
  background: none;
  padding: 0;
}

.chat-inline-code {
  background: var(--chat-inline-code-bg);
  color: inherit;
  border-radius: 4px;
  padding: 1px 5px;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 13px;
}

/* ── Input bar ── */
.chat-input-bar {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 12px;
  background: var(--chat-input-bar-bg);
  border-top: 1px solid var(--chat-input-border);
}

.chat-input {
  flex: 1;
  background: var(--chat-input-bg);
  color: var(--chat-input-color);
  border: 1px solid var(--chat-input-border);
  border-radius: 20px;
  padding: 10px 16px;
  font-size: 15px;
  line-height: 1.4;
  resize: none;
  outline: none;
  font-family: inherit;
  min-height: 40px;
  max-height: 120px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.chat-input::placeholder {
  color: var(--chat-input-placeholder);
}

.chat-send-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: var(--chat-send-btn-color);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s, transform 0.1s;
}

.chat-send-btn:disabled {
  background: var(--chat-send-btn-disabled);
  cursor: not-allowed;
}

.chat-send-btn:not(:disabled):active {
  transform: scale(0.92);
}
```

**Step 3: Verify it renders**

No automated test for the visual output — do a quick sanity check in the next task when wired up. Continue to Task 4.

**Step 4: Commit**

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/MobileChatView.jsx frontend/src/components/MobileChatView.css
git commit -m "feat(chat): add MobileChatView component with WhatsApp-style bubbles"
```

---

## Task 4: Wire up in `MobileTerminalCarousel`

**Files:**
- Modify: `frontend/src/components/MobileTerminalCarousel.jsx`

**Step 1: Add imports at the top**

Add to the existing imports:

```js
import { useChatTurns } from '../hooks/useChatTurns';
import { MobileChatView } from './MobileChatView';
```

**Step 2: Initialise the hook inside the component**

After the existing `useState` declarations (around line 44), add:

```js
const { turns, streamingContent, handleUserSend, handleOutputChunk, clearTurns } = useChatTurns();
```

**Step 3: Add a `chatMode` state**

After the `viewMode` state declaration (line 36), add:

```js
const [chatMode, setChatMode] = useState(false);
```

**Step 4: Create a stable send handler**

After the `handleConnectionChange` callback, add:

```js
const handleChatSend = useCallback((text) => {
  // Write text + newline to the terminal session exactly as if the user typed it
  if (currentSession) {
    // TerminalChat exposes its send function via a ref registered with onRegisterFocusTerminal.
    // However, we need a separate "send text" ref. Add that in Task 4 Step 5.
    sendToTerminalRef.current?.(text + '\n');
  }
}, [currentSession]);
```

**Step 5: Add a `sendToTerminalRef` and expose it from `TerminalChat`**

In `TerminalChat.jsx`, find where the keyboard input handler calls `socket.send` and the component already has `onRegisterFocusTerminal`. Add a new prop `onRegisterSendText` that registers the send function:

```js
// In TerminalChat.jsx, in the props destructure:
onRegisterSendText,

// Inside the component, after the socket is connected and ready, call:
useEffect(() => {
  onRegisterSendText?.((text) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(text);
      onSendMessage?.(text);
    }
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [/* run once when socket is ready */]);
```

Note: Check how `onRegisterFocusTerminal` is implemented in `TerminalChat.jsx` and follow the same pattern for `onRegisterSendText`.

Back in `MobileTerminalCarousel.jsx`, add the ref and handler:

```js
const sendToTerminalRef = useRef(null);
const handleRegisterSendText = useCallback((fn) => {
  sendToTerminalRef.current = fn;
}, []);
```

**Step 6: Pass the new props to `TerminalChat`**

In the `<TerminalChat ... />` JSX (around line 109), add:

```jsx
onSendMessage={handleUserSend}
onOutputChunk={handleOutputChunk}
onRegisterSendText={handleRegisterSendText}
```

**Step 7: Expose `chatMode` / `setChatMode` via the `MobileStatusBar`**

The `MobileStatusBar` already receives `viewMode` and `onToggleViewMode`. We'll add a separate toggle for chat mode. Pass it down:

```jsx
<MobileStatusBar
  ...existing props...
  chatMode={chatMode}
  onToggleChatMode={() => setChatMode(v => !v)}
/>
```

**Step 8: Conditionally render `MobileChatView`**

Replace the `<div className="carousel-content">` block (lines 108–126) with:

```jsx
{/* Terminal content — always mounted to keep the session alive, hidden when in chat mode */}
<div className="carousel-content" style={chatMode ? { display: 'none' } : undefined}>
  <TerminalChat
    key={`${currentSession.id}-${refreshToken}`}
    sessionId={currentSession.id}
    keybarOpen={keybarOpen}
    viewportHeight={viewportHeight}
    onUrlDetected={onUrlDetected}
    fontSize={fontSize}
    webglEnabled={webglEnabled}
    usesTmux={currentSession?.usesTmux}
    viewMode={viewMode}
    onScrollDirection={onScrollDirection}
    onRegisterImageUpload={handleRegisterImageUpload}
    onRegisterHistoryPanel={handleRegisterHistoryPanel}
    onRegisterFocusTerminal={onRegisterFocusTerminal}
    onRegisterSendText={handleRegisterSendText}
    onConnectionChange={handleConnectionChange}
    onActivityChange={(isBusy) => onSessionBusyChange?.(currentSession.id, isBusy)}
    onSendMessage={handleUserSend}
    onOutputChunk={handleOutputChunk}
  />
</div>

{/* Chat view — rendered on top when chatMode is active */}
{chatMode && (
  <MobileChatView
    turns={turns}
    streamingContent={streamingContent}
    onSend={handleChatSend}
  />
)}
```

> **Why keep TerminalChat mounted?** The WebSocket session must remain alive. Hiding via `display: none` keeps it connected while the chat view is shown. This means `onOutputChunk` still fires even when the chat view is visible, which is what we want.

**Step 9: Clear turns when session changes**

Add a `useEffect` that clears turns when `currentSession.id` changes:

```js
useEffect(() => {
  clearTurns();
}, [currentSession?.id, clearTurns]);
```

**Step 10: Commit**

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/MobileTerminalCarousel.jsx frontend/src/components/TerminalChat.jsx
git commit -m "feat(chat): wire useChatTurns into MobileTerminalCarousel"
```

---

## Task 5: Add Chat toggle to `MobileHeader`

**Files:**
- Modify: `frontend/src/components/MobileHeader.jsx`
- Modify: `frontend/src/components/MobileViewTabs.jsx` (check this file exists and what it renders)

**Step 1: Inspect `MobileViewTabs.jsx`**

Read `/home/conor/terminal-v4/frontend/src/components/MobileViewTabs.jsx`. It likely renders the Terminal / Preview tab pills. Note the props it accepts.

**Step 2: Add chat toggle to `MobileHeader` props**

In the `MobileHeader` function signature (line 79), add:

```js
chatMode = false,
onToggleChatMode,
```

**Step 3: Find where `MobileViewTabs` is rendered in `MobileHeader`**

Search for `<MobileViewTabs` in `MobileHeader.jsx`. Pass the new props through, or add the chat toggle button directly adjacent to the view tabs. The simplest approach: add a chat icon button next to the existing view tabs.

If `MobileViewTabs` accepts a custom tab list, add a 'chat' entry. Otherwise, add a standalone toggle button:

```jsx
{/* Chat mode toggle — shown only on mobile */}
<button
  type="button"
  className={`mobile-chat-toggle${chatMode ? ' active' : ''}`}
  onClick={onToggleChatMode}
  title="Chat view"
  aria-label="Toggle chat view"
>
  {/* Chat bubble icon */}
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
</button>
```

Add CSS for `.mobile-chat-toggle` and `.mobile-chat-toggle.active` in the appropriate mobile CSS file (or inline style):

```css
.mobile-chat-toggle {
  padding: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted, #888);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}

.mobile-chat-toggle.active {
  color: var(--accent, #6c47ff);
  background: rgba(108, 71, 255, 0.1);
}
```

**Step 4: Wire `MobileHeader` → `App.jsx` → `MobileTerminalCarousel`**

Search in `App.jsx` for where `MobileHeader` is rendered. It will pass `mobileView` and `onViewChange`. Find where `MobileTerminalCarousel` is rendered nearby.

Pass `chatMode` and `onToggleChatMode` down through the chain:
- `App.jsx` needs a `chatMode` state: `const [chatMode, setChatMode] = useState(false);`
- Pass to `MobileHeader`: `chatMode={chatMode} onToggleChatMode={() => setChatMode(v => !v)}`
- Pass to `MobileTerminalCarousel`: `chatMode={chatMode} onChatModeChange={setChatMode}`

Then in `MobileTerminalCarousel`, change the `chatMode` useState to use the prop if provided:

```js
// Replace internal chatMode state with prop-controlled version
// Props:
chatMode = false,
onChatModeChange,

// Remove internal: const [chatMode, setChatMode] = useState(false);
// Replace setChatMode calls with: onChatModeChange?.(!chatMode)
```

**Step 5: Test the toggle visually**

Run the dev server:
```bash
cd /home/conor/terminal-v4/frontend && npm run dev
```

Open on mobile (or Chrome DevTools mobile emulation at 375px width). Verify:
- [ ] Chat icon appears in the mobile header
- [ ] Tapping it switches to the chat view
- [ ] Tapping again returns to terminal view
- [ ] Typing in chat input box and pressing send adds a user bubble
- [ ] Terminal output appears in assistant bubbles
- [ ] Dark/light theme both look correct

**Step 6: Commit**

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/MobileHeader.jsx frontend/src/components/MobileViewTabs.jsx frontend/src/App.jsx
git commit -m "feat(chat): add chat toggle to mobile header"
```

---

## Task 6: Build and verify

**Step 1: Run the full test suite**

```bash
cd /home/conor/terminal-v4/frontend && npx vitest run
```

Expected: all tests pass, no regressions.

**Step 2: Build for production**

```bash
cd /home/conor/terminal-v4/frontend && npm run build
```

Expected: build succeeds with no errors.

**Step 3: Restart and smoke test**

```bash
~/terminal-v4/restart.sh
```

Open `http://localhost:3020` in Chrome mobile emulation. Run through the QUX checklist:

- [ ] Happy path: Start a Claude Code session, switch to chat view, type a message, see user bubble, see Claude's response in assistant bubble
- [ ] Edge case: Very long response fills the bubble correctly with horizontal-scroll code blocks
- [ ] Edge case: Multiple sessions — switching session clears the chat turns for that session
- [ ] Edge case: Disconnect/reconnect — terminal reconnects, chat view still functional
- [ ] Toggle: Switching back to terminal view shows the xterm terminal at current scroll position
- [ ] Theme: Works in both dark and light mode

**Step 4: Final commit**

```bash
cd /home/conor/terminal-v4
git add -A
git commit -m "feat(chat): mobile WhatsApp-style chat view complete"
```
