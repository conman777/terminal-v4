# Terminal v4 - Feature Catalog

This document provides a comprehensive overview of all features in Terminal v4.

## Core Terminal Features

### Terminal Emulation
- **Full PTY Support**: True pseudo-terminal with node-pty for interactive programs (vim, Python REPL, etc.)
- **xterm.js Rendering**: Professional terminal UI with ANSI color support
- **WebGL Acceleration**: Optional WebGL renderer for improved performance
- **Tmux Integration**: Optional tmux support for session persistence across server restarts
- **Multi-Session Management**: Create and manage unlimited terminal sessions simultaneously
- **Session History**: Persistent terminal output history with search capability
- **Configurable Working Directory**: Set default cwd for new terminal sessions

### Terminal UI
- **Split Pane Layouts**: Multi-pane terminal view with draggable dividers
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
- **Performance Tab**: Display web vitals (FCP, LCP, CLS, FID, TTFB)
- **Log Filtering**: Search and filter logs by type, level, or content
- **JSON Viewer**: Pretty-print JSON responses and payloads

### Screenshots & Recording
- **Full Page Screenshots**: Capture entire preview page
- **Element Screenshots**: Screenshot specific elements by CSS selector
- **Video Recording**: Record preview session as MP4 video
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
- **Rename/Move**: Rename or move files and folders
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
- **CPU Usage**: Current CPU utilization percentage
- **Memory Usage**: RAM usage with total/used/free breakdown
- **Disk I/O**: Real-time read/write MB/s for all block devices
- **Event Loop Delay**: Node.js event loop monitoring (mean and max)
- **Top Processes**: List of processes by CPU/memory with port info

### Historical Statistics
- **Stats History**: 5-minute interval tracking for 30 days
- **Time Range Queries**: View stats for 1h, 6h, 24h, 7d, or 30d
- **CPU History**: Historical CPU usage trends
- **Memory History**: Historical RAM usage trends
- **Disk I/O History**: Historical disk read/write rates

## Voice & Audio

- **Voice Input**: Microphone recording with waveform visualization
- **Groq Whisper Transcription**: AI-powered voice-to-text
- **Multiple Audio Formats**: Support for various audio formats
- **Inline Mic Button**: Voice input directly in terminal
- **Audio Feedback**: Visual waveform during recording

## Bookmarks & Notes

### Bookmarks
- **Command Bookmarks**: Save frequently-used commands
- **Working Directory**: Associate commands with specific directories
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
- **Theme Customization**: Custom color themes (via StyleEditor)

### Browser Automation Settings
- **Idle Timeout**: Auto-close idle browser sessions
- **Max Lifetime**: Maximum browser session duration
- **Cleanup Interval**: Frequency of cleanup checks

## Developer Tools

### System Management
- **System Rebuild**: Remotely trigger rebuild.sh script
- **Build Output**: View rebuild logs and status
- **Server Restart**: Restart backend server

### Keyboard Shortcuts
- **Global Shortcuts**: System-wide keyboard shortcuts
- **Context-Aware**: Different shortcuts per UI context
- **Configurable**: Customizable shortcut bindings

### Advanced Features
- **WebSocket Latency Testing**: Measure round-trip time
- **Health Check Endpoint**: Monitor server health
- **Idle Detection**: Detect user inactivity
- **Favicon Notifications**: Flash favicon for alerts
- **Session Activity Tracking**: Track last activity per session

## Persistence & Data Storage

### SQLite Database
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
