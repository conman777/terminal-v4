# V4 agent runtime

V4 owns its provider request loop, workspace tools, conversation storage,
in-process structured engine and optional CLI.
Hermes Agent and T3 Code are feature references. Their source and runtimes are not
bundled or required. Optional read-only import of an existing Hermes SQLite
history is implemented in V4's Rust importer and does not run Hermes.

## Starting an agent

Add a provider API key in Settings, choose that provider and a model when opening
a thread. V4 conversations run inside the authenticated API's structured engine,
with durable acceptance receipts, streamed events, approvals and cancellation.
They do not need a shell launcher. The optional CLI and unattended task path use
`terminal-v4-api agent` with provider/model choices and the encoded app-account
identifier. Both paths resolve only that account's encrypted credential from the
local vault. Keys are not arguments, transcript fields, or tool-process
environment variables.

The independent adapters support Anthropic Messages, OpenAI Responses and
OpenAI-compatible Chat Completions. Provider metadata supplies endpoints and model
suggestions; a custom model ID can be entered. Endpoint environment overrides
require HTTPS, except loopback HTTP for local services. Redirects are disabled.
OAuth-only, Bedrock, Vertex, Azure-specific and virtual ensemble transports need
separate adapters and remain unavailable rather than pretending to work.
Reasoning choices come from the exact selected model's metadata. V4 sends the
supported configuration through Responses reasoning fields, Chat reasoning
fields, or Anthropic thinking/effort fields. An empty per-model list means no
reasoning control; an unknown custom model does not gain invented capabilities.
Provider metadata can also select a model's actual transport and endpoint.
Native Claude Code and Codex run as their own conversation adapters, outside
this runtime; Gemini and other CLIs launch in a terminal. See
[Workspace feature guide](HERMES_T3_WORKSPACE.md).

On Unix, direct V4 message acceptance with a local access credential and
account logout share a cross-process admission lock. The server checks the
credential generation and expiry again immediately before publishing the
conversation checkpoint; an accepted request has a durable receipt even if its
response is interrupted. Paired credentials and internal submissions retain
their separate admission paths. This does not yet provide the same fence for
Windows or for queued follow-ups. On Unix, a durable owner cleanup hold now
coordinates logout with cooperating structured-session owners, delegation
supervisors and installed background-ledger owners across API processes. A
running turn is cleaned up by its owner process; the hold remains until the
required cleanup receipts are confirmed or an explicit, scoped owner review is
recorded. A review is the owner's attestation that affected processes stopped,
not a server-verified process termination. Missing control storage or an
unconfirmed process remains visible and can require manual recovery. Mixed old
and new server processes do not share these guarantees and must not operate on
the same data directory.

The default Unix native Claude and Codex paths also check local credential
generation and expiry before accepting a turn and beginning the provider launch.
Their synchronous launch currently runs under the shared authentication fence,
so a stalled provider launch can delay other accounts' authentication operations.
An already-admitted launch is not cancelled merely because its credential
expires while the launch routine is running.

The default-off `supervised-input-preview` feature includes an isolated native
launch experiment. Its fixture-only activation requires loopback local-testing
mode; normal startup leaves it disabled. In that experiment, a per-owner lock
orders launch and logout across cooperating updated processes. The final
credential check immediately before the provider launch routine is the
authorization point. The routine may complete after expiry; this is not a
guarantee that the operating system has created the child before expiry. A
cancelled request does not cancel its owned launch worker, and successful
logout cannot overtake that worker's launch and registration. A stalled launch
can cause same-owner logout to fail or delay shutdown; shutdown waits for owned
workers rather than claiming to stop an uninterruptible launch. The experiment
does not enforce exclusion against older binaries and is not a production
activation or migration mechanism.

Preview activation records its input-admission version in the authentication
database before accepting supervised input. Updated Unix servers, including
default builds with the preview disabled, acquire the same per-owner lock during
logout and check that record under the authentication transaction before
revoking credentials. Installation creates the receipt and lock identity
tables atomically. An older installation is migrated only if its identity
storage remains intact; missing tables require recovery. This does not make a
server built before this protocol cooperate with the owner lock.

Preview clients check both the server capability and the individual session
before using supervised raw input. A recovered legacy session without an
incarnation does not advertise the session capability and continues through
the legacy input path. Clients must resolve any existing supervised operation
before falling back; a missing capability alone does not settle an earlier
operation. If an installed protocol is disabled after a restart, local capability
discovery reports `enabled: false` and receipt discovery and review remain
available. Legacy raw input, including paired input, is held while that session
has an issued, uncertain or unacknowledged delivered operation. Missing receipt
storage fails closed. Explicit terminal keys use `fallbackToMessage: false`;
composer submissions keep their separate message semantics. Local and paired
raw input check credential expiry at the native stdin boundary. On cooperating
Unix servers, paired grant revocation and release share the input owner lock.
Paired message admission prepares native turn snapshots before taking that lock,
then checks the session generation and grant before acceptance and provider
registration. Local and paired approval decisions retain the owner lock until the decision
is resolved; queued Codex decisions retain it after the caller stops waiting.
An admitted write, launch or decision can delay revocation until it finishes.
Older clients that send ambiguous fallback-enabled input do not receive that
distinction.

On Unix, a client can reserve a Codex approval before submitting its decision.
The reservation is journaled and binds the action to a one-time delivery token;
other clients cannot dispatch that reserved approval without it. The token is
not stored in the conversation. Dispatch is journaled before the native packet
is sent, and cannot be repeated using that reservation. If the reserve response
is lost, the visible reservation remains held for review after stopping the
provider. A missing reservation endpoint is not proof that a previous request
was never reserved. Legacy clients can submit without a reservation only while
no reservation or uncertain decision is outstanding.
The authenticated session approval capability reports `reservation` on Unix.
An updated non-Unix server reports `legacy` for a Codex conversation with no
outstanding protected decision; this mode uses the older best-effort decision
path and cannot review an uncertain decision. An outstanding protected decision
reports `recovery_required`, and previously protected approval IDs remain fenced
against replay after settlement.
An older server may return 404 or reject the capability request with 403; neither
response proves that a reservation was never created. Those targets remain
unsupported by the protected client until a trusted compatibility mechanism is
available. Do not overlap or roll back servers against the same data directory.
If delivery is interrupted without a durable resolution, that approval and new
Codex turns remain blocked. Stop the provider, inspect the conversation and
explicitly review the uncertain decision to continue; review does not resend the
approval or assert whether the action occurred. A reviewed approval ID cannot be
replayed. The journal uses new event types, so older server versions may be
unable to read conversations containing these records.

The server creates `auth-admission.lock`, `auth-admission.identity` and an
SQLite identity record on first use. It refuses to reopen an incomplete or
changed finalized installation. A complete pending initialization is resumed
after restart; a damaged pending or temporary marker, or a missing finalized
identity, requires recovery rather than deleting the remaining files. Keep these files and the
database together. Stop old servers before upgrading: older binaries
do not honor this lock. The fence assumes a private, stable local data directory
and cooperating processes; it is not a defense against arbitrary same-user file
replacement. Restoring an older database can revive previously revoked tokens
even when the identity files are intact; the fence does not detect database
rollback. Losing all identity artifacts and the database also cannot be
distinguished from a fresh installation.

## Tools and permissions

V4 implements `list_files`, `read_file`, `search_text`, `write_file`,
`replace_text`, and `run_command`. Paths must stay in the selected
workspace. Symlinks, parent traversal, Git internals and known credential files
are rejected. File reads/writes are bounded to 512 KB, searches to 2,000 entries,
100 matches and eight directory levels. Atomic writes preserve existing mode.
Except for Unix search traversal described below, these path checks assume the
workspace is not concurrently replaced by another process; they do not provide
an OS sandbox or rule out hard links to files elsewhere.
`read_file` accepts optional 1-based `start_line` and `line_count` (up to 2,000)
to return a JSON page with its content, total lines and a `nextLine` continuation.
Without these arguments it returns the full file as before; pagination does not
remove the 512 KB file limit or guarantee a consistent snapshot across calls.
For larger UTF-8 files, `start_byte` and `byte_count` provide a separate,
zero-based byte page of 4–512,000 bytes; use `nextByte` for the next page.
Pages never split a UTF-8 character and reject offsets inside a character.
The reported `fileBytes` is measured when each page is opened; separate pages
are not a locked snapshot. Do not combine byte and line pagination.
`replace_text` defaults to one literal match. An optional `expected_count`
from 1 to 1,000 replaces all matches only when the observed count is exactly
that value. The size limit is checked before creating the replacement. As with
the other file tools, this is not a lock against concurrent workspace changes.

On Unix, `search_text` defaults to case-sensitive literal content search and
also accepts `regex`, `case_sensitive` and `mode` (`content` or `files`). File
mode matches workspace-relative paths. Regex patterns are limited to 256 bytes,
use the regex-lite syntax and use ASCII case folding when case-insensitive;
regex searches skip lines over 16 KiB. Literal case-insensitive searches use
Unicode lowercase. Scans read at most 32 MiB and check a two-second budget
between operations. Results include `truncated` when a bound, an unreadable
entry or a skipped long regex line prevents a complete scan. An open directory
handle anchors each traversal, and symlinks are not followed. This assumes a
stable workspace root on a local filesystem; hard links are ordinary files and
the scan is not an OS sandbox. Search results are snapshots and files may change
before a later read. On non-Unix platforms only the existing default literal
search is supported; supplying the new options returns an error.

V4's `todo_list` lets the agent read, replace or merge a revisioned task list
for the current conversation. Items can refer to a parent and have pending,
in-progress, completed or cancelled status. A list is limited to 256 items,
4,000 characters per description and 48 KB in encoded form; invalid or
cyclic changes leave it unchanged. Updates use the owner, workspace and session
history boundary and are saved before success is reported. Active tasks and
their parents are preserved in the compaction summary. Rewinding into a new
conversation starts with an empty list because earlier task-list snapshots are
not retained. Read-only delegated child mode does not expose this tool.
Older V4 binaries can discard the new field when rewriting a session, so avoid
switching versions against the same live history.

On Unix, `list_schedules` lists schedules linked to the current owner,
conversation and workspace. It returns bounded, redacted prompt excerpts and
does not change or migrate task storage. If the existing storage lock is busy or
its identity cannot be verified, it reports an error rather than creating a
lock or returning a potentially stale list. Schedules created independently of
the conversation are not included. The reader requires the data directory,
task directory, lock and store to be owned by the server user and not writable
by other users or groups. It assumes a stable private local data directory;
path and inode checks do not prevent a same-user replacement race. Older servers do not honor the current
worker locking protocol, so do not run old and new servers against the same
task data. See the [workspace guide](HERMES_T3_WORKSPACE.md) for scheduling and
mixed-version limits.

On Unix, `manage_schedule` can request a pause, resume, immediate run, removal,
or edit of the prompt or timing for a schedule linked to the same conversation
and workspace. Edits accept interval, one-shot or calendar timing. The review
shows the old and proposed records, including the proposed first run. If the
first run of an explicitly edited timing expires during review, the edit is
rejected and must be reviewed again.
The saved schedule must remain unchanged and the approval valid at commit.
An immediate run queues an unattended task; removal and edits do not cancel or
change already queued or running tasks. A previously run schedule cannot be
repurposed as a new one-shot; create a new schedule instead. Once a commit
starts, the caller waits for its outcome. If storage reports an uncertain result,
inspect the schedule before retrying. Read-only child agents cannot use this tool.

V4 offers `web_search` on Unix when the current account has exactly one Vault
entry named `terminal-v4:web:tavily`. The entry's value is a Tavily API key;
add it in API Settings → Key Vault on the host running that V4 session. See the
[Tavily Search API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
for the provider's request and account details. Each search
requires approval of the exact query, Tavily endpoint and result limit; the
query is sent to Tavily and may incur provider charges. Search returns bounded,
untrusted snippets and links, not full-page extraction. Unattended and read-only
child runs cannot use it. The client does not use proxies or follow redirects,
pins the provider's approved public IPv4 addresses, and rejects oversized
responses. A timeout or cancellation can occur after the query was sent, so a
retry can incur another charge. IPv6-only networks and non-Unix hosts are not
supported.

The key is scoped to the runtime host and owner. A paired remote session reads
the remote host's Vault, not the home host's Vault; the current paired Vault UI
routes to home, so configure the remote host through its own interface. This
feature assumes a stable, private local application data directory. Its SQLite
Vault database is opened by pathname: inode and root checks detect ordinary
replacement, but cannot prove fd-relative identity against a hostile same-user
directory swap away and back between checks. Model-visible results redact common
forms of the provider key; arbitrary transformed secrets are not guaranteed to
be detected.

The read-only CLI `/context` and structured context estimate check whether web
search is configured without creating SQLite sidecars. If the Vault database is
in WAL mode or has a pending journal, they report that integration metadata is
unavailable rather than silently omitting or miscounting the tool. The estimate
includes the standard schedule creation, listing and management, question and todo
declarations. Structured-session estimates also include background delegation
when that session manager has a supervisor and the provider supports it; the CLI
estimate omits that structured-only tool. This does not disable an otherwise
approved search turn.

`web_extract` retrieves one exact URL after approval when the account has
enabled agent browser access and added the URL's exact origin to its allowlist.
It uses an independent unauthenticated GET, without browser cookies, browser
state, proxies or redirects. HTTP is unencrypted, and a request may reach the
site even if it is subsequently cancelled. Only public IPv4 destinations on
standard HTTP and HTTPS ports are supported; DNS answers are checked and
pinned for the request. The tool supports UTF-8 `text/plain` and `text/html`,
with a 256 KiB response limit and 32 KiB output limit. HTML is tokenized to
exclude scripts and some hidden content; it is not a browser rendering or a
full readability algorithm, and PDFs, JavaScript-rendered pages and other
formats are unsupported. Returned page text is untrusted. Unattended and
read-only child runs cannot invoke this tool. Browser settings and data-root
scope are checked before execution, assuming a stable private local data
directory; configuration changes concurrent with a request are not a revocation
guarantee. Local synthetic tests do not establish live-site compatibility.

Workspace file changes are enabled when starting the agent. Every shell command
requires approval of that exact command. Structured conversations display a
server-bound action card; the CLI asks in the terminal. A decision authorizes
only the displayed action in its current turn. Approved commands have normal
host access: this is an approval boundary, not an OS sandbox. Their
environment excludes provider credentials and they stop after 60 seconds.
Unattended tasks deny shell execution; they can use the bounded workspace file
tools. The task worker retains its existing cancellation, process containment,
scheduling, receipts and managed-worktree checkpoint behavior.

The `ask_user` tool lets V4 ask one to five questions in an interactive
structured conversation. Questions can include two to six choices; the user
can also type an answer. Set `multiSelect: true` on a question with choices to
allow multiple selections and one additional custom answer. Empty, duplicate,
or more than one custom answer are rejected; questions without that flag retain
the existing single-answer contract. The question is bound to its owner, session, turn and
tool call, expires after five minutes, and is resolved if the turn is cancelled
or the session restarts. Answers return to the provider as the matching tool
result and are retained in conversation history; users should not enter secrets.
Repeated submissions with different answers are rejected. After a restart or
after the active turn is gone, an answer retry cannot be verified and is rejected;
check the conversation before retrying. CLI and unattended runs cannot answer
this tool and report it as unavailable.

On Unix, `delegate_task` can start an approved read-only investigation in a
separate V4 conversation context using the parent’s provider and model. The
approval identifies the exact prompt, workspace and model, and the parent waits
for the result in the same turn. The child can use the read-only file and
knowledge tools; it cannot use shell, file writes, integrations, scheduling or
another delegation. Cancelling the parent stops the local child request; a
remote provider may still process an already submitted request. The result
is returned as a tool result and is capped at 48,000 bytes. This is a foreground
operation: it does not provide parallel background children, parent wakeup,
or automatic restart and recovery after interruption. It applies a tool-policy
ceiling, not an OS sandbox, and inherits the workspace path assumptions above.
The runtime contacts the selected provider and stores the child conversation.

On Unix, `delegate_tasks` runs two to four read-only investigations concurrently
in separate V4 conversations. A single approval lists every prompt and the
workspace, provider, model and read-only ceiling. The parent waits for all
children and receives their individual outcomes in the original order; one
child's failure does not discard the others. Each successful result is capped
at 24,000 bytes. Cancelling the parent stops the local wait; provider requests
already submitted may continue remotely. Like `delegate_task`, this is a
foreground operation and does not provide restart recovery or parent wakeup.

An internal, opt-in V4 child launch can select `--tool-policy read-only-child`
for a new unattended query and must provide a preallocated, canonical UUID using
`--child-session`. The runtime durably claims that session identity before its
first provider request and rejects an existing session or deletion tombstone;
the supervisor durably binds and authorizes that identity before launch and does
not replay an uncertain launch. It advertises only an explicit set of file and
knowledge reads and independently rejects every other tool call, including
unrecognized names. This does not change ordinary unattended tasks. The ceiling
applies to model-directed tools, not
an OS sandbox: the runtime still contacts the selected provider and persists its
own conversation state. Saved provider profiles and native CLI providers are
not supported by this child launch.

The Unix build includes internal outbox, reviewed launch, and parent-queue
delivery primitives for background investigations, plus a supervisor that can
be attached to the session manager for deletion, owner cleanup, and shutdown.
The Unix server initializes that supervisor when its private outbox is available.
A persistent guard binds the canonical data directory, outbox directory, database,
and lock file; missing,
replaced, or incompletely initialized storage requires manual recovery and is not
silently recreated. A server unable to own the outbox keeps ordinary sessions
available but does not attach the supervisor. A second server must restart to
retry ownership after the first exits. This assumes intact local storage and
working filesystem locks; restoring or losing both the ledger and guard cannot
be detected as distinct from a new installation. On session access, durable
terminal task results can be staged and reconciled into the exact owner-bound
parent queue; restart holds remain in place and uncertain prior submissions are
not replayed. Unfinished tasks recorded before startup are marked interrupted
only after the account's ownership can be acquired; an unclean prior shutdown
first requires the owner to review and confirm the previous processes stopped.
New children are not treated as abandoned. On supported Unix V4 task providers,
the model can request `delegate_task_background` during an owned structured turn.
The user reviews the exact investigation, workspace, model and read-only ceiling
before launch. A successful start returns a task and child session ID. The
approval persists the parent conversation's incarnation and, when available,
the initiating local credential's non-secret generation and expiry. Launch,
delivery and receipt reconciliation reject a missing or changed parent
incarnation. Legacy outbox records without that identity remain staged for
review; new sessions without an incarnation cannot start background delegation.

On Unix, a locally authorized turn can enable a new, empty follow-up queue and
attach a proof bound to the exact message, parent and credential. The normal
dispatcher uses the proof-bearing admission path for those items; the credential
must remain valid at delivery and dispatch. Existing unproven queue items retain
their legacy dispatch behavior. Editing a protected item after signing in locally
renews its proof, while editing an unproven item does not silently upgrade it.
Revocation, expiry or uncertain publication retains the result for review
without an unproven retry. A turn without usable local or attested paired
authority places its result in a held queue in either build. If the
conversation is unavailable, review the retained task result. Existing manual
and restart holds are never released by delegation. When launch fails, an unstarted
child is recorded as interrupted; a task whose launch outcome is uncertain
remains available for recovery rather than being retried. The tool is unavailable
when the supervisor is unavailable, for unsupported providers, in unattended CLI
turns, and inside read-only children.

Isolated HTTP tests with a synthetic provider exercise automatic parent follow-up,
manual holds, credential revocation and local reauthorization. A separate test
uses two loopback APIs connected through the paired proxy; no live provider or
physical device was used.

On Unix, an eligible paired input captures a non-secret grant identity under the
owner admission lock and carries it into a background delegation's reviewed binding.
After approval, live paired-grant admission protects the exact reviewed binding
with the queue installation key before a child is launched. A changed binding or
key is rejected. The bearer token is not stored in the binding or attestation.
This metadata and proof alone do not authorize delivery or dispatch of a result.
If the identity cannot be captured, the existing held-result behavior applies;
if the grant cannot be revalidated when creating an attestation, the child is not
started. Paired authority is checked again under its admission guard at the
child launch boundary. If a child has already started when a later confirmation
fails, its process handle remains supervised rather than reporting that launch
did not occur.
Grant expiry, capability changes, revocation and the owner admission lock are
covered by focused tests. A versioned, encrypted queue proof binds that identity
to the exact session, queue and message; paired result publication creates it, and the
V4 dispatcher rechecks the live paired grant at canonical message acceptance.
An isolated loopback paired-client test covers automatic delivery, a manual hold,
and revocation before dispatch using a synthetic provider and child. A two-server
loopback test covers proxy delivery and explicitly resuming a completed, held result
after graceful remote-server restart. It also kills the remote server while a
synthetic child is active, confirms that child stopped, requires ownership review,
and resumes the retained interruption explicitly without starting another child.
Temporary owner-input contention is retried
only when admission proves no message was accepted; exhaustion still holds the queue.
These tests do not exercise a real provider, physical device, stopped supervisor,
or escaped descendant. Tests show
the prior strict proof decoder rejects the new format; they do not exercise an old binary. Older readers also
reject delegation records containing the new binding field.

Background delegation is read-only investigation only: there is no writable
child, and a request cannot widen the reviewed ceiling because the tool accepts
only a prompt and the server chooses the child, task, workspace and permission.
The child runs unattended, so it has no approval channel; every non-allowlisted
tool, including shell, writes, scheduling, integrations and further delegation,
is rejected before any approval could be requested. Lifecycle tests drive a real
child process against a synthetic provider and check files, process liveness and
the outbox, task and parent-queue records: denied approval starts nothing;
rejected tools leave the workspace unchanged; a duplicate completion, repeated
recovery pass or restart never queues a result twice or relaunches the child;
the user's Stop or a parent cancellation kills the child and reports a cancelled
result; logout, shutdown and parent deletion stop the child, record an
interrupted outcome and publish nothing to a fenced or deleted parent, and a
retained interruption is delivered once after sign-in or restart. A transient
queue-storage busy failure during delivery is retried a bounded number of times
without replaying an unproven attempt; a result whose delivery stays uncertain is
kept for review. These tests use local synthetic providers and are not a
substitute for a live-provider run.

Known limits: the ledger retains at most 1,024 full records across all accounts.
When full, it prunes only delivered records with a verified queue receipt and
retains their identities and binding digests as tombstones to prevent replay.
Unfinished and undelivered records are retained; when there is insufficient room
or the 262,144-tombstone limit is reached, new requests fail closed. Children run
in their own process group and are stopped on Stop, logout, deletion and graceful
shutdown. A pipe lifeline also causes the child to kill its process group when
the supervisor process dies; it cannot detect a supervisor stopped with SIGSTOP,
and an escaped descendant is outside that process-group mechanism. After an
unclean shutdown the owner must still review and confirm that previous processes
stopped before cleanup completes. An unproven result is held for review instead
of automatically waking the parent. A transient failure that is not
provably pre-queue (for example a storage fault after submission) leaves delivery
uncertain until the owner reviews the retained task result.

A turn is limited to 32 provider requests and 64 tool calls. Textual request
context has a default 600,000-byte guard with earlier automatic compaction and
reserved output room; verified model limits can reduce it. Provider JSON responses are capped at 8 MB; streamed input
is capped at 16 MB with bounded frames and event counts. A request times out
after 120 seconds. Images are hydrated only into real message-content positions;
tool arguments remain unchanged. Requests including attachments are capped at
24 MB. Provider failures, incomplete output and limit exhaustion fail the
turn. Noninteractive output streams `v4.text.delta` events followed by a `v4.result` event and a nonzero exit on
failure, which the durable task runner recognizes.

## Workspace knowledge and conversations

Each request includes that account's reviewed account/workspace memory, saved
always-on skill instructions, and the root `AGENTS.md` when present. Existing
skills without an activation setting default to always-on. Opt-in on-demand saved
skills contribute only their bounded name and scoped UUID reference to the system
context; V4 instructs the model to read `SKILL.md` via `read_skill_file` when a
skill is relevant or requested and to follow line and character continuations.
Supporting files are read lazily. Tool use depends on the selected model and
provider; V4 cannot guarantee that a model will choose or support a tool call,
including for an unverified custom model. Explicitly adding a skill to the prompt
still includes its selected contents. Agent-callable knowledge tools search only owned
V4, persisted PTY, completed structured, and already-imported history; anchored
reads carry source/workspace/revision identifiers and bounded continuation.
Account-wide recall is explicit; no native provider home is scanned for recall. Knowledge changes remain explicit in the
Workspace knowledge and learning-review UI. Installed skills can be selected and
reviewed through the existing skills UI; they are not silently promoted to memory.

Visible conversation messages and provider continuation state are saved under
`v4-agent-history/<account hash>/<canonical workspace hash>/<session UUID>.json`.
Private heads are limited to 2 MB; immutable transcript parts retain up to 64 MB
of visible history with separate bounded native archives. `/history` and `/resume ID` use only the
current account and workspace. The History panel can import a redacted visible
snapshot and compose a reviewed handoff. Provider reasoning state is not shown in
that handoff. Coordinated rewind creates an independent conversation prefix and
restores a reviewed managed-worktree checkpoint; the source conversation stays
intact. V4 forks expand compaction lineage and retain complete native tool-call/result boundaries and copied owned image references. Historical approvals never authorize future actions.

CLI commands: `/model ID`, `/memory`, `/skills`, `/history`, `/resume ID`,
`/compact [instructions]`, `/context`, `/clear`, `/help`, `/exit`. Original model compaction preserves full visible history, structured summaries and immutable native-source receipts. Automatic byte-pressure guards run before requests; unknown token usage stays unknown. See [compaction](V4_COMPACTION.md) for budgets, rollback and recovery. V4 incrementally consumes SSE for Anthropic Messages,
OpenAI Responses, and compatible Chat Completions. Tool calls are assembled and
validated before execution; incomplete/error streams never become success.
Reasoning continuation is preserved without displaying private thinking. JSON
responses remain supported for compatible endpoints that do not return SSE.

## Persisted terminal lifecycle

PTY lifecycle operations share one manager admission barrier. Create, restore,
rename, thread metadata, retained exit, suspend and Delete cannot publish a late
journal after a successful Delete. Output publication has its own ordered barrier;
UTF-8 decoding and final reader drain preserve bytes received before closure.
Concurrent restores reuse one owned process. Restored thread and sandbox metadata for the next
launch are saved before a successful restore response.

A retaining stop can fail while draining or saving history. Remaining reader
bytes stay streamable until finalization. A confirmed stopped terminal whose
final save failed stays managed for recovery but is listed inactive, with no busy
flag. After storage is repaired, Restore saves its retained in-memory history and
starts a fresh PTY; it never acknowledges the stopped process as live.

Delete keeps its cleanup owner until journal removal and owned process cleanup
both succeed. A failed deletion still attempts process cleanup and preserves a
retryable owner. Pending Delete fences metadata, restore and late exit callbacks.
Successful named tmux cleanup is recorded before subsequent fallible work, so a
retry does not repeat that completed step. Automatic tmux recovery skips every
already managed entry, independently of whether it is still streamable.

These admission guarantees apply to one API manager. They do not establish
safe legacy journal writes from multiple API processes or persistence of a failed
Delete request across a crash.
Isolated named-command fixtures cover tmux retry bookkeeping; native tmux server
behavior requires a separate environment. Sandbox fields describe the selected
policy and runtime identity; they are not proof of OS isolation.

## MCP and isolated browser tools

Settings → MCP servers stores account-scoped, encrypted explicit server settings.
Saving never starts a process. Probe is an explicit cancellable job, and a cancel
receipt waits for cleanup. The original MCP client implements bounded newline
JSON over stdio and Streamable HTTP JSON/SSE, pagination, tools, resources,
templates, prompts, session headers and explicit host capability policies.
Sampling and elicitation are denied unless a host handler is explicitly supplied;
no production flow registers them. App-only tools are excluded from agent calls.
The model first uses local `mcp_list_servers`, then approved discovery/call/read
wrappers. Unattended tasks cannot approve external access. Component-only result
metadata is excluded from model context. See [MCP](V4_MCP.md).

Settings → Agent browser configures an original CDP client. It launches only a new
V4 process and disposable profile, never attaches a personal browser, and checks
an exact origin allowlist. Every action requires approval. DOM refs, tabs,
navigation, forms, waits, scrolling, screenshots and evaluation are supported.
Settings saves do not launch it. See [agent browser](V4_AGENT_BROWSER.md) for the
verified behavior and current interaction limits.

PNG/JPEG/GIF/WebP tool images use private account/workspace/session-scoped files
and typed content hashes. History stores image references, then V4 hydrates them
into each provider's image schema. Artifact reads reject tampering and symlinks;
per-image, per-request and session disk quotas are bounded. Framing validation
does not decode pixels. Visible transcript storage is separate from the bounded 2 MB active head and scoped image objects.

On Unix, `TERMINAL_V4_IMAGE_INSPECTION=1` opts standard V4 conversations into
the `inspect_workspace_image` tool when the selected model has confirmed image
input. An exact approval shows the relative file, workspace, provider, model,
size, format and SHA-256 digest before sending the image to that provider. The
tool re-reads and verifies the reviewed content after approval, rejects protected
paths and symlinks, and stores the result as a scoped image artifact. The model
interprets the returned image; this is not a separate image-analysis service or
an auxiliary-model fallback. It is not available to read-only child agents.
The file boundary shares the documented workspace hard-link limitations.

On Unix, `TERMINAL_V4_IMAGE_GENERATION=1` separately opts standard V4 turns
whose selected model has a known image-input capability status into `generate_image`.
For a confirmed text-only model, the artifact is shown in the structured UI
but the model receives a text notice and no image bytes. Unknown model image
capability remains unavailable. Each use requires an
exact approval showing the prompt, OpenAI image model, size, quality and charge
risk. An optional `image_path` edits one workspace image: the exact path,
format, size and SHA-256 digest are reviewed, and the image is reread and
verified before dispatch. Protected paths and symlinks are rejected; the same
workspace hard-link limits as `inspect_workspace_image` apply. The account's
configured OpenAI API key is read from its Vault and its reviewed configuration
is checked again before the request. The tool sends one request to the fixed
[generation](https://developers.openai.com/api/reference/resources/images/methods/generate)
or [edit](https://developers.openai.com/api/reference/resources/images/methods/edit)
endpoint with redirects and automatic retries disabled, retains one validated PNG as an owner/workspace/session-scoped
artifact, and reports an unconfirmed outcome if the request or result is lost.
Vault edits share an owner-scoped admission lock with image generation across
cooperating current-version processes using the same intact local data directory.
An edit returns a retryable busy error while a request holds the lock; different
owners do not block each other. Older processes and external Vault or filesystem
edits do not honor the lock. After cancellation releases it, a provider request
already admitted may still be processed or charged; its outcome remains unknown.
The lock protects all Vault writes even when image generation is disabled. A
missing or replaced lock, or restoring a database to a different filesystem
identity, can make an owner's Vault writes fail closed until offline recovery.
Established lock identities are checked without a database write transaction;
first registration and the Vault change itself still require SQLite writes. If
another writer holds the database, the operation returns a retryable busy error.
This path does not support masks, multiple source images, an auxiliary model, or
read-only delegated children; real-provider availability has not been verified.

### Recovering a Vault admission identity after a restore

This is an offline operator procedure, not an automatic migration. First stop
and prevent restarts of **every** Terminal V4 server using the original or the
restored data, including old-version servers, and make sure no provider request
is still in flight. A request accepted by a provider may continue after the
server stops. Back up the restored database and lock files before proceeding.
Do not run this on a shared filesystem while any other installation can access
the same data. Identify the affected owner's exact internal user ID through the
operator's existing account records; this is not necessarily a username.

Set `V4_DATA_DIR` to the restored data directory and `V4_OWNER_ID` to that
internal ID. The following command removes only that owner's stale admission
identity and its lock file. It prompts for confirmation and does not change
Vault keys. It cannot verify that every server is stopped; that is required
before running it.

```sh
python3 - <<'PY'
import hashlib, os, pathlib, sqlite3, stat
root = pathlib.Path(os.environ['V4_DATA_DIR']).resolve(strict=True)
owner = os.environ['V4_OWNER_ID']
if not owner or input('Type RESET VAULT LOCK to continue: ') != 'RESET VAULT LOCK':
    raise SystemExit('Cancelled')
owner_hash = hashlib.sha256(owner.encode()).hexdigest()
lock = root / ('vault-admission-' + owner_hash + '.lock')
db = sqlite3.connect(root / 'terminal.db', timeout=1)
db.execute('BEGIN IMMEDIATE')
try:
    try:
        metadata = lock.lstat()
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_nlink != 1:
            raise RuntimeError('Unsafe lock file; inspect it before recovery')
        lock.unlink()
    db.execute('DELETE FROM vault_owner_fences WHERE owner_hash = ?', (owner_hash,))
    db.commit()
finally:
    db.close()
print('Identity reset; restart one current-version server.')
PY
```

Restart one current-version server and verify the affected Vault operation.
If recovery fails, keep all servers stopped and restore the backup before
retrying; do not delete the entire table or reset unrelated owners.

## Verification and remaining scope

Local HTTP, stdio and Chromium fixtures exercise real requests, streamed text,
tool calls, writes, context injection, private history, image conversion and
failure/cancellation handling without paid inference. The retained structured
runtime evidence covers 24 API/WebSocket checks and 11 restart/compaction checks.
Full-App browser evidence covers desktop/mobile conversation, approval, draft,
queue and workspace flows. Exact gate counts and source/binary bindings belong
to each recorded verification checkpoint. The separate queue evidence covers ordered dispatch,
durable receipts, restart holds and retained MCP cleanup. These are bounded
synthetic checks; native WKWebView pixels were unavailable in this environment. Live provider/model
availability requires an account key and a real call. Passing fixtures does not
establish every vendor's compatibility. Remote hardware and Windows-only desktop
control require separate environments.

V4 has its own workspace/account knowledge, reviewed learning, packaged skills,
history handoffs, managed worktrees, checkpoints, durable tasks, schedules,
previews, pairing and sharing. This does not establish complete Hermes or T3
feature parity. The full documentation inventories retain 309 behavior contracts
and 1,235 acceptance criteria, plus optional ecosystems. Owned structured
conversation/approval UI and model-generated compaction are implemented with the
bounded evidence above. Source implementations of the Context dialog and manual
compaction now have separate verification gates described in the structured UI
document; source presence is not an installed-build claim. Durable agent-to-agent
steering and parent wakeup, full desktop/media/voice
tools, additional execution backends and integrations remain open. Normal text
composer drafts and uncertain request UUIDs survive component remounts; user
attachments, coordination across windows and complete offline behavior remain open.
Global workspace panels use the selected structured session's canonical cwd;
unknown project/Git metadata stays unknown. Tools and knowledge use each pane's
own workspace, and Files preserves manual navigation while that workspace is
unchanged. Selection intent and request generations fence stale navigation and
inventory replies. See [structured UI](V4_STRUCTURED_UI.md) for scope and evidence.
MCP Apps settings previews
have local API/browser evidence; agent tool-result app embedding is a separate
open workflow.

Verification records in the current task workspace are
`work/parity/structured-runtime-results.json`,
`work/parity/v4-full-app-ui-evidence.json`, and
`work/parity/queue-live-evidence.json`. They identify their immutable API binary
and source snapshot; later changes require their own verification.
