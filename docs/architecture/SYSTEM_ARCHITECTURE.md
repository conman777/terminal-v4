# System Architecture

## Overview

Terminal v4 is a web-based terminal and development cockpit. It combines:
- A PTY-backed terminal (xterm.js + node-pty)
- Claude Code sessions (Claude CLI via PTY)
- Preview tooling for local dev servers and external sites
- File management, project scanning, process control, and voice input

The system is split into a React SPA frontend and a Fastify backend. The backend
also serves the built frontend in production.

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                               Browser                                  │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Frontend (React + Vite)                                            │ │
│  │ - Terminal UI (xterm.js)                                           │ │
│  │ - Claude Code panel                                                │ │
│  │ - Preview panel + logs                                             │ │
│  │ - File manager / process manager / settings                        │ │
│  │ - Mobile keybar + voice input                                      │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│     HTTP + SSE + WebSocket (JWT)                                       │
└────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Backend (Fastify)                             │
│  - Auth (JWT + refresh tokens)                                         │
│  - Terminal Manager (node-pty + tmux optional)                         │
│  - Claude Code Manager (Claude CLI via PTY)                            │
│  - Preview/Proxy (preview subdomain, dev proxy, external proxy)        │
│  - File + project services                                             │
│  - Process manager + logs                                              │
│  - Browser automation (Playwright)                                     │
│  - Voice transcription (Groq API)                                      │
└────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                  ┌───────────────────────────────┐
                  │  PTY Processes + Local Ports  │
                  │  (shell, dev servers, Claude) │
                  └───────────────────────────────┘
```

## Backend Components

### Auth (JWT)
- Access tokens are JWTs; refresh tokens are stored hashed in SQLite.
- Registration is disabled (`/api/auth/register` returns 403).
- `ALLOWED_USERNAME` can restrict logins to a single username.
- Auth hook applies to all `/api/*` routes except explicit public routes.
- SSE and WebSocket clients can pass `?token=` when headers are unavailable.

Key files:
- `backend/src/auth/auth-service.ts`
- `backend/src/auth/auth-routes.ts`
- `backend/src/auth/auth-hook.ts`

### Terminal Manager
- Uses `@homebridge/node-pty-prebuilt-multiarch` to spawn real PTYs.
- Optional tmux integration for persistence across restarts (Linux/macOS).
- Sessions are stored per-user as JSON for history and metadata.
- WebSocket stream (`/api/terminal/:id/ws`) is the primary IO channel.
- Tmux sessions only persist across restarts if the OS service does not kill
  child processes (see Operations Notes below).

Key files:
- `backend/src/terminal/terminal-manager.ts`
- `backend/src/terminal/session-store.ts`
- `backend/src/terminal/tmux-manager.ts`

### Claude Code Manager
- Wraps the Claude CLI using PTY to keep terminal behavior consistent.
- Events are streamed over SSE (`/api/claude-code/:id/stream`).
- Sessions are persisted per user as JSON.

Key files:
- `backend/src/claude-code/claude-code-manager.ts`
- `backend/src/claude-code/claude-code-routes.ts`
- `backend/src/claude-code/claude-code-store.ts`

### Preview + Proxy
Supports three preview modes:
1. **File preview**: `/api/preview?path=...&file=...` serves static files
   inside the project root.
2. **Local dev servers**: `preview-{port}.conordart.com` proxies to
   `localhost:{port}`, injects debug scripts, and maintains cookies.
3. **External sites**: `/api/proxy-external?url=...` proxies external HTTP(S)
   content and injects a lightweight debug logger.

Note: the preview subdomain domain (`conordart.com`) is hard-coded in both the
frontend and backend. Update `frontend/src/components/PreviewPanel.jsx` and
`backend/src/routes/preview-subdomain-routes.ts` if you deploy on a different
domain.

Debug tooling:
- Injected scripts capture console, errors, and network activity.
- Logs are stored in-memory for Claude Code and the preview UI.
- Cookie jar is persisted to disk.

Key files:
- `backend/src/routes/preview-routes.ts`
- `backend/src/routes/preview-subdomain-routes.ts`
- `backend/src/routes/dev-proxy-routes.ts`
- `backend/src/routes/external-proxy-routes.ts`
- `backend/src/preview/*`

### File + Project Services
- File manager supports list, upload, download, rename, delete, unzip.
- Project scanner finds git repositories and tracks custom scan paths.
- Path resolution uses helpers in `path-security.ts`.

Key files:
- `backend/src/routes/file-routes.ts`
- `backend/src/services/project-scanner.ts`
- `backend/src/utils/path-security.ts`

### Process Manager
- Detects running dev servers by scanning listening ports.
- Can start/stop repos based on project type.
- Captures process logs with port association.

Key files:
- `backend/src/processes/process-service.ts`
- `backend/src/preview/process-log-store.ts`

### Browser Automation
- Playwright-backed browser control API (public endpoints).
- Supports navigation, interaction, screenshots, and DOM queries.

Key files:
- `backend/src/routes/browser-routes.ts`
- `backend/src/browser/*`

### Settings + Transcribe
- User settings stored in SQLite (`user_settings`), currently Groq API key.
- `/api/transcribe` uses Groq Whisper for voice input.

Key files:
- `backend/src/routes/settings-routes.ts`
- `backend/src/routes/transcribe-routes.ts`

## Frontend Architecture

### State Providers
- `AuthContext` manages login/session tokens.
- `TerminalSessionContext` handles terminal sessions, bookmarks, projects.
- `ClaudeCodeContext` manages Claude Code sessions and mode switching.
- `PreviewContext` owns preview URL + PiP state.
- `PaneLayoutContext` stores split-pane layout for terminals.

### Key UI Components
- `TerminalChat` integrates xterm.js and WebSocket IO.
- `PreviewPanel` renders local/external previews and log panes.
- `MobileTerminalCarousel` handles swipe navigation on mobile.
- `MobileKeybar` provides a dedicated control row for mobile key input.
- `FileManager` and `ProcessManagerModal` for file/process operations.

## Key Data Flows

### Authentication
1. User logs in via `/api/auth/login`.
2. Access/refresh tokens stored in localStorage.
3. `apiFetch` attaches `Authorization: Bearer` to requests.
4. Token refresh happens automatically on 401 responses.

### Terminal Sessions
1. Create session via `POST /api/terminal`.
2. Connect to `/api/terminal/:id/ws` for IO (token in query).
3. Server sends a `clientId` JSON frame on connect.
4. Client sends raw keystrokes; server streams raw output.
5. Sessions are persisted as JSON history snapshots.

### Claude Code Sessions
1. Start via `POST /api/claude-code/start`.
2. Stream events over SSE at `/api/claude-code/:id/stream`.
3. Persist sessions for later restore.

### Preview Pipeline
1. Terminal output is scanned for dev server URLs.
2. Preview panel transforms URLs into a preview-safe URL:
   - Static files -> `/api/preview`.
   - Local servers -> `preview-{port}.conordart.com`.
   - External -> `/api/proxy-external`.
3. Injected scripts send logs to `/api/preview/*/logs`.

## Persistence and Data Storage

### SQLite (terminal.db)
Location: `backend/data/terminal.db` by default, overridden by
`TERMINAL_DATA_DIR` or `DATA_DIR`. Stores:
- `users`
- `refresh_tokens`
- `user_settings`

### File-Based Stores (JSON)
Under `backend/data/users/<userId>/`:
- `sessions/*.json` (terminal history)
- `sessions-metadata.json` (lightweight session index for recovery)
- `claude-code/*.json`
- `bookmarks.json`
- `notes.json`

### Preview Cookies
Stored in `backend/data/preview-cookies.json` by default (overridable via
`TERMINAL_DATA_DIR` or `DATA_DIR`).

### In-Memory Stores
- Preview logs (console/network/DOM)
- Proxy request logs
- Process logs

## Operations Notes

- **Stable data directory**: In production, set `TERMINAL_DATA_DIR` explicitly.
  Bundled builds resolve `data` relative to `dist/`, which can otherwise flip
  storage between `backend/data` and repo-root `data`.
- **Tmux persistence**: `rebuild.sh` restarts the systemd service. To keep tmux
  sessions alive across rebuilds, the service should use `KillMode=process` (or
  run tmux outside the service cgroup). See `docs/development/SETUP.md`.

## Security and Sandboxing

- JWT auth is required for most `/api/*` routes.
- Public routes include health checks, preview logs, process logs, and
  browser automation endpoints.
- Preview file server is sandboxed to the project root.
- File manager resolves paths safely but is not restricted to project root.
- Dev proxy only allows a fixed set of local ports.
- External proxy blocks localhost and private IP ranges.

## Development vs Production

Development:
- Frontend: `vite dev` on port 5173
- Backend: `tsx watch` on port 3020

Production:
- Build frontend (`frontend/dist`)
- Fastify serves static assets and SPA fallback
