# Mobile Chat View — Design Document

**Date:** 2026-02-25
**Status:** Approved

## Overview

A WhatsApp-style chat UI for mobile that renders the active Claude Code terminal session as a conversation. Toggled via a new "Chat" tab in the existing mobile view tabs. Shares the same WebSocket session — no new API calls or sessions.

---

## Approach

**Frontend-only, heuristic turn detection.**

- Intercept outgoing user input to mark user turns
- Buffer incoming WebSocket output into the current assistant turn
- Close assistant turn after ~800ms of output inactivity
- Builds on top of existing `useTerminalBuffer` ANSI stripping infrastructure

No backend changes required.

---

## Architecture

### New hook: `useChatTurns`

Sits alongside the existing terminal WebSocket connection.

- Accepts `onSend` callback from `TerminalChat` (intercepting outgoing input)
- Accepts `onOutputChunk` callback from `TerminalChat` (each incoming output chunk)
- Strips ANSI from output using existing `stripAnsi` logic
- Returns:
  - `turns` — completed `{ role, content, ts }` objects
  - `streamingContent` — in-progress assistant response string

**Turn detection strategy:**
1. User sends input → capture as `{ role: 'user', content, ts }`, start new assistant turn
2. Each output chunk is appended to the current assistant turn buffer
3. After 800ms with no new output → close turn as `{ role: 'assistant', content, ts }`

```js
// Turn shape
{ role: 'user' | 'assistant', content: string, ts: number }
```

### New component: `MobileChatView`

WhatsApp-style scrollable message list with a fixed bottom input bar.

- Renders `turns[]` as chat bubbles
- Renders `streamingContent` as a live streaming bubble
- Input bar sends directly to the terminal session (same as xterm keyboard input)
- Auto-scrolls to bottom as content arrives; pauses auto-scroll if user scrolls up

---

## UI Design

### Layout

```
┌──────────────────────────────────┐
│  [MobileHeader — Chat tab active]│
├──────────────────────────────────┤
│                                  │
│  Claude                          │
│  ┌────────────────────────────┐  │
│  │ Here's the fix I made to   │  │
│  │ your auth middleware...     │  │
│  │                             │  │
│  │ `const token = req.headers` │  │
│  └────────────────────────────┘  │
│  10:42 AM                        │
│                                  │
│                            You   │
│  ┌────────────────────────────┐  │
│  │ Update the middleware       │  │
│  └────────────────────────────┘  │
│                         10:43 AM │
│                                  │
│  Claude  ●●●  (streaming)        │
│  ┌────────────────────────────┐  │
│  │ Sure, I'll update it now▌  │  │
│  └────────────────────────────┘  │
│                                  │
├──────────────────────────────────┤
│  [  Type a message...      ] [➤] │
└──────────────────────────────────┘
```

### Bubble Styling

| Element | Style |
|---|---|
| **User bubble** | Right-aligned, rounded corners, app accent colour (purple/blue), white text |
| **Claude bubble** | Left-aligned, dark grey (dark mode) / light grey (light mode), Claude icon top-left |
| **Streaming bubble** | Same as Claude bubble, blinking cursor `▌` at end of live text |
| **Code blocks** | Monospace font, slightly different background within bubble, horizontally scrollable |
| **Timestamps** | Small, muted grey, below each bubble |

### Input Bar

- Fixed to bottom of screen
- Full-width text field with placeholder "Type a message..."
- Send button on right (arrow icon)
- Matches existing app input styling
- On send: writes directly to terminal session WebSocket

### Toggle

"Chat" tab added alongside existing Terminal / Preview tabs in `MobileHeader` — same pill-style tab design already in use.

### Theme

Fully respects the existing `ThemeContext` (dark/light). No new colour tokens required.

---

## Integration Points

| File | Change |
|---|---|
| `frontend/src/hooks/useChatTurns.js` | **New** — turn detection and state management |
| `frontend/src/components/MobileChatView.jsx` | **New** — chat UI component |
| `frontend/src/components/TerminalChat.jsx` | Add `onSendMessage` + `onOutputChunk` callback props |
| `frontend/src/components/MobileTerminalCarousel.jsx` | Add `chatMode` toggle; render `MobileChatView` when active |
| `frontend/src/components/MobileHeader.jsx` | Add "Chat" tab to view tabs row |

---

## Out of Scope

- Persisting chat history across page reloads
- Desktop chat view
- Markdown rendering beyond bold, inline code, and code blocks
- Backend changes
