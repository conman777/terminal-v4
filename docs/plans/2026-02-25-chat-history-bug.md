# Bug: Mobile Chat View Shows Empty State Despite Active Terminal Session

## Problem

The mobile chat view (`MobileChatView`) shows "Start typing below to chat with Claude" (empty state) even when the terminal session has an active conversation with history. The user expects to see their existing conversation rendered as chat bubbles.

## Current Architecture

The chat view works via a pipeline:

```
TerminalChat.jsx (WebSocket + xterm.js)
  → onOutputChunk(raw) callback fires with each output chunk
  → useChatTurns hook strips ANSI, buffers output, groups into turns via 800ms idle timer
  → MobileChatView renders turns[] as chat bubbles
```

**The hook also receives:**
- `onSendMessage(text)` — fired when user sends input, creates a user turn

**The component tree:**
```
MobileTerminalCarousel
  ├── TerminalChat (always mounted, hidden with display:none in chat mode)
  │     ├── onOutputChunk={handleOutputChunk}  ← from useChatTurns
  │     ├── onSendMessage={handleUserSend}     ← from useChatTurns
  │     └── onRegisterSendText={...}           ← for chat input to send to terminal
  └── MobileChatView (rendered when chatMode=true)
        ├── turns={turns}
        ├── streamingContent={streamingContent}
        └── onSend={handleChatSend}
```

## What We've Tried

We added `onOutputChunkRef.current?.(historyText)` calls to three output paths in `TerminalChat.jsx` that bypass `enqueueTerminalWrite`:

1. **`writeHistoryChunks` initial load** (line ~1800) — when the terminal first connects and loads history from the API
2. **Scroll-to-top history reload** (line ~1873) — when user scrolls to top and more history is loaded
3. **`flushPendingSocketData`** (line ~1740) — accumulated socket data flushed after history load
4. **Incremental history page load** (line ~1912) — polling for new history entries

Despite these patches, the chat view still shows empty.

## Key Files

| File | Role |
|---|---|
| `frontend/src/components/TerminalChat.jsx` | Core terminal — WebSocket, xterm, history loading |
| `frontend/src/hooks/useChatTurns.js` | Turn detection hook — strips ANSI, groups I/O into turns |
| `frontend/src/components/MobileChatView.jsx` | Chat UI — renders turns as bubbles |
| `frontend/src/components/MobileTerminalCarousel.jsx` | Wiring layer — connects hook to TerminalChat and MobileChatView |

## Investigation Tasks

### 1. Trace the actual history loading flow

Read `TerminalChat.jsx` and trace exactly what happens when a session connects:
- When does `fetchHistoryPage()` get called?
- What is `historyTextRef.current` at that point?
- Does `writeHistoryChunks(historyText)` get called with non-empty text?
- Is `onOutputChunkRef.current` non-null when it fires?
- Add `console.log` statements if needed to verify the data flow

### 2. Check for timing/ordering issues

The concern is that `onOutputChunkRef` might not be set when history loads:
- `onOutputChunkRef` is initialized as `useRef(onOutputChunk)` at render time
- The main `useEffect` (which creates the WebSocket) runs after render
- History loading is async (awaits API call)
- Check: is there a race where `onOutputChunk` prop is `undefined` on first render?

In `MobileTerminalCarousel.jsx`, check that `handleOutputChunk` (from `useChatTurns`) is a stable function reference passed to `TerminalChat` — it should be, since it's wrapped in `useCallback`.

### 3. Check if `stripAnsi` is filtering out all content

The `stripAnsi` function in `useChatTurns.js` strips ANSI codes. Terminal history contains raw ANSI escape sequences. It's possible that:
- The regex strips too aggressively, leaving empty strings
- The `if (!stripped) return;` guard filters out everything
- The history text is entirely ANSI codes with no printable content

Test: log `raw.length` and `stripped.length` inside `handleOutputChunk` to see if data arrives but gets stripped away.

### 4. Check if `clearTurns` is wiping the data

In `MobileTerminalCarousel.jsx`, there's a `useEffect` that calls `clearTurns()` when `currentSession?.id` changes:

```js
useEffect(() => {
  clearTurns();
}, [currentSession?.id, clearTurns]);
```

This runs on mount too. If history loads, turns accumulate, and then this effect fires (React batches effects), it could wipe the turns. Check the ordering of effects.

### 5. Check if `handleOutputChunk` is actually being called

The simplest test: add a temporary `console.log('onOutputChunk called', raw.substring(0, 100))` at the top of `handleOutputChunk` in `useChatTurns.js`. Then reload the page on mobile and check the browser console.

If it's NOT called → the issue is in `TerminalChat.jsx` (the callback isn't firing)
If it IS called → the issue is in the hook logic (data arrives but doesn't become turns)

## Expected Outcome

When the user opens the mobile chat view on a session with existing conversation history, they should see the conversation content rendered as chat bubbles. It's acceptable for the initial history to appear as a single assistant message (since we can't distinguish past user/assistant turns from raw terminal output), but the content must be visible.
