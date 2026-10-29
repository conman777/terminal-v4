# System Architecture

## Overview

Terminal v4 is a comprehensive web-based terminal and development cockpit. It combines:
- A PTY-backed terminal (xterm.js + Rust `portable-pty`) with tmux support
- Claude Code sessions (Claude CLI via PTY)
- Preview tooling for local dev servers and external sites with DevTools
- File management, project scanning, process control
- Voice input and transcription
- System monitoring (CPU, memory, disk I/O, processes, event loop)
- Screenshot and recording capabilities
- Mobile-optimized UI with touch gestures and specialized controls
- Notes and bookmarks for command management
- Split-pane terminal layouts with fullscreen mode

The system is split into a React SPA frontend and a backend runtime. The legacy
backend is Fastify/TypeScript, and the active rewrite/runtime path is now the
Rust Axum workspace under `rust/`. The backend serves the built frontend in
production.

Frontend startup keeps the first app shell intentionally small. Heavy runtime
surfaces such as the xterm/WebGL terminal, conversation markdown/tool rendering,
preview DevTools, and WebContainer boot code are loaded behind lazy boundaries
instead of being required before the root UI can paint. The production desktop
path should prefer `frontend/dist` served by the Rust API over Vite's
request-time module transforms.

`WorkspacePanel` coordinates navigation and browser geometry, remembered widths,
keyboard/pointer resizing, and the narrow browser sheet. `WorkspaceShell.css`
defines the shared header height and conversation/composer rail. Mobile selection
uses a 768px width boundary; tool sheets begin at 980px. Sheet focus and inert
background state are restored on dismissal, while conversation and terminal hosts
remain mounted behind the browser. Existing Files, Preview and workspace-tool
dialogs keep their own action lifecycles.
Browser approval polling follows actual pane visibility, including fullscreen
and System Resources, and every opener restores the workspace through one handler.

`WorkspaceUI.css`, imported after the base stylesheet, defines the shared semantic
palette, typography, control sizes, focus treatment and modal primitives.
Component-local styles own their surfaces; `WorkspaceShell.css` coordinates shell
geometry rather than restyling every dialog. Desktop controls use compact 32px
targets; phone/coarse-pointer controls use 44px targets and 16px text inputs.
Conversation and composer content share a 46rem rail, with a 52px header and 12px
composer corners. Terminal fonts and colors are applied through xterm's options,
so CSS does not invalidate its measured character grid. Fullscreen hides sibling
panes without replacing their terminal renderers or composer drafts.

Phase 1 also includes a Windows desktop wrapper (`desktop/tauri`) that launches
the Rust backend as a local child process and hosts the same UI in a native
window. In this phase, desktop mode is local-only (`127.0.0.1:3020`).

The Rust backend workspace now covers the primary API surface used by the
desktop runtime: health, JWT auth, password changes, passkeys, PTY-backed
terminal sessions with tmux recovery/git helpers, structured sessions, preview
and dev-proxy tooling, files/processes/system stats, screenshots/recording,
vault, transcription, WebContainer file trees, settings, bookmarks, and notes.
The legacy Fastify backend still exists in `backend/` during migration, but it
is now a compatibility/reference implementation rather than the desktop runtime.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  Browser                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Frontend (React + Vite)                                                 │ │
│  │ - Terminal UI (xterm.js with split panes, reader view)                 │ │
│  │ - Structured conversations (WebSocket streaming)                       │ │
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
│                         Backend (Rust Axum active)                          │
│  - Auth (JWT + refresh tokens + SQLite)                                    │
│  - Terminal Manager (portable PTY + tmux persistence)                      │
│  - Structured Session Manager (Claude CLI provider)                        │
│  - Preview/Proxy (path/subdomain routing, cookies, logs, dev proxy)        │
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

The active runtime registers routes in `rust/crates/api/src/lib.rs`. Component
file lists under `backend/` below identify legacy Fastify counterparts, not the
active Rust implementation.

### Desktop Shell (Windows, Phase 1)
- Built with Tauri (`desktop/tauri/src-tauri`).
- Starts the Rust backend process on app setup (`terminal-v4-api`).
- Waits for backend readiness before continuing.
- Stops backend process when the desktop app exits.
- Uses local-only bind (`HOST=127.0.0.1`, `PORT=3020`) for safety in this phase.

Key files:
- `desktop/tauri/src-tauri/src/main.rs`
- `desktop/tauri/src-tauri/tauri.conf.json`

### Auth (JWT)
- Access tokens are JWTs; refresh tokens are stored hashed in SQLite.
- Registration is disabled (`/api/auth/register` returns 403).
- Login uses the external Postgres user database referenced by
  `STORAGE_DATABASE_URL`, while refresh tokens and mirror-user rows stay local.
- `ALLOWED_USERNAME` can restrict logins to a single username.
- Auth hook applies to all `/api/*` routes except explicit public routes.
- SSE and WebSocket clients can pass `?token=` when headers are unavailable.

Key files:
- `rust/crates/api/src/auth.rs`
- `rust/crates/api/src/external_auth.rs`
- `rust/crates/api/src/passkey.rs`

### Terminal Manager
- Uses Rust `portable-pty` to spawn real PTYs. The legacy Fastify counterpart
  uses `@homebridge/node-pty-prebuilt-multiarch`.
- Optional tmux integration for persistence across restarts (Linux/macOS).
- Sessions are stored per-user as JSON for history and metadata.
- Terminal creation currently runs only in full-access host mode. Requested
  sandbox modes fail closed until runtime isolation is implemented.
- Legacy session metadata can still carry sandbox mode and workspace root, but
  the API no longer accepts new sandboxed launches because no enforced
  workspace copy or read-only runtime exists yet.
- WebSocket stream (`/api/terminal/:id/ws`) is the primary IO channel.
- PTY sessions also emit lightweight terminal metadata events (`turn`, `cli_event`)
  over the same WebSocket channel so the frontend can render prompt cards and
  session activity without depending entirely on terminal scraping.
- Tmux sessions only persist across restarts if the OS service does not kill
  child processes (see Operations Notes below).

Key files (active Rust runtime):
- `rust/crates/api/src/terminal.rs`
- `rust/crates/api/src/tmux.rs`
- `rust/crates/api/src/lib.rs`

### Legacy Claude Code Manager (Fastify)

This retained PTY/SSE route family belongs to the legacy backend. The current
frontend can launch Claude through terminal sessions; conversation-first sessions
use the structured routes below.

- Wraps the Claude CLI using PTY to keep terminal behavior consistent.
- Events are streamed over SSE (`/api/claude-code/:id/stream`).
- Sessions are persisted per user as JSON.

Key files:
- `backend/src/claude-code/claude-code-manager.ts`
- `backend/src/claude-code/claude-code-routes.ts`
- `backend/src/claude-code/claude-code-store.ts`

### Structured Session Manager
- Persists per-user structured sessions under
  `<data_dir>/structured-sessions/<sha256-owner>/<session-id>.json`.
- Exposes `POST/GET /api/structured/sessions`, `PATCH /api/structured/sessions/:id`,
  `GET/PATCH /api/structured/sessions/:id/thread`, per-session message/control
  routes, and `/api/structured/sessions/:id/ws` for canonical event streaming.
- The active Rust runtime implements this route family. Its Claude provider
  consumes `claude -p --output-format stream-json`.
- Browser clients authenticate the structured WebSocket with the access token in
  the `token` query parameter.
- In local browser development, loopback API URLs are normalized back to the
  current page origin so Vite can proxy structured/session traffic to the live
  Rust backend even when `VITE_API_URL` still points at an older loopback port.
- The existing React shell now merges structured sessions into the shared
  session inventory so new-tab AI launches can create conversation-first `ss-*`
  tabs without changing the tab bar or thread/sidebar model.
- Structured `ss-*` titles and sidebar thread metadata now round-trip through
  the Rust backend so rename, topic, pin, archive, and project-path state are
  no longer frontend-local only.
- Native Codex sessions use `runtime: "codex"` and the local
  `codex app-server --listen stdio://` protocol through
  `rust/crates/api/src/structured/codex.rs`. Each message starts an isolated
  app-server process and resumes the saved native thread identity. The existing
  structured provider interface remains available for other agents.
- Codex messages are saved before dispatch with a request UUID. The adapter maps
  assistant/tool events into the shared conversation view, presents native
  approvals one at a time with exact action IDs, and confirms process cleanup
  before Stop releases a session. Restarted unfinished turns become interrupted;
  they are never automatically replayed.
- Codex owns its authentication, instructions, tools and native history. The app
  uses workspace-write with on-request approvals and does not copy credentials
  into its provider vault. See [Local Codex](../features/LOCAL_CODEX.md).

### Preview + Proxy
Supports preview modes:
1. **File preview**: `/api/preview?path=...&file=...` serves static files
   inside the project root.
2. **Local dev servers**: routing depends on how Terminal is accessed:
   - **Localhost access** (`http://localhost:3020`): Uses path-based preview
     `/preview/{port}/*` - reliable for all apps including SPAs.
   - **LAN/remote access** (`http://192.168.x.x:3020` or hostname): Uses
     subdomain previews `preview-{port}.{ip}.nip.io` to ensure the iframe
     resolves back to the server.
3. **External sites**: `/api/proxy-external?url=...` proxies external HTTP(S)
   content and injects a lightweight debug logger.

Note: preview subdomain bases can be configured via `PREVIEW_SUBDOMAIN_BASES`
(or `PREVIEW_SUBDOMAIN_BASE`) in the backend, and upstream loopback fallback
hosts via `PREVIEW_PROXY_HOSTS`.
Path-based previews do not require any DNS changes and work reliably for SPAs.
Subdomain previews should use a resolvable base when the UI is accessed over
the network.

Debug tooling:
- Injected scripts capture console, errors, storage sync, and performance activity.
- Logs are stored in-memory for Claude Code and the preview UI.
- The active Rust cookie jar is held in memory and is lost on API restart.
  Disk-backed preview cookies belong to the legacy Fastify implementation.

Key files:
- `backend/src/routes/preview-routes.ts`
- `backend/src/routes/preview-subdomain-routes.ts`
- `backend/src/routes/dev-proxy-routes.ts`
- `backend/src/routes/external-proxy-routes.ts`
- `backend/src/preview/*`

### File + Project Services
- File manager supports list, upload, download, rename, delete, unzip.
- Project scanner finds git repositories, surfaces direct project folders from common project roots, and tracks custom scan paths.
- Explicitly added scan directories are treated as projects even when they are not git repositories yet.
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

### Legacy Browser Automation (Fastify reference)
- Browser automation services exist under `backend/src/browser/*`.
- Public `/api/browser/*` routes are not currently registered in `backend/src/index.ts`.
- Preview screenshots/recording are available via screenshot routes instead.

Key files:
- `backend/src/browser/*`
- `backend/src/routes/screenshot-routes.ts`

### Settings + Transcribe
- User settings stored in SQLite (`user_settings`):
  - Groq API key for voice transcription
  - Preview URL preferences
  - Terminal font size (8-32)
  - Sidebar collapse state
  - Sandbox default mode, normalized to `off` until runtime isolation exists
- `/api/transcribe` uses Groq Whisper for voice input with support for multiple audio formats.
- Browser settings are persisted in the user settings table.

Key files:
- `backend/src/routes/settings-routes.ts`
- `backend/src/routes/transcribe-routes.ts`

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
- `PaneLayoutContext` stores split-pane layout, fullscreen state, and focus management. Split nodes may persist normalized child `sizes`; missing or invalid sizes fall back to equal shares. Pane hosts remain flat and keyed by pane ID while their geometry follows the tree, preserving terminal renderers and drafts through resizing, split changes, and fullscreen transitions.

### Key UI Components

**Terminal Components:**
- `TerminalChat` integrates xterm.js, WebSocket IO, and WebGL rendering (optional).
  Linux desktop browsers are forced onto the canvas renderer because xterm's
  WebGL path has produced terminal corruption in that environment.
- `TerminalPane` now uses two desktop shell paths:
  - structured sessions (`ss-*`) keep the conversation-first surface.
  - PTY/CLI sessions are terminal-first and can render a lightweight activity strip
    above the terminal for structured prompt cards and recent assistant/status events.
- `SplitPaneContainer` manages multi-pane terminal layouts with draggable divider.
- `SessionTabBar` displays active terminal tabs with drag-to-reorder.
- `ReaderView` provides accessible terminal output reading with pagination.
- `TerminalHistoryModal` shows session history with search.
- `CliActivityStrip` renders terminal-side UI cards for interactive prompts and
  recent CLI activity derived from canonical `cli_event` metadata.

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
- `MobileHeader` compact header with hamburger menu.
- `MobileStatusBar` session info and stats.
- `MobileDrawer` side navigation for mobile.
- `MobileSessionPicker` quick jump list for 4+ active sessions.
- `MobileGestureHints` first-run onboarding for swipe and long-press gestures.

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
5. Server also emits terminal metadata frames with `__terminal_meta: true`.
   - Legacy conversation metadata: `type: "turn"` with `{ role, content, ts }`.
   - Canonical CLI metadata: `type: "cli_event"` with
     `{ event: { type, ts, source, ... } }` where `type` is one of:
     `user_turn`, `assistant_turn`, `prompt_required`, `status`, `error`.
6. Sessions are persisted as JSON history snapshots.

### Legacy Claude Code Sessions (Fastify)
1. Start via `POST /api/claude-code/start`.
2. Stream events over SSE at `/api/claude-code/:id/stream`.
3. Persist sessions for later restore.

### Preview Pipeline
1. Terminal output is scanned for dev server URLs.
2. Preview panel transforms URLs into a preview-safe URL:
   - Static files -> `/api/preview`.
   - Local servers (localhost access) -> `/preview/{port}` (path-based).
   - Local servers (LAN/remote access) -> subdomain `preview-{port}.{ip}.nip.io`.
   - Private LAN servers on different hosts stay direct (for example `http://192.168.x.x:port`).
   - External -> `/api/proxy-external`.
3. Injected scripts send logs to `/api/preview/*/logs`.
4. Port dropdown only shows ports with active listeners (validated via `ss -tlnp`).
5. Preview URL persists across sessions but clears if the port stops listening.

## Persistence and Data Storage

### SQLite (terminal.db)
Location in the active Rust runtime: `<data_dir>/terminal.db`, where `data_dir`
defaults to the platform app data directory plus `terminal-v4`, overridden by
`TERMINAL_DATA_DIR` or `DATA_DIR`. Stores:
- `users`
- `refresh_tokens`
- `user_settings`

### File-Based Stores (JSON)
Under `<data_dir>/users/<userId>/` in the active Rust runtime:
- `sessions/*.json` (terminal history with metadata)
- `bookmarks.json` (command bookmarks with cwd)
- `notes.json` (project notes)

The legacy Fastify stores also include `sessions-metadata.json` (session recovery
index) and `claude-code/*.json` (legacy Claude Code session events).

Structured conversations in the active Rust runtime live in
`AppConfig.data_dir/structured-sessions/<sha256-owner>/<session-id>.json`.
Version 2 uses one JSON-lines file: an owner-bound checkpoint followed by ordered
event records. Each record is synced before updating live state or broadcasting;
streaming no longer clones and rewrites the complete transcript for each chunk.
Metadata mutations, recovery and bounded journal compaction atomically replace
the checkpoint. Legacy version 1 snapshots remain readable and migrate on load.
New sessions include an inert incarnation UUID in their checkpoint; legacy
sessions without one retain that state. Older binaries may discard the field,
and it does not establish exclusive ownership or authorize session actions.
Context and knowledge readers share the decoder, so appended events participate
in history, busy-state and stale-read checks. Full history and the existing
canonical byte/event limits remain available. Sidebar polling uses a separate
metadata-only projection with sequence watermarks.

### Preview Cookies
The active Rust runtime uses an in-memory per-user/per-port cookie jar; it does
not restore cookies after restart. The legacy Fastify implementation stores
`preview-cookies.json` under its configured data directory (`backend/data` by
default, overridable via `TERMINAL_DATA_DIR` or `DATA_DIR`).

### In-Memory Stores
- Preview logs (console/network/DOM)
- Proxy request logs
- Process logs

## Operations Notes

- **Stable data directory**: In production, set `TERMINAL_DATA_DIR` explicitly.
  The active Rust runtime otherwise uses the platform app data directory plus
  `terminal-v4`; it does not derive the data directory from `dist/`.
- **Build and restart**: `rebuild.sh` / `rebuild.ps1` build the frontend and Rust
  release runtime without restarting services. The authenticated rebuild endpoint
  honors the configured project/script paths. Restart the owning application or
  service separately. To retain tmux sessions across explicit service restarts,
  use `KillMode=process` or run tmux outside its cgroup. See
  `docs/development/SETUP.md`.

## Security and Sandboxing

- JWT auth is required for most `/api/*` routes.
- Public routes include health checks, preview logs, process logs, and
  browser automation endpoints.
- Preview file server is sandboxed to the project root.
- File manager list, upload, rename, delete, unzip, download, and ZIP creation
  use canonical containment checks to reject traversal, symlink escapes, and
  paths outside allowed roots. Allowed roots default to the user's home
  directory plus the server working directory; deployments can add roots with
  `TERMINAL_V4_ALLOWED_FILE_ROOTS`.
- Dev proxy allows localhost ports across the valid TCP range (1-65535),
  excluding the Terminal V4 UI port to prevent self-preview recursion.
- External proxy blocks localhost and private IP ranges.

## Development vs Production

Development:
- Frontend: `vite dev` on port 5173
- Backend: `cargo run -p terminal-v4-api --manifest-path rust/Cargo.toml` on port 3020

Production:
- Build frontend (`frontend/dist`)
- Rust Axum serves static assets and SPA fallback

## Workspace knowledge and project defaults

The Rust API stores user- and directory-scoped workspace profiles as bounded JSON
files in the application data directory. Authenticated GET/PUT routes canonicalize
the selected workspace and use hashed user/directory keys; saves replace files
atomically. The React workspace editor is shared by desktop, mobile, and
new-session surfaces. Selected notes and skills are copied into an editable
prompt before sending. New-session agent/model defaults resolve by directory,
with manual selection taking precedence. Launch commands are obtained from the
live provider catalog.

See [Workspace feature guide](../features/HERMES_T3_WORKSPACE.md) for the data
contract, source inspection, limits, and current scope.


## Agent workspace orchestration

The active Rust host exposes agent catalog/authentication routes and workspace
modules for profiles, staged learning proposals, installed skill discovery, Git
worktrees/checkpoints, saved-body search, native history import, and durable
tasks/schedules. The React workspace tools dialog is shared by desktop and mobile.

Provider commands are built with argv APIs for background execution. Windows npm
Codex resolves through Node plus its installed script; catalog launcher metadata
also identifies the host shell for interactive PTYs. Native authentication is
reported as unknown until the native runtime verifies it. API credentials remain
encrypted in the existing owner-scoped vault.

A single queue worker registration owns each data directory. It claims at most
three distinct canonical workspaces, persists intent and transitions, contains
child process trees, and recovers interrupted runs and completion receipts.
Graceful shutdown signals workers before the server runtime exits. Unix process
guards retain descendant PID birth identities across process-group changes,
request graceful termination and use a bounded forced fallback. Only confirmed
owned descendants are signalled; command lines and credential environments are
not read. Windows guards use kill-on-close Job Objects. Approved shell commands share
these guards and stop tracked descendants after completion, timeout or cancellation.
Their stdout/stderr retain at most 512 KB each while excess bytes continue to drain,
so output limits do not block finite commands on full pipes. On Unix the native
Codex app server starts in its own process group, allowing cleanup to find group
members even if its leader exits before they are observed. The adapter watches
the leader and begins cleanup if it exits while a child still holds its output
pipe; already-written protocol messages continue through the normal reader.
Non-tmux terminal trees
are stopped and their retained/pending history is saved during service shutdown;
tmux-backed sessions retain their deliberate server-side persistence while their
app-owned clients detach. Separate worktrees allow parallel file changes without
sharing one working directory.

PID ancestry tracking is a cleanup boundary, not an OS sandbox. A process that
double-forks and becomes an orphan before observation, or a host process killed
without a chance to run cleanup, is not guaranteed recoverable by Unix ancestry
tracking. Controlled cancellation freezes/discovers the known tree before
termination; MCP/browser guards additionally own their direct subprocesses.
Windows enrollment occurs immediately after spawn and is not an atomic suspended
launch. Platform-specific behavior must be verified on that platform.

Checkpoints use private Git indexes/hidden refs and guarded file restore; provider
conversation state is independent. Archive retains checkout files. Imported
native transcripts are owned snapshots and portable text context, not native
runtime sessions. Existing browser preview and developer tooling remain the
application's inspection surface.

Compatible API providers run in V4's own same-binary agent CLI. It reads the
owner's encrypted vault key and calls the provider directly through original
Anthropic Messages, OpenAI Responses or Chat Completions adapters. Its bounded
workspace tools, per-command approvals, private conversation history and task
result protocol are implemented in `v4_agent`. No Hermes process or profile is
used. See [V4 runtime](../features/V4_RUNTIME.md) for verified behavior and limits.


## Paired hosts and native conversation rewind

The authenticated home server owns paired-host records and encrypted outbound
runtime credentials. Destination one-use code exchange issues a revocable,
expiring grant bound to the destination account. Browser runtime traffic stays
on the home origin through an allowlisted HTTP/WebSocket proxy; the home identity
is never reused as a remote login. Workspace state and client persistence are
partitioned by environment, and switching remounts the runtime workspace.

Conversation rewind coordinates existing private-index Git checkpoints with
Claude/Codex native branching and V4-owned conversation forks. An owner-scoped durable operation
journal records native boundaries, source fingerprints, selected files and
recovery checkpoints. Managed-worktree and active-process checks run before
mutation. Resume creates an app terminal for the native fork. Partial failures
retain explicit recovery state instead of presenting a cosmetic transcript
rollback. See [feature workflow](../features/PAIRED_ENVIRONMENTS_AND_REWIND.md).

## Remote workspace runtime

The device directory and grant profiles extend paired_environments. Every delegated HTTP method and runtime socket message is checked against remote_permissions. Raw paired credentials remain server-side; direct target requests repeat authorization and revocation checks. Owner identity gates browser state restoration before the workspace providers mount. Connection generations cancel stale work on host changes, and sequence cursors reconcile history/live overlap without replaying input.

Feature modules isolate durable file transfers, guest collaboration, session recordings, local TCP forwarding, device relay and optional native desktop sessions. File-transfer publication participates in the hierarchical workspace activity guard, including ancestor-directory mutations. Recording and relay tasks use bounded queues, deadlines and explicit shutdown. start_services starts configured outbound relay registration after listener binding; shutdown_services stops relay, tunnels, captures and task workers.

Guest credentials authorize only a named existing terminal. OS shell access retains its native host permissions. Native desktop access requires an explicit Windows host opt-in and request capability checks. Background hosting is a protected current-user Windows launcher/logon task; Tauri attach mode does not own that process. Broker hosting, TLS termination and startup installation are separate deployment actions.

See [remote workspace](../features/REMOTE_WORKSPACE.md), [background host](../features/BACKGROUND_HOST.md), and [device relay](../features/DEVICE_RELAY.md) for operating limits and configuration.

### Workspace presentation

The React workspace shell uses neutral dark/light tokens and system UI typography in styles.css. The desktop shell has one project/thread sidebar, with labelled file/preview/notes/bookmark controls, Settings in its footer, and appearance/sign-out actions in the footer menu; collapsing it restores a compact vertical toolbar. There is no duplicate desktop title/navigation row above the main canvas. WorkspaceShell.css coordinates environment chrome, the project/thread sidebar, the composer start view and remote/workspace dialogs. New thread and home navigation select the start view without creating a process; selecting or creating a session returns to the appropriate terminal or structured conversation surface. The existing desktop/mobile split remains in App.jsx, while backend session and permission ownership remain unchanged.

The start view puts project, conversation agent, model and reasoning choices inside
one composer. Existing projects switch inline; adding a folder uses a folder-only
picker. Choosing a project does not start a process. Sending creates a structured
conversation and delivers the prompt through the existing agent input API, including
Codex's durable request/receipt flow. Natural-language prompts never become shell
commands. Drafts survive launch errors, and submitting is gated independently of
typing so users can draft before selecting a project. Desktop and phone share the
same flow. The terminal launcher remains an explicit overflow action.

The new-thread launcher presents folder browsing first, followed by compact
agent, model and reasoning controls. Optional naming and project knowledge live
under More options. It uses the existing project defaults, saved selections and
launch callbacks; authentication and unavailable-runtime notices remain visible.
Folder-only workspace selection omits agent configuration. The dialog manages
keyboard focus and restores focus to its opener when closed.

Folder navigation clears the current name filter when entering a child, going up,
or selecting a breadcrumb. Unmatched searches are labelled separately from empty
directories and expose a clear-search action.

The desktop structured conversation uses a single pane header for its title, runtime status, cancellation, and layout controls. Its composer shares the new-task prompt styling, with project/provider/model context always visible; input utilities and project tools live in disclosure menus. Choosing a project focuses the new-task prompt and explains that sending a task starts execution. Completed tool cards expose status and a readable command preview, with keyboard-accessible details containing the full input and output. These are presentation changes; frontend reconnection continues the backend-owned session.

Consecutive completed structured tool messages are presented as collapsed activity batches, with a visible action count and failure count. Expanding a batch mounts its tool rows and image results on demand; each row retains expandable full input/output. Assistant responses remain between batches in transcript order. The lightweight message renderer supports bold emphasis, named safe links, and semantic Markdown tables without loading a general Markdown runtime.

Activity summaries describe recognized tool operations (reads, searches, edits, and commands). Simple shell command shapes may receive a readable label; mixed or unrecognized commands retain a neutral label. Shell wrappers are removed only from the preview, while expansion preserves the original command and separates input from output. Completed status remains available to assistive technology; running and failed states remain visually explicit.

The desktop sidebar places the project/chat tree immediately after search, with Files, Preview, Notes, Bookmarks and project tools grouped above Settings. Project expansion follows arriving session inventory until the user explicitly toggles it, making existing chats discoverable without overriding manual collapse. Project headers expose expansion state, reveal action buttons on hover or keyboard focus, and let nested buttons receive their own keyboard events. The shell retains the environment selector, pane controls, and composer utilities with shared spacing and accessible labels.

### Idle Codex composer selection

The active desktop composer uses the existing project and agent model pickers.
Model/effort updates go through an owned-session PATCH, preserve native thread
identity and history, and apply on the next response. Busy sessions reject updates.
Changing projects opens a new-task draft rather than moving the existing thread.
Confirmed selection updates invalidate older inventory responses.

### Isolated WebContainer runner

WebContainer uses a separate trusted top-level `/webcontainer` document (also
`/webcontainer/`) on the UI origin. Only that document receives COOP
`same-origin`, COEP `require-corp`, and `Cache-Control: no-store`. `main.jsx`
selects the runner before importing the normal App. The normal app, API, static
assets, local/external/paired previews, and existing opaque preview sandbox keep
their existing policies. The SDK always boots with the matching `require-corp`
mode; the feature no longer depends on a non-isolated Chromium Origin Trial.

The normal preview's **Open WebContainer window** action opens a `noopener` tab
and leaves its proxy running. The URL carries only a random 128-bit fragment ID.
A bounded two-minute launch record contains owner/session/Home, local project
path and start command, never tokens or source. Creation, expiry cleanup and
one-use claim share an exclusive Web Lock. The runner uses the existing
AuthProvider/LoginPage and authenticated file API, rather than a file/credential
bridge. It stays pinned to its displayed project; changing the main tab's
project does not repoint an independent running window. Paired-host launches are
rejected, including stored environment changes detected after the claim.

The runner verifies stored auth/session/Home/environment before and after awaited
work and on notifications/focus/resume. Revocation cancels reads, removes source,
logs and the project iframe, and retires the runtime, including a late boot.
Same-session token rotation can continue. Stop and Retry preserve the existing
process-generation and raw-spawn/confirmed-exit drain barrier. A blocked drain
fails visibly after ten seconds without releasing unsafe ownership.

File exports retain binary bytes and public assets, with 1 MiB/file, 50 MiB raw
contents, 10,000 entries and 32 directory levels. Known private environment,
package-manager credential/configuration and key material are omitted before
content reads. Responses contain at most 100 relative omission paths (512
characters each), a total and a truncation flag; secret values are not returned.
Safe example/sample/template filenames remain available. This policy is not
universal secret detection. Scripts can access everything that is mounted, so
omissions require visible review before execution. The runner also limits the
decoded HTTP response to 64 MiB before JSON parsing; an over-budget export fails
with a proxy-preview fallback instead of silently dropping imports.

Project HTML runs only in the SDK's distinct HTTPS `*.local-corp.webcontainer-api.io`
origin. The project iframe permits scripts/same-origin within that vendor origin,
forms, modals and downloads; it has no app-origin access, top navigation, popup
escape, or camera/microphone grant. The normal proxy's separate sandbox is not
changed by the runner.

## Interactive workspace browser

`WorkspaceBrowser` provides a human-controlled Chromium viewport beside the
desktop terminal and as a selectable mobile surface. It has independent tabs,
an address/search bar, history, pointer/keyboard input, paste, touch scrolling,
and a text entry field for phone keyboards. ResizeObserver matches the remote
viewport to the pane. Development Preview and its inspector remain separate.

`workspace_browser.rs` owns one browser helper per authenticated account and data
directory, with eight total browser slots and up to eight tabs per helper. The
embedded Node helper uses app-owned Node 22.23.1, Playwright 1.64.1 and Chromium
revision 1248 with its sandbox enabled and a new temporary context. The generated
`.runtime/browser` is bundled as `browser-runtime/`; `browser_runtime.rs` resolves
and validates only app-owned runtime roots, never installed Chrome or a shared
Playwright cache. `npm run browser:install` prepares the native-host bundle and
`browser:verify` exercises its local launch/DOM/screenshot path; this does not
prove portability to other machines or packaged targets. HTTP commands and JPEG
frames use the normal authenticated API, including Tailscale; no CDP port is exposed. Arbitrary client
JavaScript evaluation and host file URLs are unavailable. Session lookup checks
both owner and UUID. Responses use private/no-store caching.

Sessions retain their tabs and sign-ins while the pane is hidden, then expire
after 30 minutes without browser requests. Reset, logout and shutdown close the
owned helper/process tree; failed cleanup retains ownership for a retry. Sessions
use the home server independently of the selected paired environment. This UI
browser is also the browser used by native Codex, native Claude and in-app V4
conversations: all share this account/data-directory context, tabs, cookies and
sign-ins, including across workspaces. Personal browser profiles and auth state
are not imported. File uploads, downloads and durable browser profile restore
are unavailable. The engine runs headless on the API host and is visible remotely
through the pane's frame transport.

`workspace_browser_mcp.rs` exposes the app-owned `terminal_v4_browser` tools to
native structured adapters through a loopback MCP URL and a random bearer
capability, scoped to account, data directory and agent label. The 12-hour lease
is revoked when its last owner is dropped; cancellation also invalidates queued
operations. Native browser actions require an exact Browser-pane decision,
including reads and evaluation; releasing control needs no decision. Approvals
bind arguments, settings and the reviewed session/tab/document/control generation
as applicable, and expire after 60 seconds. Codex also keeps native tool approvals
enabled. Claude print mode allow-lists only these browser transport tools, whose
execution is still held at the pane gate; ordinary native tools retain their
native permission restrictions and generic confirmation cannot grant them exact
tool permission. V4 dispatches directly through its own exact-action conversation
approval gate, binding configuration and the reviewed session/tab/document/control
target. Shared errors propagate without launching a standalone browser.

Control is available, human-owned or owned by one agent label. **Take control**
cancels pending native actions and invalidates queued work's control generation;
agent mutations wait for **Let agents control**. Fresh approved reads of permitted
pages remain possible during human control, without switching the human's active
tab or installing an agent policy. `allowedOrigins` gates agent targets and
resource requests; HTTP routing, popup policy inheritance and WebSocket/proxy
checks enforce it, with service workers blocked. Human input mutations release
agent policies across the session. These checks are not an OS network/filesystem sandbox.
Page content is untrusted. Email content or metadata requires task-specific
explicit consent and the exact address before access; origin/action approval
does not replace consent. This is an agent policy, not automatic detection of all
email or private content. See [V4 agent browser tools](../features/V4_AGENT_BROWSER.md).
