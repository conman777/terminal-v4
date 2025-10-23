# System Architecture

## Overview

Terminal v4 is a browser-based interface that wraps the Claude Code CLI, providing a chat-style UI for interacting with Claude and managing local terminal sessions. The system consists of three main components:

1. **Backend** - Express.js server managing Claude CLI processes and terminal sessions
2. **Frontend** - React SPA providing the user interface
3. **Claude CLI** - External command-line tool for AI interactions

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Frontend (React + Vite)                   │  │
│  │  - Session list sidebar                               │  │
│  │  - Chat interface (Markdown rendering)                │  │
│  │  - Terminal chat interface                            │  │
│  │  - Tool activity display                              │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            │ HTTP / SSE                      │
│                            ▼                                 │
└─────────────────────────────────────────────────────────────┘
                             │
                             │
┌─────────────────────────────────────────────────────────────┐
│                    Backend (Express.js)                      │
│  ┌──────────────────────┐  ┌──────────────────────────┐    │
│  │   Session Store      │  │   Terminal Manager       │    │
│  │  (In-Memory)         │  │  (node-pty)              │    │
│  │  - Chat sessions     │  │  - PTY processes         │    │
│  │  - Message history   │  │  - Output buffering      │    │
│  └──────────────────────┘  └──────────────────────────┘    │
│              │                          │                    │
│              │                          │                    │
│  ┌──────────▼──────────────────────────▼──────────────┐    │
│  │              API Routes                             │    │
│  │  /api/chat         - Claude interactions (SSE)     │    │
│  │  /api/sessions     - Session management            │    │
│  │  /api/terminal     - Terminal session lifecycle    │    │
│  │  /api/terminal/:id - Terminal I/O & streaming      │    │
│  └─────────────────────────────────────────────────────┘    │
│              │                          │                    │
└──────────────┼──────────────────────────┼────────────────────┘
               │                          │
               │ spawn                    │ spawn
               ▼                          ▼
    ┌─────────────────┐      ┌──────────────────────┐
    │  Claude CLI     │      │  Shell Process       │
    │  (External)     │      │  (PowerShell/bash)   │
    │  - JSON stream  │      │  - PTY subprocess    │
    └─────────────────┘      └──────────────────────┘
```

## Component Responsibilities

### Frontend (React + Vite)

**Purpose:** Provide a polished UI for Claude interactions and terminal management.

**Key Features:**
- Session list sidebar showing all active Claude conversations
- Main chat area with Markdown rendering for Claude responses
- Terminal chat interface for local shell interactions
- Real-time tool activity tracking
- Auto-scrolling transcript view

**Technology Stack:**
- React for component-based UI
- Vite for fast development and bundling
- EventSource API for consuming SSE streams
- react-markdown + prism-react-renderer for syntax highlighting

**Communication:**
- Connects to backend via HTTP REST and Server-Sent Events (SSE)
- Runs on `http://localhost:5173` (dev mode)
- Proxies API calls to backend on port 3020

### Backend (Express.js)

**Purpose:** Orchestrate Claude CLI processes, manage terminal sessions, and stream real-time updates.

**Key Modules:**

#### 1. Session Store (`session-store.js`)
- Maintains in-memory map of Claude chat sessions
- Stores message history (user inputs + Claude responses)
- Provides session lifecycle management (create, read, delete)
- **Limitation:** State is lost on server restart (no persistence)

#### 2. Terminal Manager (`terminal-manager.js`)
- Spawns pseudo-terminal (PTY) processes using `node-pty`
- Auto-detects shell: `process.env.ComSpec` (Windows) or `process.env.SHELL` (Unix)
- Buffers terminal output for late-joining SSE subscribers
- Manages subscriber pattern for real-time output streaming
- Cleans up PTY processes when sessions end

#### 3. API Routes
- **Chat Routes** (`/api/chat`, `/api/sessions`)
  - Start/continue Claude conversations
  - Stream responses via SSE
  - List and manage chat sessions

- **Terminal Routes** (`/api/terminal/*`)
  - Create terminal sessions
  - Send commands to shell
  - Stream terminal output via SSE
  - Retrieve session history

**Technology Stack:**
- Express.js web framework
- node-pty for true TTY emulation
- strip-ansi for plain text output alongside ANSI codes
- crypto.randomUUID for session IDs

**Communication:**
- Spawns Claude CLI as child process
- Parses JSON stream from CLI stdout
- Spawns shell processes via node-pty
- Exposes SSE endpoints for real-time updates

### Claude CLI (External Process)

**Purpose:** Provide AI capabilities via Anthropic's Claude Code tool.

**Integration:**
- Backend spawns CLI via child process
- CLI must be on PATH or specified via `CLAUDE_BIN` env var
- Outputs structured JSON via `--stream-json` flag
- Session continuity via `sessionId` returned by CLI

**Requirements:**
- Installed locally and accessible on system PATH
- Compatible with `--dangerously-skip-permissions` flag (optional)
- Supports `--allowedTools` parameter for tool restrictions

## Communication Patterns

### Server-Sent Events (SSE)

**Why SSE?**
- One-way server-to-client streaming (perfect for CLI output)
- Native browser support via EventSource API
- Automatic reconnection on connection loss
- Simpler than WebSockets for read-only streams

**SSE Endpoints:**

1. **`POST /api/chat`** - Claude conversation streaming
   - Client sends message in POST body
   - Server responds with SSE stream
   - Events: `started`, `chunk`, `tool`, `complete`, `error`

2. **`GET /api/terminal/:id/stream`** - Terminal output streaming
   - Client opens SSE connection
   - Server immediately flushes buffered history
   - Ongoing output streamed as `data` events
   - Connection closed on PTY exit (`end` event)

**Event Format:**
```
event: chunk
data: {"text": "Hello", "type": "content"}

event: data
data: {"text": "ls\n", "plain": "ls"}
```

### REST API

**Session Management:**
- `POST /api/sessions` - Create new session
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:id` - Get session history
- `DELETE /api/sessions/:id` - Delete session

**Terminal Management:**
- `POST /api/terminal` - Create terminal session (returns `sessionId`)
- `POST /api/terminal/:id/input` - Send command to shell
- `GET /api/terminal/:id/history` - Fetch complete transcript

## Data Models

### Chat Session
```javascript
{
  id: string,                    // UUID
  title: string,                 // User-provided or auto-generated from first message
  claudeSessionId: string|null,  // Session ID from Claude CLI (for continuation)
  createdAt: string,             // ISO 8601
  updatedAt: string,             // ISO 8601
  preview: string,               // First 120 chars of last assistant message
  messages: [
    {
      id: string,                // UUID
      role: 'user' | 'assistant',
      content: string,           // Message text
      createdAt: string,         // ISO 8601
      meta: {                    // Optional metadata
        streaming?: boolean,     // Whether message is still being streamed
        aborted?: boolean,       // Whether request was aborted
        exitCode?: number,       // CLI exit code for assistant messages
        signal?: string          // Signal if CLI was killed
      }
    }
  ]
}
```

### Terminal Session
```javascript
{
  id: string,                    // UUID
  title: string,                 // e.g., "Terminal 1", "Terminal 2"
  shell: string,                 // e.g., "powershell.exe" or "/bin/bash"
  createdAt: string,             // ISO 8601
  updatedAt: string,             // ISO 8601
  process: ChildProcess,         // child_process.spawn handle
  buffer: [
    {
      type: 'terminal',
      text: string,              // Raw output (stdout or stderr)
      ts: number                 // Unix timestamp
    }
  ],
  subscribers: Set<Function>     // SSE event handlers
}
```

### Terminal Entry (Frontend)
```javascript
{
  role: 'user' | 'terminal',
  text: string,            // Plain text (ANSI stripped)
  id: string               // Unique key for React rendering
}
```

## Design Decisions & Rationale

### 1. In-Memory Session Storage

**Decision:** Store all session data in JavaScript Maps without database persistence.

**Rationale:**
- Simplifies initial implementation
- Low latency for session lookups
- Sufficient for local development tool
- Easy to migrate to database later if needed

**Trade-offs:**
- Sessions lost on server restart
- No multi-instance support
- Memory usage grows with session count

**Future:** Serialize to JSON files or add SQLite persistence.

### 2. SSE Over WebSockets

**Decision:** Use Server-Sent Events for real-time streaming instead of WebSockets.

**Rationale:**
- Simpler protocol (HTTP-based, no upgrade handshake)
- Perfect for one-way server-to-client streams
- Native browser support, no library needed
- Automatic reconnection built-in
- CLI output is read-only (no bidirectional messaging needed)

**Trade-offs:**
- Can't send messages over same connection (use REST for client-to-server)
- Less efficient for high-frequency bidirectional chat

**When to reconsider:** If real-time typing indicators or collaborative editing needed.

### 3. child_process.spawn for Terminal Emulation

**Decision:** Use `child_process.spawn` instead of `node-pty` for shell processes.

**Rationale:**
- No native dependencies (avoids compilation issues)
- Simpler implementation for non-interactive use
- Captures both stdout and stderr separately
- Works across Windows and Unix with platform-specific args

**Trade-offs:**
- No true PTY support (breaks interactive programs like vim, less)
- Limited ANSI color code support
- Different argument handling per platform

**Implementation Details:**
- Windows: `spawn(shell, ['-NoLogo', '-NoExit'])` for PowerShell or `/K` for CMD
- Unix: `spawn(shell, ['-i'])` for interactive bash/zsh
- Uses stdio: `['pipe', 'pipe', 'pipe']` for stdin/stdout/stderr capture

### 4. ANSI Handling

**Decision:** Stream raw terminal output as-is (no ANSI stripping in backend).

**Rationale:**
- Minimal processing in backend (performance)
- Preserve original formatting for future color rendering
- Frontend can decide how to handle ANSI codes

**Note:** `strip-ansi` is installed but not currently used in terminal streaming.

### 5. Shell Auto-Detection

**Decision:** Automatically detect shell from environment variables.

**Rationale:**
- Works across Windows (PowerShell/CMD) and Unix (bash/zsh)
- No configuration required for most users
- Respects user's default shell preferences

**Logic:**
```javascript
Windows: process.env.ComSpec || 'powershell.exe'
Unix:    process.env.SHELL || '/bin/bash'
```

### 6. Session ID Strategy

**Decision:** Use `crypto.randomUUID()` for all session identifiers.

**Rationale:**
- Built-in Node.js function (no dependencies)
- Cryptographically random (prevents guessing)
- Standard UUID format (128-bit)
- No collision risk at expected scale

**Format:** `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

## Security Considerations

### Current Limitations (Local Development Only)

**No Authentication:** Backend assumes trusted local environment (localhost only).

**No Authorization:** All API endpoints publicly accessible on localhost.

**Command Execution:** Terminal API can execute arbitrary shell commands via spawned shell.

**Session Hijacking:** Session IDs are only defense (UUIDs provide randomness).

**No Persistence:** All sessions lost on backend restart (in-memory only).

**Platform-Specific:** Shell behavior differs between Windows (PowerShell/CMD) and Unix (bash/zsh).

### Required for Production

1. **Authentication Layer**
   - User login system
   - Session tokens (JWT or cookie-based)
   - Tie sessions to authenticated users

2. **Authorization**
   - Verify user owns session before access
   - Rate limiting on API endpoints
   - Command whitelisting/blacklisting for terminal

3. **Input Validation**
   - Sanitize all user inputs
   - Validate session IDs match UUID format
   - Limit message/command length

4. **HTTPS/TLS**
   - Encrypt all traffic in production
   - Prevent session token interception

5. **CORS Configuration**
   - Restrict allowed origins
   - Prevent cross-site attacks

## Performance Characteristics

### Scalability Limits

**Single Backend Instance:**
- In-memory sessions limited by RAM
- Each terminal session spawns OS process (resource intensive)
- SSE connections held open (file descriptor limits)

**Estimated Capacity:**
- ~100 concurrent SSE streams per backend
- ~50 active terminal sessions (process limit dependent)
- Message history grows linearly with session activity

### Optimization Opportunities

1. **Session Pruning:** Auto-delete inactive sessions after timeout
2. **Buffer Limits:** Cap terminal output buffer size (circular buffer)
3. **Horizontal Scaling:** Use Redis for session storage, enable multi-instance
4. **Output Throttling:** Rate-limit terminal output events to frontend

## Error Handling Strategy

### Backend Error Boundaries

1. **CLI Spawn Failures:** Return 500 error, log to console
2. **PTY Process Crashes:** Notify SSE subscribers, clean up session
3. **Invalid Session IDs:** Return 404 with error message
4. **Malformed Requests:** Return 400 with validation error

### Frontend Resilience

1. **SSE Reconnection:** EventSource auto-reconnects on disconnect
2. **Failed Requests:** Show error toast, retry with exponential backoff
3. **Missing Sessions:** Redirect to session list or show empty state

### Logging Strategy

**Current:** `console.log` / `console.error` to stdout/stderr

**Recommended:**
- Structured logging (JSON format)
- Log levels (debug, info, warn, error)
- Request correlation IDs
- Persistent log storage (files or log aggregation service)

## Future Architecture Considerations

### Persistence Layer

Add SQLite or PostgreSQL for:
- Session history across restarts
- User accounts and preferences
- Audit logging

### Multi-User Support

Require changes:
- Authentication middleware
- User-scoped session queries
- Resource quotas per user

### Distributed Deployment

Enable scaling via:
- Redis for shared session storage
- Message queue for CLI job distribution
- Load balancer for multiple backend instances

### Plugin System

Allow extending via:
- Custom tool integrations
- Webhook triggers
- Third-party service connectors

## Development Workflow

### Local Development Setup

1. Start backend: `cd backend && npm run dev`
2. Start frontend: `cd frontend && npm run dev`
3. Backend runs on `http://localhost:3020`
4. Frontend runs on `http://localhost:5173` (proxies API to backend)

### Environment Variables

**Backend:**
- `CLAUDE_BIN` - Path to Claude CLI executable
- `CLAUDE_ALLOWED_TOOLS` - Comma-separated tool whitelist
- `CLAUDE_ASSUME_YES` - Skip permission prompts (set to `"true"`)
- `PORT` - Backend server port (default: 3020)

**Frontend:**
- Configured via Vite proxy settings in `vite.config.js`

### Testing Strategy

**Current State:** Minimal test coverage

**Recommended:**
1. **Unit Tests:** Core logic (session-store, terminal-manager)
2. **Integration Tests:** API endpoints with mock CLI
3. **E2E Tests:** Browser automation via Playwright/Cypress

See `docs/development/TESTING_GUIDE.md` for details (to be created).

## Deployment Architecture

### Current: Local Only

Both frontend and backend run on localhost, no production deployment.

### Recommended: Production Setup

```
Internet
    │
    ▼
┌─────────────┐
│   Nginx     │  Reverse proxy (HTTPS termination)
│   :443      │
└─────────────┘
    │
    ├─── Static Files (Frontend build)
    │
    └─── Proxy to Backend
         │
         ▼
    ┌─────────────┐
    │  Backend    │  Node.js Express
    │  :3020      │  (behind firewall)
    └─────────────┘
         │
         ├─── Claude CLI
         └─── Shell Processes
```

**Security Requirements:**
- Backend should NOT be publicly accessible
- All external traffic through HTTPS
- Authentication before any API access
- Firewall rules restricting outbound shell access

## Glossary

- **SSE:** Server-Sent Events, HTTP-based one-way streaming protocol
- **PTY:** Pseudo-terminal, emulated terminal device for subprocess I/O
- **ANSI:** Escape codes for terminal colors/formatting
- **UUID:** Universally Unique Identifier (128-bit random ID)
- **CLI:** Command-Line Interface
- **SPA:** Single-Page Application (React frontend)
