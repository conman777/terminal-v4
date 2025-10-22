# Claude Code Web UI - Project Plan

## Vision & Goal

### What We're Building
A **web-based skin/interface for Claude Code CLI** that hides the raw terminal experience and provides users with a clean, modern UI to interact with Claude Code through their browser.

Think of it like this:
- **Instead of:** Opening a terminal → typing `claude` → seeing raw CLI output
- **Users get:** Opening a website → typing in a chat box → seeing a polished UI (like the Claude Code desktop app)

### The Core Problem We're Solving
Claude Code CLI is powerful but requires:
1. Terminal/command prompt knowledge
2. Comfort with command-line interfaces
3. Seeing raw text output and tool execution logs

Many users want Claude Code's capabilities but prefer a **GUI/web interface** like they're used to with ChatGPT, VS Code, or other modern tools.

### What Success Looks Like (v0.1)
A user can:
1. Visit a web page
2. See a chat interface (similar to the Claude Code desktop app screenshot)
3. Type a message/request
4. See Claude Code's response in real-time
5. See what files Claude is reading/editing with visual indicators
6. Get all the power of Claude Code CLI without touching a terminal

### Key Constraints
- ✅ **Must use local Claude Code CLI** (no Anthropic API calls)
- ✅ **No API costs** - runs entirely on user's machine
- ✅ **Simple architecture** - easy to understand and maintain
- ✅ **Real-time updates** - see what Claude is doing as it happens

---

## Technical Architecture

### High-Level Flow

```
┌─────────────────────┐         HTTP/SSE         ┌──────────────────┐
│   React Frontend    │ <────────────────────> │  Express Backend │
│   (Browser UI)      │   POST /api/chat        │   (Node.js)      │
│                     │   GET /api/sessions     │                  │
└─────────────────────┘                          └────────┬─────────┘
                                                          │
                                                    spawn()
                                                          │
                                                ┌─────────▼─────────┐
                                                │   Claude Code CLI  │
                                                │  --output-format   │
                                                │   stream-json      │
                                                └───────────────────┘
```

### Why This Architecture?

**Research Finding:** Claude Code CLI supports:
- `--output-format json` - Structured JSON output (no terminal parsing!)
- `--output-format stream-json` - Real-time streaming JSON
- `--allowedTools` - Control which tools Claude can use
- `--continue <session-id>` - Resume previous conversations
- `--dangerously-skip-permissions` - Auto-approve tools (for controlled environments)

This means we can **spawn Claude CLI as a subprocess** and get clean, parseable output without complex PTY (pseudo-terminal) management.

---

## Implementation Plan

### Phase 1: Backend Foundation (Express Server)

**Goal:** Create a Node.js server that can spawn Claude CLI and stream responses

**Components:**

1. **API Endpoint: POST /api/chat**
   ```javascript
   // Receives: { message: string, sessionId?: string, allowedTools?: string[] }
   // Returns: Server-Sent Events stream of Claude's responses
   ```

2. **Claude CLI Wrapper**
   ```javascript
   function spawnClaude(message, options) {
     const args = [
       '-p', message,
       '--output-format', 'stream-json',
       '--allowedTools', options.allowedTools.join(','),
     ];

     if (options.sessionId) {
       args.push('--continue', options.sessionId);
     }

     return spawn('claude', args);
   }
   ```

3. **JSON Stream Parser**
   - Parse line-by-line JSON from Claude's stdout
   - Convert to Server-Sent Events format
   - Handle errors gracefully

4. **Session Management (Optional for v0.1)**
   - Store session IDs
   - Allow resuming conversations
   - Basic in-memory storage (can add DB later)

**Tech Stack:**
- Express.js (web server)
- `child_process` (spawn Claude CLI)
- Server-Sent Events (SSE) for streaming

---

### Phase 2: Frontend UI (React)

**Goal:** Build a clean, modern chat interface that looks like Claude Code desktop app

**Components:**

1. **Main Layout**
   ```
   ┌────────────────────────────────────────┐
   │  Claude Code                           │
   ├──────────┬─────────────────────────────┤
   │          │                             │
   │ Sessions │    Chat Messages Area       │
   │  List    │                             │
   │          │                             │
   │          │                             │
   │          ├─────────────────────────────┤
   │          │  Input Box                  │
   └──────────┴─────────────────────────────┘
   ```

2. **Chat Message Component**
   - User message bubbles
   - Claude response bubbles
   - Tool execution indicators (e.g., "✓ Read /path/to/file.tsx - Read 605 lines")
   - Code blocks with syntax highlighting
   - Markdown rendering

3. **Input Component**
   - Text area for user input
   - Send button
   - Auto-resize as user types
   - Keyboard shortcuts (Enter to send, Shift+Enter for newline)

4. **Sessions Sidebar**
   - List of conversation sessions
   - Click to switch sessions
   - New session button
   - Session titles (auto-generated from first message)

5. **Tool Activity Display**
   - Real-time updates as Claude uses tools
   - Green checkmarks for completed actions
   - File paths with line counts
   - Color-coded by tool type (Read=green, Write=blue, Edit=yellow, etc.)

**Tech Stack:**
- React (UI framework)
- Vite (build tool)
- Tailwind CSS (styling - for easy dark mode)
- react-markdown (render Claude's markdown responses)
- prism-react-renderer (syntax highlighting for code blocks)

---

### Phase 3: Integration & Real-time Communication

**Goal:** Connect frontend and backend with real-time streaming

**Server-Sent Events (SSE) Flow:**

1. **Frontend sends message:**
   ```javascript
   const response = await fetch('/api/chat', {
     method: 'POST',
     body: JSON.stringify({ message: 'Help me fix this bug' })
   });

   const reader = response.body.getReader();
   // Read stream and update UI in real-time
   ```

2. **Backend streams responses:**
   ```javascript
   res.setHeader('Content-Type', 'text/event-stream');

   claude.stdout.on('data', (chunk) => {
     const lines = chunk.toString().split('\n');
     lines.forEach(line => {
       if (line.trim()) {
         const json = JSON.parse(line);
         res.write(`data: ${JSON.stringify(json)}\n\n`);
       }
     });
   });
   ```

3. **Frontend receives and displays:**
   ```javascript
   // Parse SSE events
   // Update chat UI with new messages
   // Show tool execution indicators
   // Auto-scroll to bottom
   ```

---

## File Structure

```
terminal-v4/
├── backend/
│   ├── server.js              (existing - may need modifications)
│   ├── claude-wrapper.js      (NEW - Claude CLI spawn logic)
│   ├── session-manager.js     (NEW - session storage)
│   └── routes/
│       └── chat.js            (NEW - /api/chat endpoint)
│
├── frontend/                  (NEW - React app)
│   ├── src/
│   │   ├── App.jsx           (main layout)
│   │   ├── components/
│   │   │   ├── ChatMessage.jsx
│   │   │   ├── ChatInput.jsx
│   │   │   ├── SessionsList.jsx
│   │   │   ├── ToolActivity.jsx
│   │   │   └── Layout.jsx
│   │   ├── hooks/
│   │   │   └── useClaudeChat.js  (SSE connection logic)
│   │   └── utils/
│   │       └── parseClaudeOutput.js
│   ├── public/
│   ├── package.json
│   └── vite.config.js
│
├── plan.md                    (this file)
└── package.json
```

---

## Security Considerations

### For v0.1 (Local Development Only)

Since v0.1 will run on the user's **own machine** connecting to their **own local Claude CLI**:

1. **Tool Permissions**
   - Start with read-only tools: `--allowedTools Read,Glob,Grep`
   - User can expand permissions in settings later
   - Display warning when enabling dangerous tools (Bash, Write, etc.)

2. **Path Validation**
   - Ensure Claude stays within project directory
   - Warn if accessing files outside workspace

3. **Rate Limiting**
   - Prevent accidental spam (e.g., max 10 requests/minute)
   - Prevent runaway loops with `--max-turns` flag

### For Future Production Deployment

If you ever want to host this publicly:

1. **Container Isolation**
   - Run each Claude instance in Docker container
   - Isolated file systems per user
   - Network restrictions

2. **Authentication**
   - User accounts
   - API key management
   - Session security

3. **Resource Limits**
   - CPU/memory caps per session
   - Timeout limits
   - Storage quotas

---

## Development Phases

### ✅ Phase 0: Research (COMPLETED)
- ✅ Understand Claude Code CLI capabilities
- ✅ Research existing solutions (AgentAPI, claude-code-webui)
- ✅ Choose architecture (JSON subprocess)

### 📋 Phase 1: Minimal Backend (Week 1)
**Goal:** Spawn Claude CLI and get JSON output

Tasks:
1. Set up Express server
2. Create `/api/chat` endpoint
3. Implement `spawnClaude()` function
4. Parse JSON stream from Claude stdout
5. Return responses via SSE
6. Test with curl/Postman

**Success Criteria:**
- Can send "Hello Claude" and get response via API
- Can see tool execution in JSON format
- No crashes, proper error handling

---

### 📋 Phase 2: Basic Frontend (Week 2)
**Goal:** Simple chat UI that connects to backend

Tasks:
1. Create React app with Vite
2. Build basic chat layout (no sidebar yet)
3. Implement message sending
4. Display Claude's responses
5. Show tool activity indicators
6. Add basic styling with Tailwind

**Success Criteria:**
- Can type message and see Claude's response
- Can see when Claude reads/writes files
- Basic dark theme
- Mobile-responsive

---

### 📋 Phase 3: Polish & Features (Week 3)
**Goal:** Match the Claude Code desktop app experience

Tasks:
1. Add sessions sidebar
2. Implement session switching
3. Add markdown rendering
4. Add syntax highlighting for code
5. Improve UI/UX (animations, loading states)
6. Add settings panel (allowed tools, themes)
7. Handle errors gracefully
8. Add keyboard shortcuts

**Success Criteria:**
- Looks and feels like Claude Code desktop app
- Can manage multiple sessions
- Code is readable and highlighted
- Smooth, polished experience

---

### 📋 Phase 4: Deployment & Documentation (Week 4)
**Goal:** Make it easy for others to use

Tasks:
1. Write README with setup instructions
2. Create installation script
3. Add environment variable configuration
4. Test on Windows/Mac/Linux
5. Create demo video/screenshots
6. Package as Electron app (optional)

**Success Criteria:**
- Anyone can clone repo and run locally in <5 minutes
- Clear documentation
- Works on all major OS

---

## Technology Choices

### Backend
- **Runtime:** Node.js v18+
- **Framework:** Express.js (lightweight, familiar)
- **Process Management:** `child_process.spawn()`
- **Streaming:** Server-Sent Events (SSE)
  - *Why not WebSocket?* SSE is simpler for one-way streaming (backend → frontend)
  - Can upgrade to WebSocket later if needed for bidirectional control

### Frontend
- **Framework:** React 18+
- **Build Tool:** Vite (fast, modern, great DX)
- **Styling:** Tailwind CSS (rapid prototyping, easy dark mode)
- **Markdown:** react-markdown + remark-gfm
- **Code Highlighting:** prism-react-renderer
- **HTTP Client:** Fetch API (native, supports streaming)

### Why NOT Use:
- ❌ **PTY (node-pty):** Overkill for v0.1, adds complexity
- ❌ **Anthropic SDK:** Requires API, defeats "local CLI" requirement
- ❌ **Next.js:** Too heavy for simple SPA
- ❌ **GraphQL:** REST + SSE is simpler

---

## Open Questions & Decisions Needed

### 1. Session Storage
**Question:** Where to store conversation history?

**Options:**
- A) In-memory (simple, lost on restart)
- B) SQLite (persistent, lightweight)
- C) File system (JSON files per session)

**Recommendation:** Start with A (in-memory), add B later

---

### 2. Claude Installation Detection
**Question:** How to handle users who don't have Claude CLI installed?

**Options:**
- A) Show error message with installation instructions
- B) Auto-install Claude CLI via npm
- C) Bundle Claude CLI with the app

**Recommendation:** A for v0.1

---

### 3. Multi-User Support
**Question:** Should v0.1 support multiple users?

**Options:**
- A) Single-user (localhost only)
- B) Multi-user with authentication

**Recommendation:** A for v0.1 (localhost), B for v1.0

---

### 4. Tool Permission Management
**Question:** How should users control which tools Claude can use?

**Options:**
- A) Hardcoded safe defaults (Read, Glob, Grep)
- B) Settings panel in UI
- C) Prompt user before each dangerous tool use

**Recommendation:** A for v0.1, add B in Phase 3

---

### 5. Existing Terminal App Integration
**Question:** Should this integrate with your existing `terminal-app/` code?

**Context:** You have existing backend/terminal-bridge.js with tmux/Docker support

**Options:**
- A) Keep separate (new clean codebase)
- B) Integrate with existing terminal infrastructure
- C) Share backend, separate frontends

**Recommendation:** Need your input - what's your existing terminal app for?

---

## Next Steps

### Before Starting Development

1. **Answer open questions** (especially #5 about existing terminal app)
2. **Verify Claude CLI is installed** and working locally
3. **Test CLI flags:**
   ```bash
   claude -p "Hello" --output-format json
   claude -p "Read package.json" --output-format stream-json --allowedTools Read
   ```
4. **Choose project name** (claude-code-web-ui? claude-web? something else?)

### Week 1 Kickoff Tasks

1. Create `backend/claude-wrapper.js`
2. Add `/api/chat` endpoint to existing server.js (or new server)
3. Test streaming JSON output
4. Set up React frontend with Vite
5. Get basic "Hello World" working end-to-end

---

## Success Metrics

### v0.1 Launch Criteria

- [ ] User can send messages and get responses
- [ ] Real-time streaming works (see responses as Claude types)
- [ ] Tool activity is visible (file reads, edits, etc.)
- [ ] Basic dark theme matches Claude Code desktop app aesthetic
- [ ] No crashes for common operations
- [ ] Works on localhost for single user
- [ ] README with clear setup instructions

### Future Goals (Post-v0.1)

- [ ] Multi-session management
- [ ] Persistent conversation history
- [ ] Settings panel for customization
- [ ] Keyboard shortcuts
- [ ] Mobile-responsive design
- [ ] Electron app packaging
- [ ] Multi-user deployment option
- [ ] Docker container support

---

## Resources & References

### Existing Solutions (for inspiration)
- **AgentAPI:** https://github.com/coder/agentapi
- **claude-code-webui:** https://github.com/sugyan/claude-code-webui

### Documentation
- **Claude Code CLI:** https://docs.claude.com/en/docs/claude-code/
- **Server-Sent Events:** https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
- **React Streaming:** https://react.dev/reference/react-dom/server/renderToReadableStream

### Tech Stack Docs
- **Express:** https://expressjs.com/
- **Vite:** https://vitejs.dev/
- **Tailwind CSS:** https://tailwindcss.com/
- **react-markdown:** https://github.com/remarkjs/react-markdown

---

## Timeline Estimate

**Optimistic:** 2-3 weeks for working v0.1
**Realistic:** 4 weeks for polished v0.1
**With Buffer:** 6 weeks to production-ready v1.0

---

## Final Notes

This plan is designed to be **incremental and iterative**:
- ✅ Start simple (basic chat)
- ✅ Add features progressively
- ✅ Test at each phase
- ✅ Can pivot based on learnings

The beauty of the JSON subprocess approach is we can:
- Start basic and evolve
- Add WebSocket later if needed
- Integrate with your existing terminal infrastructure when ready
- Keep it simple and maintainable

**The goal is to ship v0.1 quickly, then iterate based on real usage.**
