# System Architecture

## Overview

Terminal v4 is a comprehensive web-based terminal and development cockpit. It combines:
- A PTY-backed terminal (xterm.js + node-pty) with tmux support
- Claude Code sessions (Claude CLI via PTY)
- Preview tooling for local dev servers and external sites with DevTools
- File management, project scanning, process control
- Voice input and transcription
- System monitoring (CPU, memory, disk I/O, processes, event loop)
- Screenshot and recording capabilities
- Mobile-optimized UI with touch gestures and specialized controls
- Notes and bookmarks for command management
- Split-pane terminal layouts with fullscreen mode

The system is split into a React SPA frontend and a Fastify backend. The backend
also serves the built frontend in production.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Browser                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Frontend (React + Vite)                                                 │ │
│  │ - Terminal UI (xterm.js with split panes, reader view)                 │ │
│  │ - Claude Code panel (SSE streaming)                                    │ │
│  │ - Preview panel + DevTools (Console, Network, Storage, Performance)    │ │
│  │ - File manager / process manager / settings                            │ │
│  │ - Mobile UI (keybar, carousel, action bar, gesture support)            │ │
│  │ - Bookmarks & Notes                                                    │ │
│  │ - Voice input with waveform visualization                              │ │
│  │ - System monitor (CPU, RAM, disk, processes)                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│     HTTP + SSE + WebSocket (JWT auth)                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Backend (Fastify)                               │
│  - Auth (JWT + refresh tokens + SQLite)                                    │
│  - Terminal Manager (node-pty + tmux persistence)                          │
│  - Claude Code Manager (Claude CLI via PTY)                                │
│  - Preview/Proxy (subdomain routing, cache-busting, cookie management)     │
│  - Preview DevTools (log injection, storage inspection)                    │
│  - File + project services (upload, download, unzip, scanning)             │
│  - Process manager + logs (port detection, repo start/stop)                │
│  - Screenshot service (Playwright screenshots & recordings)                │
│  - Voice transcription (Groq Whisper API)                                  │
│  - System monitoring (CPU, RAM, disk I/O, event loop, history tracking)    │
│  - Settings (user preferences, browser automation config)                  │
│  - Bookmarks & Notes storage (JSON files)                                  │
│  - System rebuild API                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                     ┌──────────────────────────────────┐
                     │  PTY Processes + Local Ports     │
                     │  (shell, dev servers, Claude CLI)│
                     └──────────────────────────────────┘
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
Supports preview modes:
1. **File preview**: `/api/preview?path=...&file=...` serves static files
   inside the project root.
2. **Local dev servers**: subdomain previews use
   `preview-{port}.{PREVIEW_SUBDOMAIN_BASE}` (or `.localhost` in local dev) when
   available. If the UI is accessed over a LAN IP/hostname, prefer a resolvable
   base such as `preview-{port}.{ip}.nip.io` to keep the iframe pointing at the
   server. Path-based `/preview/{port}/*` is the fallback, but some SPAs may
   404 if they assume `/` as the base path.
3. **External sites**: `/api/proxy-external?url=...` proxies external HTTP(S)
   content and injects a lightweight debug logger.

Note: preview subdomain bases can be configured via `PREVIEW_SUBDOMAIN_BASES`
(or `PREVIEW_SUBDOMAIN_BASE`) in the backend, and upstream loopback fallback
hosts via `PREVIEW_PROXY_HOSTS`.
Path-based previews do not require any DNS changes, but subdomain previews
should use a resolvable base when the UI is accessed over the network.

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
- User settings stored in SQLite (`user_settings`):
  - Groq API key for voice transcription
  - Preview URL preferences
  - Terminal font size (8-32)
  - Sidebar collapse state
- `/api/transcribe` uses Groq Whisper for voice input with support for multiple audio formats.
- Browser automation settings (idle timeout, max lifetime, cleanup intervals).

Key files:
- `backend/src/routes/settings-routes.ts`
- `backend/src/routes/transcribe-routes.ts`
- `backend/src/settings/browser-settings-service.ts`

### System Monitoring & Statistics
- Real-time system stats: CPU usage, memory, disk I/O (read/write MB/s), event loop delay.
- Process monitoring: top processes by CPU/memory with port associations.
- Stats history: 5-minute interval tracking stored to disk, queryable by time range (1h, 6h, 24h, 7d, 30d).
- System rebuild API: trigger rebuild script remotely with output capture.

Key files:
- `backend/src/routes/system-routes.ts`
- `backend/src/utils/memory-monitor.ts`

### Screenshot & Recording Service
- Playwright-based screenshot capture of preview panels.
- Element-specific screenshots via CSS selector.
- Video recording of preview sessions.
- Screenshot management (list, retrieve, delete).

Key files:
- `backend/src/routes/screenshot-routes.ts`
- `backend/src/preview/screenshot-service.ts`

### Bookmarks & Notes
- Command bookmarks: save frequently-used commands with optional cwd.
- Notes: simple text notes for project documentation.
- Stored as JSON files per user.
- Execute bookmarks directly in terminal sessions.

Key files:
- `backend/src/routes/bookmark-routes.ts`
- `backend/src/routes/note-routes.ts`
- `backend/src/bookmarks/bookmark-store.ts`
- `backend/src/notes/note-store.ts`

## Frontend Architecture

### State Providers
- `AuthContext` manages login/session tokens and user info.
- `TerminalSessionContext` handles terminal sessions, bookmarks, notes, projects, and recent folders.
- `ClaudeCodeContext` manages Claude Code sessions and left panel mode switching.
- `PreviewContext` owns preview URL, PiP state, and preview mode.
- `PaneLayoutContext` stores split-pane layout, fullscreen state, and focus management.

### Key UI Components

**Terminal Components:**
- `TerminalChat` integrates xterm.js, WebSocket IO, and WebGL rendering (optional).
- `TerminalPane` wraps terminal with scrolling, history, and image upload support.
- `SplitPaneContainer` manages multi-pane terminal layouts with draggable divider.
- `SessionTabBar` displays active terminal tabs with drag-to-reorder.
- `ReaderView` provides accessible terminal output reading with pagination.
- `TerminalHistoryModal` shows session history with search.

**Preview & DevTools:**
- `PreviewPanel` renders local/external previews with iframe sandboxing.
- `PreviewPip` picture-in-picture floating preview window.
- `DevToolsPanel` with tabs:
  - `ConsoleTab` captures console.log, errors, warnings.
  - `NetworkTab` monitors HTTP requests, responses, timing.
  - `StorageTab` inspects localStorage, sessionStorage, cookies.
  - `WebSocketTab` monitors WebSocket connections and messages.
  - `PerformanceTab` displays metrics (FCP, LCP, CLS, FID, TTFB).

**Mobile UI:**
- `MobileTerminalCarousel` swipe navigation between terminals.
- `MobileKeybar` dedicated control row with common keys (Esc, Tab, Ctrl, arrows).
- `MobileActionBar` quick actions (split, file manager, settings).
- `MobileHeader` compact header with hamburger menu.
- `MobileStatusBar` session info and stats.
- `MobileDrawer` side navigation for mobile.

**File & Process Management:**
- `FileManager` file browser with upload, download, rename, delete, unzip.
- `ProcessManagerModal` manages running dev servers and background processes.
- `FolderBrowserModal` quick folder navigation with recents and pinned folders.

**Settings & Configuration:**
- `SettingsModal` user preferences (font size, theme, sidebar).
- `ApiSettingsModal` Groq API key for voice transcription.
- `BrowserSettingsModal` Playwright automation settings.

**Utilities:**
- `BookmarkModal` manage command bookmarks.
- `NotesModal` manage project notes.
- `TerminalMicButton` voice input with waveform visualization.
- `AudioWaveform` visual feedback for voice recording.
- `StyleEditor` customize UI colors and themes.

### Custom Hooks
- `useTerminalStream` manages WebSocket terminal I/O.
- `useTerminalScrolling` handles terminal scroll behavior and auto-scroll.
- `useTerminalBuffer` manages terminal output history.
- `useVoiceInput` handles microphone recording and transcription.
- `useKeyboardShortcuts` global keyboard shortcut system.
- `useMobileDetect` detects mobile/tablet devices.
- `useSwipeGesture` touch gesture detection.
- `useIdleDetection` detects user inactivity.
- `useFaviconFlash` notification system via favicon.
- `useSessionActivity` tracks terminal session activity.
- `useImageUpload` handles image paste and drag-drop.

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
   - Local servers -> subdomain `preview-{port}.{PREVIEW_SUBDOMAIN_BASE}`
     (or `.localhost` in local dev) when available; fallback to `/preview/{port}`.
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
- `sessions/*.json` (terminal history with metadata)
- `sessions-metadata.json` (lightweight session index for recovery)
- `claude-code/*.json` (Claude Code session events)
- `bookmarks.json` (command bookmarks with cwd)
- `notes.json` (project notes)

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
