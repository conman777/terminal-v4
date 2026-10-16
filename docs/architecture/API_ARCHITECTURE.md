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
| GET | `/api/terminal` | Yes | List terminal sessions (active + persisted) |
| POST | `/api/terminal` | Yes | Create session |
| GET | `/api/terminal/:id/history` | Yes | History snapshot |
| GET | `/api/terminal/:id/project-info` | Yes | Project info from cwd |
| POST | `/api/terminal/:id/input` | Yes | Send input (HTTP fallback) |
| POST | `/api/terminal/:id/resize` | Yes | Resize PTY (optional `clientId`) |
| PATCH | `/api/terminal/:id` | Yes | Rename session |
| DELETE | `/api/terminal/:id` | Yes | Close owned session (404 if not found or not owned) |
| POST | `/api/terminal/:id/restore` | Yes | Restore persisted session |
| GET | `/api/terminal/:id/stream` | Yes | SSE stream of output |
| GET | `/api/terminal/:id/ws` | Yes | WebSocket for IO |

WebSocket notes:
- The first frame is JSON: `{ type: "clientId", clientId: "..." }`.
- Subsequent frames are raw terminal output/input (string data).

Session state notes:
- `GET /api/terminal` and `GET /api/state` load per-user sessions and attempt tmux reattach so live processes are surfaced as `isActive: true`.
- Session summaries include `isActive` and `isBusy` to drive terminal tab status coloring.

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
- `preview-{port}.{PREVIEW_SUBDOMAIN_BASE}` (or `.localhost` in local dev) is handled by host-based proxy routes.
- Requests and websockets are forwarded to loopback hosts (e.g. `localhost:{port}`).
Path-based preview routing:
- `/preview/:port/*` is handled by the same proxy logic (HTTP + WebSocket).
- Used for localhost/same-host private targets. Different private LAN hosts are kept as direct URLs.

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

## Browser Automation (Status)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| N/A | `/api/browser/*` | N/A | Not currently exposed by registered backend routes |

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
| POST | `/api/system/rebuild` | Yes | Run `rebuild.sh` with output capture |
| GET | `/api/system/stats` | Yes | CPU, RAM, disk I/O, event loop, and top processes |
| GET | `/api/system/stats/history` | Yes | Historical stats (range: `1h`, `6h`, `24h`, `7d`, `30d`) |
| GET | `/api/latency/ws` | Yes | WebSocket ping/pong for RTT diagnostics |

## Screenshots & Recording

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/preview/:port/screenshot` | Yes | Take full page or viewport screenshot |
| POST | `/api/preview/:port/screenshot/element` | Yes | Screenshot specific element by selector |
| POST | `/api/preview/:port/recording/start` | Yes | Start video recording of preview |
| POST | `/api/preview/recording/:recordingId/stop` | Yes | Stop recording and save video |
| GET | `/api/preview/screenshots` | Yes | List all screenshots |
| GET | `/api/preview/screenshots/:filename` | Yes | Retrieve screenshot image |
| DELETE | `/api/preview/screenshots/:filename` | Yes | Delete screenshot |

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

## Workspace profiles

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/workspace/profile?path=<absolute-directory>` | Yes | Load saved knowledge, skills, and task defaults |
| PUT | `/api/workspace/profile?path=<absolute-directory>` | Yes | Validate and atomically replace the user's workspace profile |

Both endpoints return the JSON profile directly with private, no-store caching.
Profiles are scoped by authenticated user and canonical directory. Invalid
directories or profile values return 400; unreadable or corrupt storage returns
500. Unknown JSON fields are rejected. See
[Workspace feature guide](../features/HERMES_T3_WORKSPACE.md) for fields and limits.


## Workspace review, tasks, and history

All routes below require the current app identity. Directory query/body values
must be absolute existing workspace directories. Stored records are scoped by
authenticated owner; malformed IDs and unsupported operations are rejected.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/agent/catalog | Host launchers, models, availability and explicit capabilities |
| GET | /api/agent/auth | Credential configuration and masked status |
| PUT, DELETE | /api/agent/auth/{provider}/api-key | Save/remove an owner-scoped encrypted API key |
| GET, POST | /api/workspace/proposals?path= | List/stage bounded learning updates |
| POST | /api/workspace/proposals/{id}/accept?path= | Atomically apply a reviewed update and receipt |
| POST | /api/workspace/proposals/{id}/reject?path= | Reject a pending update |
| GET | /api/workspace/skills?path= | Discover bounded installed skill instruction text |
| GET | /api/workspace/git/status?path=&mode=&base=&checkpointId= | Changed files and review scope |
| GET | /api/workspace/git/diff?path=&mode=&base=&file=&checkpointId= | Bounded text/binary diff preview |
| GET, POST | /api/workspace/git/worktrees | List/create managed isolated checkouts |
| POST | /api/workspace/git/worktrees/archive | Save archive checkpoint and retain checkout |
| POST | /api/workspace/git/worktrees/reactivate | Reactivate retained checkout |
| GET, POST | /api/workspace/git/checkpoints | List/capture file checkpoints |
| POST | /api/workspace/git/checkpoints/restore | Guarded managed-checkout file restore |
| GET | /api/workspace/history?q=&path=&limit= | Search saved owned message bodies |
| GET | /api/workspace/native-history/sources?path= | Discover workspace-matching native transcripts |
| POST | /api/workspace/native-history/import?path= | Import selected opaque sourceId as an owned snapshot |
| GET | /api/workspace/native-history/imports?path= | List imported snapshots |
| GET | /api/workspace/native-history/imports/{id}?path= | Read an imported snapshot for handoff |
| GET, POST | /api/workspace/tasks | List workspace tasks/schedules or enqueue intent |
| DELETE | /api/workspace/tasks/{id} | Remove a finished task result |
| POST | /api/workspace/tasks/{id}/cancel | Request cancellation of queued/running work |
| POST | /api/workspace/schedules | Save a recurring interval schedule |
| PATCH, DELETE | /api/workspace/schedules/{id} | Enable/pause or remove a schedule |
| POST | /api/workspace/schedules/{id}/run | Explicitly enqueue one schedule run |

Git GET routes take path in the query; create/lifecycle/restore bodies contain
path and their operation fields. Task listing accepts an optional path filter
and returns tasks plus schedules. Task and schedule inputs contain workspacePath,
provider, prompt, optional model and parent links. Scheduling adds name,
intervalSeconds, and enabled; enabled defaults to false.

Git review mode is unstaged, staged, base, or checkpoint. Filesystem restore is
independent of native conversation state. Native imported transcripts are owned
text snapshots; they cannot grant tools or migrate provider approvals.

Provider credentials are masked in responses and encrypted in api_key_vault.
A native installed runtime can report authentication as unknown. Readiness and
tool execution must follow the returned adapter capabilities rather than the
presence of a provider label. Sensitive workspace/provider responses use
private, no-store caching.

See [Workspace feature guide](../features/HERMES_T3_WORKSPACE.md) for storage,
limits, recovery behavior, and [Hermes runtime](../features/HERMES_RUNTIME.md)
for installation and host configuration.


## Paired environment runtime

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/environments | Owner-scoped outgoing environments and incoming grants; no credentials |
| POST | /api/environments/pairing-code | Create a 120-second one-use code; body label, profile, optional custom capabilities |
| POST | /api/environments/connect | Consume code using url or relayUrl/deviceId, code, label, allowInsecureHttp |
| GET | /api/environments/{id}/status | Check remote grant and reachability |
| DELETE | /api/environments/{id} | Disconnect and attempt destination revocation |
| DELETE | /api/environments/grants/{id} | Revoke incoming access |
| POST | /api/environments/exchange | Destination's one-use code exchange |
| GET | /api/environments/check | Validate a runtime grant |
| POST | /api/environments/release | Release the presented runtime grant |
| ANY | /api/environments/{id}/proxy/{path} | Owner-authenticated allowlisted HTTP, event-stream and WebSocket proxy |

Control routes use the home JWT; exchange/check/release validate their own
pairing credentials. The proxy does not expose a general-purpose destination URL.
It selects an owner-owned stored environment and validates the original runtime
path. Outgoing credentials are encrypted; destination grants retain credential
hashes. Metadata createdAt/expiresAt fields use Unix seconds. Private responses
use no-store caching. Home tokens are removed before destination forwarding.
Account authentication, vault and provider-key mutation routes are excluded from
paired runtime authority. GET provider authentication status is masked.

## Coordinated native conversation rewind

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/workspace/rewind?path= | Native sources and supported turn boundaries, managed state, checkpoints, live sessions and operation journal |
| POST | /api/workspace/rewind/plan | Review immutable native/files intent; body path, sourceId, targetTurnId, checkpointId |
| POST | /api/workspace/rewind/{id}/apply | Capture recovery checkpoint, fork native conversation, restore selected files |
| POST | /api/workspace/rewind/{id}/resume | Create/reopen app terminal for the native branch; returns operation and session |
| POST | /api/workspace/rewind/{id}/recover | Guarded restore of pre-rewind files |
| POST | /api/workspace/rewind/suspend | Stop live app process preserving transcript; body path, sessionId |

All routes require the current owner. Operation bodies contain path; IDs and
canonical workspace ownership are checked against the durable journal. Rewind
requires a managed checkout and an explicit files checkpoint. Native source
fingerprints and provider boundaries are validated before mutation. Active
workspace processes/tasks are gated. A selected turn means immediately before
that user message. Native branching and file restoration are separate steps,
with recorded recovery state when interruption prevents full completion.

See [Paired environments and rewind](../features/PAIRED_ENVIRONMENTS_AND_REWIND.md)
for provider-specific limits and the review/recovery flow.

## Remote workspace extensions

| Method | Path | Authority and purpose |
| --- | --- | --- |
| PATCH | /api/environments/{id} | Owner directory alias, favourite, tags and recent workspace |
| GET | /api/relay/status | Direct home identity, relay setup and connection status |
| WS | /api/relay/hosts/{device}/register | Configured broker registration key and pinned device secret |
| ANY | /api/relay/devices/{device}/{runtimePath} | Bounded paired runtime/pairing transport |
| GET, POST | /api/transfers | Owned transfer inventory and upload intent |
| POST | /api/transfers/download | Download-only intent; transfer permission |
| GET, DELETE | /api/transfers/{id} | Owned progress or cancellation/record removal |
| GET, PUT | /api/transfers/{id}/chunk | Bounded verified download/upload chunks |
| POST | /api/transfers/{id}/complete | Verify and atomically publish upload; file-write permission |
| POST | /api/transfers/{id}/download-complete | Download-only checksum receipt |
| GET, POST | /api/collaboration/invitations | Direct owner invitation/audit administration |
| DELETE | /api/collaboration/invitations/{id} | Direct owner revocation |
| POST | /api/collaboration/guest/exchange | Exchange fragment secret for a restricted guest credential |
| GET, WS | /api/collaboration/guest/{session}/history or ws | Guest-only scoped output/control protocol |
| GET, POST | /api/recordings | Owned captures; explicit capture intent |
| GET, DELETE | /api/recordings/{id} | Replay data or removal |
| POST | /api/recordings/{id}/stop | Stop and flush capture |
| GET | /api/recordings/{id}/export | Versioned, best-effort redacted export |
| GET, POST | /api/tunnels | Direct home owner listener inventory/create |
| DELETE | /api/tunnels/{id} | Direct home owner listener/stream stop |
| WS | /api/tunnels/connect?targetPort= | Explicit tunnel capability; binary TCP target bridge |
| GET | /api/desktop/status | Host platform/opt-in/display capability |
| POST | /api/desktop/sessions | Create owner-scoped viewing session; desktop-view permission |
| DELETE | /api/desktop/sessions/{id} | Stop own viewing session |
| GET | /api/desktop/sessions/{id}/frame | Bounded JPEG; authorization repeated after capture |
| POST | /api/desktop/sessions/{id}/input | Validated native action; desktop-view and control permissions |

The observer/operator/custom profile controls terminalInput, fileWrite,
agentExecute, transfer, recordings, tunnels, desktopView and desktopControl.
Desktop and tunnel access require explicit grants. Custom desktopControl without
desktopView is rejected. Legacy grants migrate to operator without desktop/tunnel
access. Guest credentials cannot authenticate to ordinary account/runtime APIs.
Only full owner access tokens can issue preview cookies; paired/preview tokens
cannot turn into a new unrestricted preview credential. Opaque preview sockets
require terminal input authority.

All feature errors remain explicit; no successful response implies native device
control occurred when host access is disabled or unavailable. See the
[remote workspace guide](../features/REMOTE_WORKSPACE.md) for limits and recovery.
