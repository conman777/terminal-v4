# Re-Skinned Terminal Conversation UI – Implementation Guide

This document describes, in reproducible detail, how to layer a polished, Claude-style chat interface over a real local shell. Each step explains *what* to do and *why* it matters so future contributors can follow along without context from the original discussion.

---

## 0. Result Overview

When finished, users will:

- Open the web app and see a chat-like view showing command/response history from a real shell (PowerShell/CMD/bash depending on the host).
- Type commands into a text box; the backend forwards them to the shell and streams output back as conversational “terminal” messages.
- Switch between saved sessions to revisit past transcripts.

Architecturally, we add a dedicated terminal subprocess manager on the backend (using `node-pty` for true TTY behavior on Windows) and a React transcript renderer on the frontend.

---

## 1. Prerequisites & Preparation

1. **Verify Node versions**
   - Backend: Node 18+ (already required for the current project).
   - Frontend: Node 18+.
   - Reason: `node-pty` and Vite both rely on modern Node features.

2. **Check Claude-specific code**
   - Ensure no active streams (`/api/chat`) are running before we begin; the new endpoints will follow the existing pattern but operate independently.

3. **Decide default shell**
   - On Windows we will default to `process.env.ComSpec` (PowerShell/CMD). UNIX-like hosts will fall back to `/bin/bash`.
   - Reason: ensures the app works across OSes with minimal configuration.

---

## 2. Backend Changes (Express Server)

### 2.1 Install Dependencies

Run inside `backend/`:

```bash
npm install node-pty uuid
```

- `node-pty`: spawns a pseudo-terminal; crucial for capturing ANSI output and supporting interactive prompts.
- `uuid`: we already rely on `crypto.randomUUID`, but `uuid` will help generate stable session ids for terminal streams if needed.

> *If `node-pty` is already present (check package.json), skip the install; it may have been added for earlier experiments.*

### 2.2 Create Terminal Session Manager

Add `backend/src/terminal-manager.js`:

```js
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { randomUUID } = require('crypto');

const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;

function resolveShell() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();
  }

  createSession(options = {}) {
    const id = options.id || randomUUID();
    const shell = resolveShell();
    const cols = options.cols || DEFAULT_COLS;
    const rows = options.rows || DEFAULT_ROWS;

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env }
    });

    const session = {
      id,
      shell,
      createdAt: new Date().toISOString(),
      process: ptyProcess,
      buffer: [],
      subscribers: new Set()
    };

    ptyProcess.onData((chunk) => {
      session.buffer.push({ type: 'terminal', text: chunk, ts: Date.now() });
      for (const subscriber of session.subscribers) {
        subscriber(chunk);
      }
    });

    ptyProcess.onExit(() => {
      for (const subscriber of session.subscribers) {
        subscriber(null); // signal end of stream
      }
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(({ id, shell, createdAt, buffer }) => ({
      id,
      shell,
      createdAt,
      history: buffer
    }));
  }

  subscribe(id, handler) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.process.write(data);
  }
}

module.exports = { TerminalManager };
```

**Why:** This module encapsulates all PTY concerns—spawning, tracking history, pushing updates to SSE subscribers.

### 2.3 Expose Terminal Routes

Create `backend/src/routes/terminal.js`:

```js
const express = require('express');
const stripAnsi = require('strip-ansi');

function createTerminalRouter(terminalManager) {
  const router = express.Router();

  router.post('/', (req, res) => {
    const { cwd, cols, rows } = req.body || {};
    const session = terminalManager.createSession({ cwd, cols, rows });
    res.status(201).json({ sessionId: session.id });
  });

  router.get('/:id/history', (req, res) => {
    const session = terminalManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      id: session.id,
      shell: session.shell,
      createdAt: session.createdAt,
      history: session.buffer.map((entry) => ({
        role: entry.type,
        text: entry.text,
        plain: stripAnsi(entry.text),
        ts: entry.ts
      }))
    });
  });

  router.post('/:id/input', (req, res) => {
    const { command } = req.body || {};
    if (typeof command !== 'string') {
      res.status(400).json({ error: 'Command must be a string' });
      return;
    }
    try {
      terminalManager.write(req.params.id, `${command}\r`);
      res.status(204).end();
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  router.get('/:id/stream', (req, res) => {
    const session = terminalManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const send = (chunk) => {
      if (chunk === null) {
        res.write('event: end\n');
        res.write('data: {}\n\n');
        res.end();
        return;
      }
      res.write('event: data\n');
      res.write(`data: ${JSON.stringify({ text: chunk, plain: stripAnsi(chunk) })}\n\n`);
    };

    const unsubscribe = terminalManager.subscribe(session.id, send);
    req.on('close', unsubscribe);

    // Immediately flush existing buffer so the UI can hydrate the transcript.
    session.buffer.forEach((entry) => send(entry.text));
  });

  return router;
}

module.exports = { createTerminalRouter };
```

Dependencies:

```bash
npm install strip-ansi
```

**Why:** Provides REST endpoints for session lifecycle, command input, and live streaming. Using SSE keeps the backend aligned with the existing Claude streaming implementation.

### 2.4 Wire Routes into `server.js`

Modify `backend/src/server.js`:

```diff
 const { SessionStore } = require('./session-store');
 const { createTerminalRouter } = require('./routes/terminal');
 const { TerminalManager } = require('./terminal-manager');

 const terminalManager = new TerminalManager();

 app.use('/api/terminal', createTerminalRouter(terminalManager));
```

Add these near the top alongside existing imports. This ensures the terminal API lives under `/api/terminal` (e.g., `/api/terminal/:id/stream`).

**Why:** The frontend will call these endpoints independently of the Claude chat API.

### 2.5 Update Session List Endpoint (Optional)

If you want terminal sessions to appear in the left sidebar alongside Claude sessions, extend `SessionStore` or create a separate list. For now, keep them distinct so the UI can manage terminals explicitly.

---

## 3. Frontend Changes (React)

### 3.1 Data Model

- `TerminalSession`: `{ id, shell, createdAt, history: Array<{ role: 'terminal', text, plain, ts }> }`
- `TerminalEntry`: `role` indicates whether text was user input or terminal output. We’ll add user entries manually when commands are sent.

### 3.2 Create Terminal Hook

Add `frontend/src/hooks/useTerminalStream.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';

export function useTerminalStream(sessionId) {
  const [events, setEvents] = useState([]);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return undefined;
    }

    const source = new EventSource(`/api/terminal/${sessionId}/stream`);
    eventSourceRef.current = source;

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      setEvents((prev) => [...prev, { role: 'terminal', ...payload }]);
    };

    source.addEventListener('end', () => {
      source.close();
    });

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, [sessionId]);

  return events;
}
```

**Why:** Centralizes SSE lifecycle management; components stay simple.

### 3.3 Build Terminal View Component

Create `frontend/src/components/TerminalChat.jsx`:

```jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalStream } from '../hooks/useTerminalStream';

export function TerminalChat({ sessionId }) {
  const logRef = useRef(null);
  const streamEvents = useTerminalStream(sessionId);
  const [history, setHistory] = useState([]);
  const [command, setCommand] = useState('');

  useEffect(() => {
    if (!sessionId) {
      setHistory([]);
      return;
    }

    (async () => {
      const response = await fetch(`/api/terminal/${sessionId}/history`);
      if (response.ok) {
        const data = await response.json();
        setHistory(data.history.map((entry) => ({ role: 'terminal', text: entry.plain })));
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    if (streamEvents.length === 0) return;
    setHistory((prev) => [...prev, ...streamEvents.map((entry) => ({ role: 'terminal', text: entry.plain }))]);
  }, [streamEvents]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [history]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || !sessionId) return;

    setHistory((prev) => [...prev, { role: 'user', text: trimmed }]);
    setCommand('');

    await fetch(`/api/terminal/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: trimmed })
    });
  };

  const groupedHistory = useMemo(() => history.map((entry, index) => ({ ...entry, id: `log-${index}` })), [history]);

  return (
    <div className="terminal-chat">
      <div ref={logRef} className="terminal-log">
        {groupedHistory.map((entry) => (
          <div key={entry.id} className={`terminal-line ${entry.role}`}>
            {entry.text}
          </div>
        ))}
      </div>
      <form className="terminal-input" onSubmit={handleSubmit}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Type a shell command…"
        />
        <button type="submit" disabled={!command.trim()}>Send</button>
      </form>
    </div>
  );
}
```

### 3.4 Integrate into `App.jsx`

1. Import the new component.
2. Provide UI controls to create/start terminal sessions and render `TerminalChat` when one is active.

Example diff snippet:

```diff
-import ReactMarkdown from 'react-markdown';
-import remarkGfm from 'remark-gfm';
-import { Highlight, themes } from 'prism-react-renderer';
+import { TerminalChat } from './components/TerminalChat';

// ... existing Claude components stay intact

function App() {
  // existing state hooks
  const [terminalSessionId, setTerminalSessionId] = useState(null);

  const launchTerminalSession = async () => {
    const response = await fetch('/api/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) {
      console.error('Failed to start terminal session');
      return;
    }
    const data = await response.json();
    setTerminalSessionId(data.sessionId);
  };

  return (
    <div className="layout">
      {/* existing sidebar */}
      <div className="main-pane">
        {/* existing Claude header */}
        <section className="terminal-wrapper">
          <header>
            <h3>Local Shell</h3>
            <button type="button" onClick={launchTerminalSession}>New Terminal Session</button>
          </header>
          {terminalSessionId ? (
            <TerminalChat sessionId={terminalSessionId} />
          ) : (
            <p className="terminal-placeholder">Launch a terminal session to see streaming output.</p>
          )}
        </section>
        {/* existing Claude chat composer remains below */}
      </div>
    </div>
  );
}
```

**Why:** Keeps Claude functionality untouched while embedding the terminal transcript in the same page (mirroring the Claude UI screenshot shared earlier).

### 3.5 Styling

Extend `frontend/src/styles.css` (or Tailwind config) with classes referenced above:

```css
.terminal-wrapper {
  margin-top: 1.5rem;
  background: #1a1a1f;
  border: 1px solid #2a2a32;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.terminal-wrapper header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #f5f5f5;
}

.terminal-chat {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.terminal-log {
  max-height: 320px;
  overflow-y: auto;
  background: #111118;
  border-radius: 8px;
  padding: 1rem;
  font-family: 'Fira Code', 'Courier New', monospace;
  white-space: pre-wrap;
}

.terminal-line.user {
  color: #8be9fd;
}

.terminal-line.terminal {
  color: #f8f8f2;
}

.terminal-input {
  display: flex;
  gap: 0.5rem;
}

.terminal-input input {
  flex: 1;
  background: #0d0d12;
  border: 1px solid #2a2a32;
  border-radius: 6px;
  padding: 0.75rem;
  color: #f5f5f5;
}

.terminal-input button {
  background: #5c6bff;
  border: none;
  border-radius: 6px;
  padding: 0.75rem 1.25rem;
  color: #fff;
  cursor: pointer;
}
```

**Why:** Matches the dark, high-contrast styling consistent with Claude Code screenshots.

---

## 4. Session Refresh Logic

The terminal manager already preserves history in memory. If we want sessions to persist across reloads, later iterations can serialize `session.buffer` to disk or integrate with the existing `SessionStore` model. For the initial implementation, in-memory storage keeps things simple.

Recommended follow-up task (future): extend `SessionStore` or create a `TerminalSessionStore` module that saves transcripts to JSON on disk.

---

## 5. Testing Checklist

1. **Backend unit check**
   - `npm test` inside `backend/` (if a suite exists) or run ESLint to ensure new files pass lint rules.
2. **Manual shell test**
   - Start the backend (`npm start` in `backend/`) and frontend (`npm run dev` in `frontend/`).
   - Open the web app, click “New Terminal Session”, run commands like `dir` (Windows) or `ls` (macOS/Linux).
   - Confirm output streams in real time and appears in the transcript.
3. **Session cleanup**
   - Close the browser tab; ensure PTY processes exit (check backend logs). If they do not, add cleanup logic to `req.on('close')` in the SSE route.
4. **ANSI rendering**
   - Run `npx cowsay hello` or commands with colors to verify `strip-ansi` handling. Adjust styling if needed to highlight prompts vs. output.

---

## 6. Documentation & Communication

- Update `README.md` with instructions for launching terminal sessions.
- Consider embedding animated GIFs/screenshots showing the chat-style terminal in action.
- Mention Windows-specific considerations (PowerShell prompts, command endings): we append `\r` when writing to the PTY to satisfy Windows shells.

---

## 7. Future Enhancements (Backlog)

- **Session persistence:** write transcripts to disk (JSON) for rehydration.
- **Multiple concurrent shells:** allow launching more than one terminal and pick from a dropdown.
- **Command shortcuts:** quick buttons for `npm run dev`, `git status`, etc.
- **ANSI color rendering:** convert to HTML spans instead of stripping, preserving styling.
- **Permission controls:** restrict allowed commands or directories if exposing beyond localhost.

---

Following the steps above will deliver the “terminal conversation” experience showcased in the screenshot, while keeping the codebase modular and ready for further Claude-specific integrations.

