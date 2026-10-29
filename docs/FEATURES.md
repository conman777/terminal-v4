# Terminal v4 - Feature Catalog

This catalog describes the active Rust API and web workspace. Provider-backed tools require a configured runtime, and remote operations require the corresponding device permission. Availability in a menu does not establish that an external provider or device is connected.

## Core Terminal Features

### Terminal Emulation
- **Full PTY Support**: Rust-managed pseudo-terminals for interactive programs (vim, Python REPL, etc.)
- **xterm.js Rendering**: Professional terminal UI with ANSI color support
- **WebGL Acceleration**: Optional WebGL renderer for improved performance
- **Tmux Integration**: Optional tmux support for session persistence across server restarts
- **Multi-Session Management**: Create and manage unlimited terminal sessions simultaneously
- **Session History**: Persistent terminal output history with search capability
- **Configurable Working Directory**: Set default cwd for new terminal sessions

### Terminal UI
- **Split Pane Layouts**: Up to eight panes with pointer and keyboard resizing; saved child proportions survive reopening and viewport changes
- **Fullscreen Mode**: Focus on a single terminal pane
- **Reader View**: Accessible terminal output reading with pagination
- **Tab Bar**: Visual tabs with drag-to-reorder support
- **Session Navigation**: Quick switch between sessions
- **Terminal Resizing**: Automatic PTY resize on window/pane changes
- **Font Size Control**: Adjustable terminal font size (8-32px)

## Claude Code Integration

- **Native Claude CLI Integration**: Run Claude Code directly in PTY
- **SSE Event Streaming**: Real-time streaming of Claude responses
- **Multiple Sessions**: Run multiple Claude Code instances simultaneously
- **Session Persistence**: Save and restore Claude Code sessions
- **Model Selection**: Switch between Claude models (Sonnet, Opus, Haiku)
- **Working Directory Control**: Set cwd for each Claude session
- **Tool Visibility**: View tool calls and responses in structured format
- **Access modes**: Per-thread Supervised (approve each action, with "Allow for this session"), Auto-edit (default) or Full access, for Claude Code and Codex
- **Plan mode**: Read-only planning turns with "Implement plan" or "Implement in a new thread"
- **Questions**: Codex questions appear as answerable cards in the conversation
- **Per-turn changes**: Files each turn changed, with diffs (stacked or side by side) and line comments that go into your next message
- **Thread details**: Branch, uncommitted changes, Commit/push/PR, pull request checks and review, Open in editor, project scripts, terminal drawer with several terminals
- **Composer**: Slash commands and installed skills by name, `@` file mentions, any-file attachments, queued messages while a reply runs, stashed drafts, context-window meter
- **Usage**: Settings → Usage totals tokens and cost (where reported) per thread
- **Messaging**: Settings → Messaging connects a Telegram bot to talk to a thread from one paired chat

## Shared Browser

- **App-owned Chromium**: The server runs the bundled browser; the web interface displays its frames and forwards human input. Websites run on the server, including when viewing Terminal v4 through Tailscale.
- **Tabs and navigation**: Address/search input, Back/Forward based on actual tab history, reload, tab switching, and retained tabs when the pane is hidden.
- **Shared human/agent context**: Coding agents use the same pages through account- and session-scoped capabilities. Human takeover pauses agent control.
- **Explicit browser review**: Exact browser actions require a broker decision; the injected Codex transport does not add a second duplicate prompt. Other native permissions remain separate.
- **Scope**: Profiles are disposable. Browser file pickers, downloads, and durable website profiles are not exposed by the workspace browser. File management is available in Files.

See [Agent browser](features/V4_AGENT_BROWSER.md) for runtime packaging, approvals, origin restrictions, and cleanup behavior.

## Preview & Development

### Preview Panel
- **Local Dev Server Preview**: Preview apps running on local ports
- **Subdomain Routing**: `preview-{port}.{PREVIEW_SUBDOMAIN_BASE}` (or `.localhost` in local dev) for isolated previews. When accessing Terminal V4 via a LAN IP/hostname, use a resolvable base (e.g. `preview-{port}.{ip}.nip.io`).
- **Path-Based Routing**: `/preview/{port}` fallback for localhost/same-host private IP access. Private LAN hosts on different machines stay direct (`http://192.168.x.x:port`) instead of being rewritten to local preview.
- **Static File Serving**: Preview static HTML/JS/CSS files from project
- **External Site Proxying**: Preview external websites with debugging
- **Cache Busting**: Deep cache-busting for HTML, JS, CSS, and imports
- **Cookie Management**: Server-side cookie jar for session persistence
- **Picture-in-Picture**: Floating preview window that stays on top

### DevTools
- **Console Tab**: Capture console.log, warnings, errors, and info
- **Network Tab**: Monitor HTTP requests with timing, status, and headers
- **Storage Tab**: Inspect localStorage, sessionStorage, and cookies
- **WebSocket Tab**: Monitor WebSocket connections and messages
- **Performance Tab**: Optional inspector enabled by `VITE_ENABLE_PERFORMANCE_TAB=true`; displays the metrics supplied by the selected preview
- **Log Filtering**: Search and filter logs by type, level, or content
- **JSON Viewer**: Pretty-print JSON responses and payloads

### Screenshots & Recording
- **Full Page Screenshots**: Capture entire preview page
- **Element Screenshots**: Screenshot specific elements by CSS selector
- **Video Recording API**: Browser capture produces WebM; the current web toolbar does not expose preview recording start/stop. Session replay is a separate feature.
- **Screenshot Gallery**: Browse, view, and delete saved screenshots
- **Configurable Dimensions**: Set custom viewport width/height

## Mobile Experience

### Mobile UI Components
- **Mobile Header**: Compact top bar for session switching, new terminal actions, overflow utilities, and drawer access
- **Mobile Drawer**: Sidebar-style mobile navigation for threads, projects, bookmarks, notes, and settings
- **Mobile Shell**: Phone-sized container for the same terminal runtime and composer flow used on desktop
- **Session Picker**: Header-driven active-session switching without a persistent desktop-style tab strip
- **Shared Terminal Runtime**: Mobile uses the same `TerminalChat` transport, session lifecycle, and reconnect path as desktop
- **Shared Ask V4 Composer**: Mobile reuses the desktop composer bar, including AI selection, attachments, slash commands, and voice input
- **Structured Session View**: Structured sessions reuse the desktop conversation surface with an inline terminal toggle

### Mobile Optimizations
- **Viewport Height Handling**: Proper handling of mobile browser chrome
- **Keyboard Responsiveness**: Fast keyboard show/hide detection
- **Touch Scrolling**: Smooth touch-based terminal scrolling
- **Responsive Layouts**: Adaptive UI for tablets and phones

## File & Project Management

### File Manager
- **File Browser**: Navigate filesystem with folder tree
- **File Upload**: Drag-drop or select files to upload
- **File Download**: Download individual files or zip directories
- **Rename**: Rename files and folders within the current folder from the Files action menu. Moving to another path is available through the Files API or terminal; the Files UI exposes rename only.
- **Delete**: Delete files and directories
- **Unzip**: Extract zip files in place
- **Folder Navigation**: Breadcrumb navigation
- **Recent Folders**: Quick access to recently visited directories
- **Pinned Folders**: Pin frequently-used folders

### Project Scanner
- **Git Repository Detection**: Automatically scan for git repos
- **Custom Scan Paths**: Add custom directories to scan
- **Project Metadata**: Display repo info (name, path, git status)
- **Quick Navigation**: Open terminal in project directory

## Process Management

- **Running Process Detection**: Detect dev servers by listening ports
- **Process Start/Stop**: Start and stop project dev servers
- **Process Logs**: Capture stdout/stderr from managed processes
- **Port Association**: Link logs to specific ports
- **Top Processes**: View system processes by CPU/memory usage with ports

## System Monitoring

### Real-Time Stats
- **CPU Usage**: Current CPU utilization percentage and core count
- **Memory Usage**: RAM usage with used/total breakdown
- **Disk Usage**: Used/total space across disks
- **Top Processes**: The busiest processes by CPU, then memory

### Historical Statistics
- **Stats History**: 5-minute interval tracking for 30 days
- **Time Range Queries**: View stats for 1h, 6h, 24h, 7d, or 30d
- **CPU History**: Historical CPU usage trends
- **Memory History**: Historical RAM usage trends
- **Disk History**: Historical disk usage percentage

## Voice & Audio

- **Voice Input**: Microphone recording with waveform visualization
- **Groq Whisper Transcription**: AI-powered voice-to-text
- **Multiple Audio Formats**: Support for various audio formats
- **Inline Mic Button**: Voice input directly in terminal
- **Audio Feedback**: Visual waveform during recording

## Bookmarks & Notes

### Bookmarks
- **Command Bookmarks**: Save frequently-used commands
- **Execute Bookmarks**: Run saved commands directly in terminal
- **Bookmark Management**: Create, update, delete bookmarks

### Notes
- **Project Notes**: Simple text notes for documentation
- **Note Management**: Create, update, delete notes
- **Markdown Support**: Rich text rendering for notes

## Authentication & Security

- **JWT Authentication**: Secure token-based auth
- **Refresh Tokens**: Long-lived refresh tokens with rotation
- **User Isolation**: Per-user session and data isolation
- **Username Restriction**: Optional single-user mode via `ALLOWED_USERNAME`
- **Password Change**: Users can update their passwords
- **Hashed Passwords**: bcrypt password hashing

## Settings & Configuration

### User Settings
- **Terminal Font Size**: Adjustable font size (8-32px)
- **Sidebar State**: Remember sidebar collapsed/expanded
- **Preview URL**: Remember last preview URL
- **Groq API Key**: Store transcription API key
- **Appearance**: Light/dark theme, accent colour presets and conversation width (Settings → Interface)

### Agent Browser Settings
- Enable browser tools, configure allowed origins, and set the action timeout on Home.
- Advanced executable and headless options apply to standalone V4 runs. The shared workspace browser uses the bundled engine and frame transport.
- The Browser settings shortcut opens this supported configuration. The retired `/api/settings/browser` lifecycle form is not an active API.

## Developer Tools

### System Management
- **System Rebuild**: `POST /api/system/rebuild` runs `rebuild.sh` and returns its output. It is off unless the server starts with `TERMINAL_V4_ALLOW_REBUILD=1`; there is no UI for it, and restarting stays manual
- **Setup check**: Settings → Setup check (`GET /api/system/doctor`) confirms Git, Claude Code, Codex, the GitHub CLI and the data folder

### Keyboard Shortcuts
- **Command palette**: ⌘K / Ctrl+K runs any workspace command or jumps to a thread
- **Find in thread**: ⌘F / Ctrl+F highlights and steps through matching messages
- **Configurable**: Settings → Keyboard shortcuts rebinds palette, find, sidebar, preview, full screen, new and close terminal

### Advanced Features
- **WebSocket Latency Testing**: Measure round-trip time
- **Health Check Endpoint**: Monitor server health
- **Idle Detection**: Detect user inactivity
- **Favicon Notifications**: Flash favicon for alerts
- **Agent Notifications**: Optional system notifications when a thread finishes or needs approval while you are in another window
- **Session Activity Tracking**: Track last activity per session

## Persistence & Data Storage

### SQLite Database (`terminal.db` in the data directory)
- User accounts
- Refresh tokens
- User settings

### File-Based Storage
- Terminal session history
- Claude Code sessions
- Bookmarks
- Notes
- Preview cookies
- Session metadata

### In-Memory Storage
- Preview logs (console, network, errors)
- Proxy request logs
- Process logs
- Active terminal sessions

## Integration & Extensibility

- **API-First Design**: RESTful API for all functionality
- **WebSocket Support**: Real-time bidirectional communication
- **SSE Streaming**: Server-sent events for long-running operations
- **Multi-Format Support**: JSON, binary, streaming, and multipart
- **CORS Support**: Cross-origin resource sharing enabled
- **Cloudflare Tunnel**: Built-in tunnel routing support

## Performance & Optimization

- **Lazy Loading**: React component lazy loading
- **Code Splitting**: Optimized bundle sizes
- **WebGL Rendering**: GPU-accelerated terminal rendering
- **Virtual Scrolling**: Efficient rendering of long terminal output
- **Memory Monitoring**: Automatic memory usage tracking
- **Log Trimming**: Automatic cleanup of old logs
- **Session Cleanup**: Automatic cleanup of idle browser sessions

## Cross-Platform Support

- **Linux**: Full support with tmux, disk I/O monitoring
- **macOS**: Full support with tmux integration
- **Windows**: PowerShell/cmd support (limited tmux)
- **Desktop**: Full-featured desktop web experience
- **Mobile**: Optimized touch interface for iOS/Android
- **Tablet**: Adaptive layouts for tablet devices
