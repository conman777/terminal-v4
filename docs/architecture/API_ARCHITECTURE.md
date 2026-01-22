# API Architecture

## Conventions

- Base path: `/api/*`
- Auth: `Authorization: Bearer <accessToken>`
- SSE/WS: `?token=<accessToken>` is supported for EventSource/WebSocket clients
- JSON request/response for most endpoints (streaming for SSE/WS, binary for downloads)

## Authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | Public | Login, returns `{ user, tokens }` |
| POST | `/api/auth/refresh` | Public | Refresh tokens |
| POST | `/api/auth/logout` | Yes | Invalidate refresh tokens |
| GET | `/api/auth/me` | Yes | Current user info |
| POST | `/api/auth/register` | Public | Disabled (always 403) |

## Terminal Sessions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/terminal` | Yes | List terminal sessions |
| POST | `/api/terminal` | Yes | Create session |
| GET | `/api/terminal/:id/history` | Yes | History snapshot |
| GET | `/api/terminal/:id/project-info` | Yes | Project info from cwd |
| POST | `/api/terminal/:id/input` | Yes | Send input (HTTP fallback) |
| POST | `/api/terminal/:id/resize` | Yes | Resize PTY (optional `clientId`) |
| PATCH | `/api/terminal/:id` | Yes | Rename session |
| DELETE | `/api/terminal/:id` | Yes | Close session |
| POST | `/api/terminal/:id/restore` | Yes | Restore persisted session |
| GET | `/api/terminal/:id/stream` | Yes | SSE stream of output |
| GET | `/api/terminal/:id/ws` | Yes | WebSocket for IO |

WebSocket notes:
- The first frame is JSON: `{ type: "clientId", clientId: "..." }`.
- Subsequent frames are raw terminal output/input (string data).

## Consolidated State

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/state` | Yes | Sessions + project info + Claude Code sessions |

## Claude Code

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/claude-code` | Yes | List sessions |
| POST | `/api/claude-code/start` | Yes | Start session (cwd, model) |
| GET | `/api/claude-code/:id` | Yes | Fetch session |
| GET | `/api/claude-code/:id/stream` | Yes | SSE event stream |
| POST | `/api/claude-code/:id/input` | Yes | Send prompt |
| POST | `/api/claude-code/:id/restore` | Yes | Restore inactive session |
| POST | `/api/claude-code/:id/stop` | Yes | Stop session process |
| DELETE | `/api/claude-code/:id` | Yes | Delete session |
| PATCH | `/api/claude-code/:id/cwd` | Yes | Update session cwd |
| PATCH | `/api/claude-code/:id/model` | Yes | Update model |

## Preview + Proxy

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/preview` | Yes | Serve static file from project root |
| GET | `/api/preview/:port/cookies` | Yes | Preview cookie jar status |
| DELETE | `/api/preview/:port/cookies` | Yes | Clear preview cookies |
| GET | `/api/preview/:port/proxy-logs` | Yes | Server-side proxy logs |
| DELETE | `/api/preview/:port/proxy-logs` | Yes | Clear proxy logs |
| GET | `/api/preview/active-ports` | Yes | List active preview ports |
| GET | `/api/preview/:port/storage` | Yes | Request storage snapshot (local/session/cookies) |
| POST | `/api/preview/:port/storage` | Yes | Queue storage update (set/remove/clear/import) |
| POST | `/api/preview/:port/evaluate` | Yes | Queue JS evaluation in preview context |
| POST | `/api/preview/:port/logs` | Public | Receive injected client logs |
| GET | `/api/preview/:port/logs` | Public | Read preview logs |
| DELETE | `/api/preview/:port/logs` | Yes | Clear preview logs |
| GET | `/api/preview/logs` | Public | List active preview ports with counts |
| POST | `/api/preview/external/logs` | Public | External site logs |
| GET | `/api/preview/external/logs` | Public | Read external logs |
| DELETE | `/api/preview/external/logs` | Public | Clear external logs |
| GET | `/api/proxy-external` | Yes | Proxy external URL (`?url=`) |
| ALL | `/api/dev-proxy/:port/*` | Yes | Proxy local dev server |
| ALL | `/api/dev-proxy/:port` | Yes | Root redirect for dev proxy |
| GET | `/api/dev-proxy-ws/:port` | Yes | WebSocket proxy for dev server |

Preview subdomain routing:
- `preview-{port}.conordart.com` is handled by host-based proxy routes.
- Requests and websockets are forwarded to `localhost:{port}`.

## Files + Projects

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/files/list` | Yes | List directory contents |
| POST | `/api/files/mkdir` | Yes | Create directory |
| POST | `/api/files/upload` | Yes | Upload files |
| GET | `/api/files/download` | Yes | Download file or zip directory |
| DELETE | `/api/files/delete` | Yes | Delete file/folder |
| POST | `/api/files/rename` | Yes | Rename/move |
| POST | `/api/files/unzip` | Yes | Extract zip file |
| POST | `/api/files/screenshot` | Yes | Upload screenshot for terminal paste |
| GET | `/api/fs/list` | Yes | List folders (project selection) |
| GET | `/api/fs/download` | Yes | Zip and download directory |
| GET | `/api/projects/scan` | Yes | Scan for git repos |
| GET | `/api/projects/scan-dirs` | Yes | List custom scan dirs |
| POST | `/api/projects/scan-dirs` | Yes | Add scan dir |
| DELETE | `/api/projects/scan-dirs` | Yes | Remove scan dir |

## Processes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/processes` | Yes | Repo status + running ports |
| POST | `/api/processes/start` | Yes | Start repo process |
| POST | `/api/processes/stop` | Yes | Stop process by PID |
| GET | `/api/preview/:port/process-logs` | Public | Logs for port |
| GET | `/api/process-logs/:pid` | Public | Logs for PID |
| GET | `/api/process-logs` | Public | List tracked processes |
| DELETE | `/api/process-logs/:pid` | Public | Clear logs |

## Browser Automation (Public)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/browser/start` | Public | Start Playwright session |
| DELETE | `/api/browser/stop` | Public | Stop session |
| GET | `/api/browser/status` | Public | Session status |
| POST | `/api/browser/goto` | Public | Navigate to URL |
| POST | `/api/browser/back` | Public | Go back |
| POST | `/api/browser/forward` | Public | Go forward |
| POST | `/api/browser/reload` | Public | Reload |
| POST | `/api/browser/click` | Public | Click selector |
| POST | `/api/browser/type` | Public | Type text |
| POST | `/api/browser/fill` | Public | Fill input |
| POST | `/api/browser/select` | Public | Select option |
| POST | `/api/browser/scroll` | Public | Scroll |
| POST | `/api/browser/hover` | Public | Hover |
| GET | `/api/browser/screenshot` | Public | Screenshot |
| GET | `/api/browser/logs` | Public | Console/network logs |
| GET | `/api/browser/html` | Public | Page HTML |
| POST | `/api/browser/evaluate` | Public | Evaluate JS |
| POST | `/api/browser/query` | Public | Query selector |
| POST | `/api/browser/wait` | Public | Wait for selector/timeout |

## Settings + Transcribe

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/settings` | Yes | User settings (masked) |
| PATCH | `/api/settings` | Yes | Update Groq API key |
| GET | `/api/transcribe/health` | Yes | Validate Groq key |
| POST | `/api/transcribe` | Yes | Send audio for transcription |

## System

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Health check |
| POST | `/api/system/rebuild` | Yes | Run `rebuild.sh` |
| GET | `/api/system/stats` | Yes | CPU and RAM stats |
| GET | `/api/system/stats/history` | Yes | Stats history (range: `1h`, `6h`, `24h`, `7d`, `30d`) |
| GET | `/api/latency/ws` | Yes | WebSocket ping/pong for RTT diagnostics |

## Bookmarks

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/bookmarks` | Yes | List bookmarks |
| POST | `/api/bookmarks` | Yes | Create bookmark |
| PUT | `/api/bookmarks/:id` | Yes | Update bookmark |
| DELETE | `/api/bookmarks/:id` | Yes | Delete bookmark |

## Notes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/notes` | Yes | List notes |
| POST | `/api/notes` | Yes | Create note |
| PUT | `/api/notes/:id` | Yes | Update note |
| DELETE | `/api/notes/:id` | Yes | Delete note |
