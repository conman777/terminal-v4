# System Architecture

## Overview

Terminal v4 is a web-based terminal emulator providing remote access to system command-line interfaces (cmd/PowerShell/bash) through a browser. The system consists of two main components:

1. **Backend** - Fastify server managing PTY terminal processes
2. **Frontend** - React SPA with xterm.js providing the terminal UI

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Frontend (React + Vite)                   │  │
│  │  - Terminal session sidebar                           │  │
│  │  - xterm.js terminal emulator                         │  │
│  │  - Settings modal (working directory config)          │  │
│  │  - Session management (create/close)                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            │ HTTP / SSE                      │
│                            ▼                                 │
└─────────────────────────────────────────────────────────────┘
                             │
                             │
┌─────────────────────────────────────────────────────────────┐
│                    Backend (Fastify)                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Terminal Manager                         │   │
│  │  - Creates/manages terminal processes                │   │
│  │  - Uses node-pty for full PTY emulation             │   │
│  │  - Buffers output history                           │   │
│  │  - Supports multiple concurrent sessions            │   │
│  └──────────────────────────────────────────────────────┘   │
│                            │                                 │
│  ┌────────────────────────▼──────────────────────────────┐  │
│  │              API Routes                                │  │
│  │  GET  /api/health       - Server health check        │  │
│  │  GET  /api/terminal     - List terminal sessions     │  │
│  │  POST /api/terminal     - Create terminal session    │  │
│  │  GET  /api/terminal/:id/history - Get history        │  │
│  │  GET  /api/terminal/:id/stream  - SSE output stream  │  │
│  │  POST /api/terminal/:id/input   - Send input         │  │
│  │  DELETE /api/terminal/:id       - Close session      │  │
│  └───────────────────────────────────────────────────────┘  │
│                            │                                 │
└────────────────────────────┼─────────────────────────────────┘
                             │ spawn PTY
                             ▼
                  ┌────────────────────┐
                  │  cmd.exe / bash    │
                  │  (PTY Process)     │
                  └────────────────────┘
```

## Components

### Frontend (Port 5173)

React application providing the terminal user interface:

**Technologies:**
- React 18
- Vite (dev server + build tool)
- xterm.js (terminal emulator)
- xterm-addon-fit (responsive terminal sizing)

**Key Features:**
- **Session Sidebar**: Lists all active terminal sessions
- **Terminal Display**: xterm.js renders ANSI escape codes properly
- **Settings Modal**: Configure default working directory for new terminals
- **Session Controls**:
  - "New" button to create terminals
  - × button to close terminals
  - Click to switch between terminals

**State Management:**
- Terminal sessions list (fetched from API)
- Active terminal ID
- Settings (persisted to localStorage)

### Backend (Port 3020)

Fastify server managing terminal processes:

**Technologies:**
- Fastify 5.x (high-performance web framework)
- TypeScript
- @homebridge/node-pty-prebuilt-multiarch (PTY support)
- Zod (schema validation)

**Terminal Manager:**
- Creates real terminal processes using node-pty
- Each terminal = separate cmd.exe/bash process
- Buffers output history for late-joining clients
- Pub/sub pattern for real-time streaming
- Auto-cleanup on process exit

**Session Lifecycle:**
1. Client creates terminal via POST request
2. Backend spawns PTY process
3. Process output buffered + streamed via SSE
4. Client sends input via POST requests
5. Client closes terminal via DELETE request
6. Backend kills process and cleans up

## Data Flow

### Creating a Terminal

```
Browser                 Frontend              Backend            PTY Process
   │                       │                     │                    │
   │   Click "New"         │                     │                    │
   ├──────────────────────>│                     │                    │
   │                       │  POST /api/terminal │                    │
   │                       ├────────────────────>│                    │
   │                       │                     │  spawn()           │
   │                       │                     ├───────────────────>│
   │                       │  201 {session}      │                    │
   │                       │<────────────────────┤                    │
   │   Display terminal    │                     │                    │
   │<──────────────────────┤                     │                    │
   │                       │  GET /stream (SSE)  │                    │
   │                       ├────────────────────>│                    │
   │                       │  ...output...       │                    │
   │                       │<────────────────────┤                    │
```

### Sending Input

```
Browser                 Frontend              Backend            PTY Process
   │                       │                     │                    │
   │   Type "ls"           │                     │                    │
   ├──────────────────────>│                     │                    │
   │                       │  POST /input {"ls"} │                    │
   │                       ├────────────────────>│                    │
   │                       │                     │  write("ls")       │
   │                       │                     ├───────────────────>│
   │                       │                     │                    │
   │                       │                     │  output stream     │
   │                       │  SSE events         │<───────────────────┤
   │                       │<────────────────────┤                    │
   │   Render output       │                     │                    │
   │<──────────────────────┤                     │                    │
```

### Closing a Terminal

```
Browser                 Frontend              Backend            PTY Process
   │                       │                     │                    │
   │   Click ×             │                     │                    │
   ├──────────────────────>│                     │                    │
   │                       │  DELETE /terminal   │                    │
   │                       ├────────────────────>│                    │
   │                       │                     │  kill()            │
   │                       │                     ├───────────────────>│
   │                       │  204 No Content     │                    X
   │                       │<────────────────────┤
   │   Remove from UI      │                     │
   │<──────────────────────┤                     │
```

## Key Technical Decisions

### PTY vs Simple spawn()

**Why PTY (node-pty)?**
- ✅ True terminal emulation (TERM=xterm-256color)
- ✅ Interactive programs work (vim, python REPL, claude CLI)
- ✅ Proper ANSI escape code support
- ✅ Terminal resizing support

**Simple spawn() doesn't support:**
- ❌ Programs that detect non-TTY and change behavior
- ❌ Terminal control codes
- ❌ Interactive input/output

### Server-Sent Events (SSE) for Output

**Why SSE instead of WebSockets?**
- ✅ Simpler protocol (HTTP-based)
- ✅ Automatic reconnection
- ✅ Browser support excellent
- ✅ Fastify native support
- ✅ One-way data flow is all we need (server → client)

Input goes via regular HTTP POST (client → server).

### Multiple Processes vs tmux/screen

**Each terminal = separate process:**
- ✅ Simpler architecture
- ✅ Process isolation (crash doesn't affect others)
- ✅ Works on Windows without tmux
- ✅ Easy resource cleanup

**No tmux needed:**
- Tmux is for multiplexing in a single terminal
- We're building a multiplexer in the web UI
- Native process management is cleaner

### LocalStorage for Settings

**Settings stored client-side:**
- ✅ No database needed
- ✅ Per-user, per-browser preferences
- ✅ Works offline
- ✅ Simple implementation

**Current settings:**
- Default working directory for new terminals

## Security Considerations

⚠️ **This app is designed for local/trusted network use only.**

### Current Security Status

**No authentication:**
- Anyone on the network can access
- Full shell access to the server

**No command filtering:**
- Users can run ANY command
- Full system access

**No rate limiting:**
- Potential for abuse

### Production Requirements

Before deploying to production, you **MUST** add:

1. **Authentication & Authorization**
   - User login (JWT/session tokens)
   - Per-user session isolation
   - Admin vs user roles

2. **Command Filtering**
   - Whitelist/blacklist commands
   - Sandboxing (containers, chroot)

3. **Network Security**
   - HTTPS/TLS required
   - CORS restrictions
   - Rate limiting

4. **Monitoring & Logging**
   - Command audit logs
   - Failed access attempts
   - Resource usage monitoring

## Performance Characteristics

### Resource Usage

**Per Terminal Session:**
- 1 Node.js child process (cmd.exe/bash)
- ~10-50MB memory per terminal
- Output buffer in memory (~1MB max)

**Scalability:**
- 10s of concurrent terminals: ✅ Fine
- 100s of concurrent terminals: ⚠️ Consider limits
- 1000s: ❌ Need redesign (process pooling, containers)

### Output Buffering

- History kept in memory
- Default: All output since terminal creation
- Late-joining clients get full history
- No persistence (lost on server restart)

## Development vs Production

### Development (Current Setup)

```
Frontend (Vite dev server)  →  Backend (tsx watch)
Port 5173                       Port 3020
- Hot reload                    - Auto restart
- Proxy /api/* → 3020          - Full logging
```

### Production Deployment

**Option 1: Serve frontend from backend**
```bash
cd frontend && npm run build
# Serve dist/ folder from Fastify
# Single port deployment
```

**Option 2: Separate services**
```
Frontend (Nginx/CDN)  →  Backend (PM2/Docker)
Port 80/443               Port 3020
- Static files            - API only
- HTTPS termination       - Process management
```

## Future Enhancements

Potential improvements:

1. **Persistent Terminals**
   - Survive server restart
   - Use tmux/screen backend
   - Redis for session state

2. **Collaborative Terminals**
   - Multiple users in same terminal
   - WebRTC for peer-to-peer

3. **File Upload/Download**
   - Drag-and-drop files
   - Download terminal output

4. **Terminal Recording**
   - Record/replay sessions
   - Share terminal recordings

5. **Custom Themes**
   - Color scheme editor
   - Font customization
