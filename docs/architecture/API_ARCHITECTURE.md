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
| POST | `/api/auth/logout` | Yes | Invalidate the owner's local refresh, access and preview credentials |
| GET | `/api/auth/me` | Yes | Current user info |
| POST | `/api/auth/register` | Public | Disabled (always 403) |

Logout atomically advances an owner-specific credential generation and removes
that owner's refresh tokens in the local database before waiting for session
cleanup. The cleanup worker continues if the HTTP caller disconnects after
revocation; an abrupt server exit can still interrupt it. New servers sharing the same
database reject older local access, preview and preview-resource credentials;
a subsequent login receives the current generation. Paired-environment grants
are separate credentials and are not unpaired by local logout. Legacy servers
do not enforce this generation or the new owner holds; stop all older servers
before using a shared data directory with the new runtime.

On Unix, logout commits a durable owner cleanup hold in the credential-revocation
transaction. Cooperating processes reject new structured admissions for that
owner until the session owner and delegation supervisor acknowledge cleanup;
an installed background ledger also needs a matching quiescence receipt. A later
logout replaces the request identity, so an older receipt cannot release it.
Logout returns `202` with `cleanup.state: "pending"` if the hold remains, or
`200` with `cleanup.state: "complete"` when cleanup has finished. Credentials
have already been revoked in either case. The owner can sign back in to inspect
cleanup; paired-environment grants remain separate.

On Unix, authenticated owners can read `GET /api/structured/owner-cleanup` and
request another reconciliation pass with `POST /api/structured/owner-cleanup/retry`.
The status identifies pending, unavailable, and unconfirmed resources. The
owner can list unconfirmed children using `GET
/api/structured/owner-cleanup/delegation-children`, attest to stopping a child
using `POST /api/structured/owner-cleanup/delegation-review`, and retrieve an
exact receipt using `GET
/api/structured/owner-cleanup/delegation-review/{operation}`. Background review
uses `POST /api/structured/owner-cleanup/background-review`. Both actions
require an explicit acknowledgment, the current cleanup request and a stable
operation ID. Their `user_attested` provenance records the owner's confirmation,
not a server verification that operating-system processes stopped. Reviewed
background outcomes remain unknown; reviewed delegated tasks are marked
interrupted. Neither review replays work. Existing background
receipts contain no recoverable command or PID, so an owner who cannot verify
that all associated processes stopped must leave the hold in place.

Missing or changed control storage fails closed and can require restoration or
manual recovery. A missing installation marker also fails closed when its ledger
directory or guard remains; loss of every installation artifact cannot be
distinguished from a never-installed system. Background shell commands remain
disabled while their authenticated execution lifecycle is being integrated.
On the first installation, startup fails if the delegation supervisor cannot be
provisioned; it does not commit a cleanup marker that would prevent a later
retry. Once installed, a missing outbox is never recreated automatically.
Authenticated event streams recheck their credential periodically and before
forwarding a chunk; a revoked credential closes the stream.

## Terminal Sessions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/terminal` | Yes | List terminal sessions (active + persisted) |
| POST | `/api/terminal` | Yes | Create session; returned `session.cwd` identifies the resolved directory |
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
- Creation returns the server-resolved `session.cwd` so clients group the new terminal under its canonical directory rather than a requested symlink alias. Clients retain their requested-path fallback when an older server omits it or the session retires during the lookup.

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
| GET | `/api/preview/:port/storage` | Yes | 501: server has no browser-storage snapshot delivery channel |
| POST | `/api/preview/:port/storage` | Yes | Mutate server cookie jar; local/session storage returns 501 |
| POST | `/api/preview/:port/evaluate` | Yes | 501: server does not execute or queue preview JavaScript |
| POST | `/api/preview/:port/client-operation` | Yes | Authorize and validate a client-dispatched storage/evaluation operation; does not execute it |
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

Browser local/session storage and console evaluation use the loaded preview
iframe's message channel. Before dispatch, the application calls `client-operation`
with either `{ "kind": "evaluate", "expression": "..." }` or
`{ "kind": "storage", "storage": { "type": "localStorage", "operation": "set", "key": "...", "value": "..." } }`.
Its response is `{ "authorized": true, "executed": false, "delivery": "preview-client" }`;
it is permission/validation evidence, not an execution receipt or queue admission.
Evaluation preflight requires `PREVIEW_EVAL_ENABLED=true`. The caller rechecks the
active document before dispatch. Unsupported iframe storage remains unavailable.
The injected controller accepts its actual parent only at the origin bound in
the signed resource grant, while that grant remains valid. The serving server's
evaluation opt-in is checked independently. A missing controller binding leaves
the preview read-only to application-issued storage and evaluation commands.
Server-only snapshot/evaluation requests and local/session-storage writes return
501 instead of claiming an operation was queued. Cookies continue through the
real server cookie jar endpoints. Paired preflight requires `agentExecute`.

## Files + Projects

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/files/list` | Yes | List directory contents |
| POST | `/api/files/mkdir` | Yes | Create directory |
| POST | `/api/files/upload` | Yes | Upload files |
| GET | `/api/files/download` | Yes | Download file or zip directory |
| DELETE | `/api/files/delete` | Yes | Delete file/folder |
| POST | `/api/files/rename` | Yes | Rename/move an entry without replacing a destination |
| POST | `/api/files/unzip` | Yes | Extract zip file |
| POST | `/api/files/screenshot` | Yes | Upload screenshot for terminal paste |
| POST | `/api/files/attachment` | Yes | Upload any file (≤25 MB) for an agent message; returns its absolute path |
| GET | `/api/fs/list` | Yes | List folders (project selection) |
| GET | `/api/fs/download` | Yes | Zip and download directory |
| GET | `/api/projects/scan` | Yes | Scan for git repos |
| GET | `/api/projects/scan-dirs` | Yes | List custom scan dirs |
| POST | `/api/projects/scan-dirs` | Yes | Add scan dir |
| DELETE | `/api/projects/scan-dirs` | Yes | Remove scan dir |

File rename accepts `{ "from": "...", "to": "..." }` (legacy aliases
`oldPath`/`newPath` remain accepted). Success is empty HTTP 204. A different
existing destination, including a directory or dangling symbolic link, returns
HTTP 409 with an editable-name error. The destination's absence in a directory
listing is not an overwrite guarantee; the filesystem operation atomically
refuses replacement. Renaming a source symbolic link moves that directory entry,
not its referent. Both parent directories must remain within allowed file roots.

The implementation uses macOS `renamex_np(RENAME_EXCL)`, Linux
`renameat2(RENAME_NOREPLACE)`, and Windows `MoveFileExW` without replacement or
copy-across-volume flags. Unsupported kernels/filesystems and cross-volume moves
fail without falling back to check-then-rename or copy/delete. Platform behavior
references: [Apple exclusive rename capability](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsexclusiverenaming),
[Linux rename flags](https://www.man7.org/linux/man-pages/man2/renameat.2.html),
[Windows MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

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
| GET | /api/workspace/git/status?path=&mode=&base=&checkpointId=&from=&to= | Changed files and review scope (`mode=turn` compares two turn snapshot trees) |
| GET | /api/workspace/git/diff?path=&mode=&base=&file=&checkpointId=&from=&to= | Bounded text/binary diff preview |
| GET, POST | /api/workspace/git/worktrees | List/create managed isolated checkouts |
| POST | /api/workspace/git/worktrees/archive | Save archive checkpoint and retain checkout |
| POST | /api/workspace/git/worktrees/reactivate | Reactivate retained checkout |
| GET, POST | /api/workspace/git/checkpoints | List/capture file checkpoints |
| POST | /api/workspace/git/checkpoints/restore | Guarded managed-checkout file restore |
| POST | /api/workspace/git/branches | Current branch for up to 64 workspace paths |
| GET | /api/workspace/git/branches?path= | Up to 200 fully qualified local and remote branch refs for a selected workspace; includes a truncation flag |
| POST | /api/workspace/git/commit | Stage all changes and commit (`{path, message, push?}`) |
| POST | /api/workspace/git/push | Push the current branch, setting upstream on first push |
| POST | /api/workspace/git/pull-request | Push and open a pull request with the GitHub CLI |
| GET | /api/structured/sessions/{id}/turn-changes | Files each finished turn changed, with snapshot trees |
| POST | /api/structured/start-requests | Claim a UUID and create one empty structured conversation; Unix only |
| GET | /api/structured/start-requests/{requestId} | Recover an owner-scoped creation receipt without replaying creation |
| GET | /api/structured/ownership | Inspect the authenticated owner's structured-session ownership state; Unix only, 404 unless the ownership guard is enabled |
| POST | /api/structured/ownership/reconcile | Acknowledge one unconfirmed ownership epoch after reviewing prior processes; Unix server runtime only |
| GET | /api/system/editors | Desktop editors installed on the host (Cursor, VS Code, Zed) |
| GET | /api/system/doctor | Setup check: Git, Claude Code, Codex, GitHub CLI and data folder, each with a fix |
| GET | /api/workspace/files?path=&query= | Project files matching an `@` mention (git ls-files, or a bounded walk) |
| GET | /api/workspace/files/search-content?sessionId=&query= | Bounded text search rooted at the authenticated owner's session workspace; paired environments require file-transfer permission |
| GET | /api/workspace/files/read-content?sessionId=&root=&path=&line=&query= | Read up to 15 lines around a selected search result in the authenticated owner's unchanged session workspace. Unix only; files are bounded to 256 KiB, paths do not follow symlinks and paired environments require file-transfer permission. The response is not cached. |
| GET, PUT | /api/workspace/scripts?path= | Saved project scripts `{scripts: [{name, command}]}` (≤20) |
| GET | /api/workspace/git/pull-request?path= | Pull request for the current branch with check counts and review decision (GitHub CLI) |
| GET | /api/structured/usage | Tokens and cost per agent conversation, from reported usage |
| PATCH | /api/structured/sessions/{id}/access | Set `{mode}`: supervised, auto-edit or full; applies from the next turn |
| GET, PUT, PATCH, DELETE | /api/messaging/telegram | Telegram gateway: status, connect `{token}`, `{enabled?, newPairingCode?}`, disconnect |
| POST | /api/system/open-in-editor | Open an existing folder in an installed editor |
| GET | /api/workspace/history?q=&path=&limit= | Search saved owned message bodies |
| GET | /api/workspace/native-history/sources?path= | Discover workspace-matching native transcripts |
| POST | /api/workspace/native-history/import?path= | Import selected opaque sourceId as an owned snapshot |
| GET | /api/workspace/native-history/imports?path= | List imported snapshots |
| GET | /api/workspace/native-history/imports/{id}?path= | Read an imported snapshot for handoff |
| GET, POST | /api/workspace/tasks | List workspace tasks/schedules or enqueue intent |
| DELETE | /api/workspace/tasks/{id} | Remove a finished task result |
| POST | /api/workspace/tasks/{id}/cancel | Request cancellation of queued/running work |
| GET | /api/workspace/schedules/capabilities | Advertise advanced timing protocol version (authenticated, no side effects) |
| POST | /api/workspace/schedules | Save a recurring schedule: an interval, or `at: {hour, minute, weekdays, utcOffsetMinutes}` |
| PATCH, DELETE | /api/workspace/schedules/{id} | Enable/pause or remove a schedule |
| POST | /api/workspace/schedules/{id}/run | Explicitly enqueue one schedule run |

Git GET routes take path in the query; create/lifecycle/restore bodies contain
path and their operation fields. Worktree creation accepts an optional UUID
`operationId`: a matching retry returns the confirmed available checkout, while
an unresolved attempt returns 409 and is listed with `creationStatus` set to
`unconfirmed`. Requests without an ID are not retry-safe. The newer field is not
accepted by older servers, and older workers do not honor the creation lock.
Creation currently requires Unix and assumes a stable, private local data
directory with intact records. Task listing accepts an optional path filter
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

Native Codex conversations use the existing structured-session routes. Create
with `provider: "codex"`, `cwd`, and optional `model`, `reasoning`, `title`;
responses identify `runtime: "codex"`. Omitting model/reasoning preserves native
Codex defaults. POST `/api/structured/sessions/{id}/input` with `text`,
`fallbackToMessage: true`, and a UUID `requestId` returns a durable acceptance
receipt. GET `.../requests/{requestId}` recovers the same receipt after uncertain
delivery. Reusing an accepted UUID with different text is rejected.

The opt-in structured start-request route accepts a UUID `requestId` and the
same `cwd`, `provider`, `model`, `reasoning`, `serviceTier` and `title` fields
as session creation. It binds the owner, request ID and normalized selection
before creating a session. Responses include `requestId` and the canonical
`selection` (`cwd`, `provider`, `model`, `reasoning`, `serviceTier`, `title`).
A successful response has `status: "created"` and a `sessionId`; GET of that
session checks its current availability. An unfinished
request returns HTTP 202 and `status: "pending"` and is never automatically
replayed. Reusing a request ID with different normalized input returns 409.
Created receipts are retained after session deletion, so a receipt proves a
creation occurred, not that its session still exists. SQLite must use a durable
journal and full synchronous mode. This at-most-once behavior assumes intact
local data and the retained `terminal.db` table: database rollback, replacement,
table deletion or a restored older backup can erase receipts. It does not fence
older server binaries or solve cross-process structured-session ownership.

The Unix API server binds structured-session ownership before accepting
requests. Ownership is per account and data directory; a competing cooperating
server cannot manage the same account's sessions. Clean shutdown retains the
lease until session cleanup completes. After an unclean stop, recovery requires
review of the previous processes before a new server acquires that account.
Windows retains its existing behavior. Embedded callers using `AppState::new`
do not implicitly enable this server-runtime guard.

Structured ownership recovery reports `owned`, `busy`, `clean`,
`notProvisioned`, or `unconfirmed` with an epoch. The authenticated owner may
submit `{epoch, operationId, acknowledged: true}` to review that exact
unconfirmed epoch. The server records a durable `cleanup_unconfirmed` audit
before permitting a later acquisition; it does **not** verify that older
processes stopped or replay interrupted work. The same operation is retryable;
stale epochs, different owners and a live holder cannot clear the record. These
endpoints are private, not cached, and are unavailable through paired remote
environment proxies. Their guarantees require intact local lease and SQLite
storage and cooperating server versions. Older binaries do not honor the lease:
stop and verify termination of all older servers before starting this version
with the same data directory, and prevent them from restarting alongside it.

POST `.../approve` requires the displayed `approvalId` and `approved`; it returns
the matching decision receipt. POST `.../interrupt` returns `status: "cancelled"`
and `cleanupConfirmed: true` only after cleanup. Events use the same authenticated
WebSocket and saved sequence numbers as other structured providers. Native Codex
does not expose V4 image, compaction or follow-up queue endpoints.

On Unix, external HTTP and WebSocket Stop requests bind the owner and captured
process generation, then revalidate the local credential or paired grant at
admission. A V4 turn is signalled before waiting for lifecycle cleanup; if its
launch admission is busy, Stop returns an error and can be retried. For native
providers, the captured generation is marked retiring inside the authorization
fence after the lifecycle wait; a later logout does not undo an already admitted
Stop, and its asynchronous provider cleanup can finish afterward. Failed or
unconfirmed cleanup is not reported as a confirmed Stop. These guarantees require
cooperating current Unix servers; non-Unix behavior has not been verified.

POST `/api/structured/sessions/{id}/approve` accepts `{approved, approvalId, answers?, forSession?}`. `answers` maps an agent question's ids to lists of answer text; `forSession` approves this kind of action for the rest of the conversation (Codex `acceptForSession`, or the Claude tool name).

PATCH `/api/structured/sessions/{id}/selection` accepts `{model, reasoning, serviceTier?}`
for an owned, idle Codex session and returns its complete snapshot. It validates
the model and effort, persists before changing memory, and preserves events and
the native thread ID. Invalid values return 400, missing/other-owner sessions
404, and active/retiring or unsupported runtimes 409. The next native resume uses
the saved selection, with explicit effort and service tier also sent on `turn/start`.
`serviceTier` accepts `default`, `fast` or `ultrafast`; omission preserves the saved
tier and explicit null clears the override to native settings. Create accepts the
same optional tier, and old snapshots with no tier remain compatible. The frontend invalidates older inventory requests after a
successful update so a stale response cannot revert the displayed selection.

The sidebar uses GET `/api/structured/sessions?view=inventory`. It returns owned
session metadata (title, workspace, provider/model/reasoning, thread, timestamps,
runtime and status) with explicit `latestSeq` and `statusSeq`, without `events`.
The sequence watermarks keep delayed inventory polls from replacing newer stream
or cleanup state. The no-query list and GET `.../sessions/{id}` retain complete
snapshots; authenticated WebSocket history/replay is unchanged. An unknown
nonempty `view` returns 400. Frontend mapping also accepts legacy full snapshots.

Structured thread PATCH accepts `snoozeForSeconds` (60–2,592,000) or
`wakeSnooze: true`, never both. A successful response includes
`threadLifecycleVersion: 1`; clients must check that marker before treating the
operation as supported. Snooze is refused while a structured or native browser
request or recovery needs attention. Inventory adds `threadLifecycle` with
`supported`, `snoozed`, `requiresAttention` and an optional `snoozedUntilMs`.
The deadline and event sequence are stored with the thread; a later structured
request or failure makes the snooze ineffective. A registered native browser
request clears the snooze before it can execute. Native browser pending state is
process-local, and cooperating current Unix servers use the owner lease described
above; older or unfenced writers and non-Unix do not have that guarantee.

For title `PATCH .../sessions/{id}` and `PATCH .../sessions/{id}/thread`, local
credentials are revalidated under the Unix authentication fence immediately
before the session snapshot is published;
paired requests hold the owner input guard and recheck grant expiry at that point.
Paired requests return a retryable conflict rather than waiting on occupied session
or queue locks while holding the owner guard. If the snapshot was published but
the local authentication transaction cannot be confirmed, the endpoint returns
503 and asks the client to reload before retrying. Internal browser-request wakeups
use a separate trusted path. Filesystem writes and synchronization can still stall
local authentication or paired revocation while these fences are held. Non-Unix
uses final best-effort checks without the Unix cross-process fence. Title updates
retain a separate trusted manager path for internal callers. Structured list/get
routes still require an audit of credentials that expire or are revoked while
those requests wait, including their lazy recovery side effects.

For structured title changes, the web client records an attempt in same-tab
session storage before sending it. Non-success responses and success responses
that do not confirm the requested session and title remain uncertain. After an
uncertain response or reload, the client refreshes the title without using the
HTTP cache and requires one matching raw inventory entry with a nonempty string
title before asking for review. The earlier request may
still finish after that refresh; this
marker does not coordinate other tabs or provide a cross-tab revision check.
If the marker cannot be read or written, the client does not send the change.
The structured title route limits the UTF-8 encoding to 80 bytes; the client
checks that limit and a 60 Unicode-code-point UI limit before sending, and
retains the entered text on failure. It rejects malformed Unicode rather than
cutting a character when a title is too long.

For loopback testing, GET `/api/auth/mode` returns `{ "mode": "local-testing" }`
only when `TERMINAL_V4_LOCAL_TESTING=1` is enabled with local account storage;
otherwise it returns `{ "mode": "password" }`. POST `/api/auth/local-testing`
accepts `{ "username": "tester" }` and returns the standard user/token response.
It normalizes the name and creates or reopens only a dedicated testing account.
The endpoint requires the app's local Host and same Origin when Origin is sent.
Disabled mode returns 404, invalid names 400 and invalid origin 403. Testing
profiles use reserved internal usernames, while responses and tokens retain the
chosen display name. A same-name password account remains a separate identity;
existing earlier-format testing profiles retain their original IDs. An invalid
internal testing-profile binding returns 409. Authenticated routes retain token checks.
State-aware direct, delegated, preview and WebSocket validation rejects testing
identities after the mode is disabled; password accounts retain their normal flow.

See [Workspace feature guide](../features/HERMES_T3_WORKSPACE.md) for storage,
limits, recovery behavior, and [V4 runtime](../features/V4_RUNTIME.md)
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

The exact structured-session GET/HEAD paths `/:id/requests/:requestId`,
`/:id/context`, `/:id/queue`, and `/:id/queue/operations/:operationId` require
`agentExecute` (included in Operator). Observer and file/transfer-only grants
cannot read them. Target-session ownership and grant expiry/revocation remain
enforced at the destination. These exceptions do not expose attachments,
provider connections, vault data, grant administration, or new mutation routes.

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

## Corrected feature contracts

- Vault requests and responses use `keyName`/`keyValue`; Unicode masking counts
  characters. System stats use the Rust `stats` envelope and camelCase fields.
- Transcription health returns `available`; uploads use multipart `file`. The
  authenticated owner's saved Groq key precedes the environment fallback, and an
  explicit provider selection is honored. Health never returns the credential.
- Preview cookie edits mutate the owned server jar; browser storage isolation
  remains enforced. Static query previews rewrite dependent asset URLs while
  preserving authentication and paired-host route scope. Opaque sandbox asset
  requests carry read-only resource credentials limited to the preview port or
  exact static endpoint and selected directory. They expire within fifteen
  minutes and never outlive the parent credential,
  cannot authorize mutations or sockets, and are stripped before upstream
  forwarding. Paired requests still check ownership, capability and revocation.
  Initial iframe, picture-in-picture and new-tab navigation obtains a fresh
  credential from owner-authenticated `POST /api/preview/resource-auth`; no account
  token is placed in the document URL. External proxy credentials bind the exact
  target URL; paired external proxies remain unsupported. Preview responses apply
  CSP sandboxing without same-origin privileges, including top-level documents.
  Expiry leaves the current Preview document mounted so unsaved page state is
  preserved. The UI reports unavailable privileged controls and later resource
  loads; explicit Reload/Retry obtains fresh authority and may reset that page.
- Native structured Claude user messages are persisted and broadcast before
  dispatch, tool results retain IDs, and continuation uses the exact native
  session. Metadata writes serialize against retirement/deletion.
- `POST /api/system/rebuild` resolves documented project/script overrides, runs in
  that project directory and returns build output; it does not restart services.

### Relay message limits and structured history recovery

Host registration negotiates `x-terminal-v4-relay-fragments: 1` through request and response headers. Complete serialized WebSocket messages are limited to 8 MiB when acknowledged, or 64 KiB otherwise; payload frames remain at most 64 KiB plus the 17-byte relay header. Continuation kinds 4/5 terminate with original text/binary kinds 2/3. Kind 6 carries the bounded size-limit diagnostic; the broker emits close code 1009 and the paired WebSocket proxy forwards its code and reason. No control-JSON schema fields or authentication rules change. Upgrade proxies must preserve negotiation headers.

On 1009 the structured hook stops reconnecting and issues one GET of `/api/structured/sessions/{id}` through its captured authenticated environment. It reads at most 20 MiB of decoded bytes, validates at most 32,768 ordered canonical events, and aborts after 15 seconds or scope retirement. Valid history replaces partial replay once; recovery never issues input or approval mutations. The conversation shows a history-only notice or a bounded recovery error. This does not increase relay limits or add automatic polling. Legacy broker releases without diagnostic closes require an upgrade.

Tunnel upgrades separately acknowledge `x-terminal-v4-tcp-half-close: 1`; only negotiated peers interpret an empty binary frame as write EOF. Relay headers carry this acknowledgement end to end. Completed-download receipts are idempotent for a matching checksum, and owned completed snapshots remain readable until explicit record removal, counting against the existing per-account 512 MiB data quota.

### Interactive workspace browser

The human session and approval routes under `/api/workspace-browser/*` require
normal application authentication, are account-scoped, and use private/no-store
caching. The MCP endpoint uses a separate capability described below. These routes
run on the home API; paired-host grants do not expose them.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/workspace-browser/sessions` | Start or resume the account's browser; return `{id,state}` |
| GET | `/api/workspace-browser/sessions/{id}` | Read tabs, active tab and dialog metadata |
| POST | `/api/workspace-browser/sessions/{id}/command` | Navigate, history, reload, tabs, viewport resize, pointer, wheel, key, text or dialog action |
| GET | `/api/workspace-browser/sessions/{id}/frame` | Current JPEG as base64, viewport dimensions and tab state; blank/dialog pages can return a null image |
| DELETE | `/api/workspace-browser/sessions/{id}` | Close the owned browser and confirm cleanup before returning 204 |
| GET | `/api/workspace-browser/approvals` | List this account's pending native MCP browser action requests: `{requests:[{id,label,name,arguments}]}` |
| POST | `/api/workspace-browser/approvals/{id}` | Decide one request with `{approved:boolean}`; return 204, or 404 for an unowned/expired request |
| GET / PUT | `/api/agent/browser` | Read/save account agent-browser enablement, exact `allowedOrigins`, and standalone configuration |

The session is shared by the human pane, native Codex/Claude and in-app V4 across
workspaces for one account/data directory. The API uses bundled Node 22.23.1,
Playwright 1.64.1 and Chromium revision 1248; runtime resolution never uses installed
Chrome or a shared cache. Missing/invalid bundles return install/repair errors.
The headless viewport remains visible through authenticated frames on remote
connections. Preview screenshot/recording endpoints are a separate runtime path.

State/frame responses include tabs with `documentId`, active tab, dialog and
`control:{owner:"unclaimed"|"human"|"agent",label?:string}`; state also reports
the managed Chromium engine/version. A command `{type:"control",owner:"human"}`
takes control, cancels pending native browser actions and invalidates stale queued
operations. `{type:"control",owner:"agents"}` allows fresh agent requests. Ordinary
human input while an agent owns control returns 423; frame/state/resize reads
remain available. Agent mutations are denied during human control, while fresh
approved reads of allowed pages remain possible without switching the active tab.

`POST /api/workspace-browser/mcp` is a separate MCP JSON-RPC endpoint authenticated
by an app-issued bearer capability, not an application login token. Leases are
scoped to account/data directory/agent label, expire after 12 hours and revoke
when the last connection owner is dropped. Initialize/list operations never launch
a browser. Each native `tools/call` requires a separate pane decision within 60
seconds, except `browser_release_control`. The pending request binds exact tool
arguments and captures settings/session/tab/document/control identity as
applicable; changed settings or stale targets fail and require fresh approval.
Cancellation and revoked leases also stop approved operations still queued for
the helper. At most 16 active/pending native actions per account are admitted.

Codex retains its own native tool approvals in addition to this endpoint's gate.
Claude print mode explicitly allow-lists only the browser MCP transport tools;
ordinary native tools remain subject to native permissions, and generic chat
confirmation cannot grant an exact native tool action. In-app V4 calls the shared
browser through its own exact-action conversation approvals, not this MCP/pane
approval route; unattended browser access is denied. Shared failures never select
a standalone fallback. Configured external MCP clients in `v4_agent/mcp.rs` are
separate from this app-owned native-browser MCP server.

`allowedOrigins` controls agent page/resource access, including exact ports;
human navigation is independent. Settings/action approvals do not constitute
email consent: the agent must obtain explicit permission for the task's address
and scope, plus the exact email address, before reading email or metadata. This
is a policy requirement, not a content detector. See
[V4 agent browser tools](../features/V4_AGENT_BROWSER.md) for configuration,
network-policy bounds, cleanup and standalone limits.

Missing or unowned session IDs return 404. Command bodies are limited to 100 KB,
helper responses to 8 MB, browser viewports to 320–1920 by 240–1200, and helper
calls to 30 seconds. Only HTTP/HTTPS navigation without embedded credentials is
accepted for human navigation. No endpoint exposes a debugger URL or host browser
profile. The human command endpoint rejects arbitrary JavaScript; the separate
agent `browser_evaluate` tool requires exact approval and origin checks. Agent
tools may also use `about:blank`. The client can restart an expired session after
a 404.
