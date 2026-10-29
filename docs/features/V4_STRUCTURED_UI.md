# V4 structured conversations

The new-session folder picker uses the current account's agent catalog. An agent
with `runtime: "v4"` and `capabilities.structured: true` creates a structured
conversation with the selected provider, model, and supported reasoning setting.
Native and custom terminal launchers remain available through the existing
terminal path. Structured session snapshots retain their runtime identity.

## Accepted messages

Owned V4 text submissions use a UUID `requestId`. The composer keeps its draft
until the server returns a matching durable acceptance receipt, or the receipt
is confirmed through the owner/session-scoped request lookup. A network error,
an invalid receipt, or an HTTP 5xx response triggers a read-only receipt lookup;
it never automatically resubmits the message. If acceptance remains uncertain,
the draft stays visible. A manual retry of unchanged text reuses the same UUID.
Explicitly sending changed text starts a new request identity. Successful
acceptance clears only that matching retry identity.

The canonical `user_message_accepted` event and HTTP receipt reconcile through
`requestId` / `messageId`. Canonical sequence numbers put replayed history before
later accepted messages even when the HTTP receipt arrives first. Assistant
updates target `messageId`; tool updates target `turnId` + `toolCallId` so a
provider may reuse its local tool ID in another turn. The UI retains
those identities when rendering tool cards. Turn lifecycle events control the
owned V4 activity indicator.

Normal text drafts and their revision tokens are shared by the production
desktop/mobile composers and saved on the device under the account, home API,
environment and session scope. The pending request identity is saved before POST
and survives responsive remounts and reloads. Mounting never submits a message.
An explicit unchanged retry checks the original receipt first; only a missing
receipt permits another POST with the same UUID. Acceptance clears text only if
its captured revision is still current, so newer edits survive a late response.

Storage errors retain visible text and block an owned V4 send whose identity
cannot be saved. A transient read failure can recover on manual retry without
losing dirty text or a valid saved pending ID. Malformed saved records remain
untouched and block sending. One document shares a send lease; cross-window
locking, attachment durability and a general offline execution engine are not
provided. The follow-up queue keeps its separate scoped draft, durable mutation
receipts and review panel.

## Approval decisions

Owned V4 approvals require the displayed server `approvalId`. The exact action
identity is submitted with the boolean decision. Buttons remain disabled while
that request is pending. The UI only clears the matching card after a matching
accepted/idempotent decision receipt, or a matching canonical
`approval_resolved` event. Missing IDs, mismatched receipts, and failed requests
keep the action available with a visible error. A late receipt cannot clear a
newer action. Legacy structured providers retain their original approval body.

## Current input boundary

Owned V4 conversations currently accept text. Image/file attachments are
explicitly disabled and explained in the composer. If an attachment is already
present, sending is blocked until it is removed; it is not silently converted
or discarded. V4 workspace tools can still read files when a text request asks
them to do so under their existing permissions. Owned V4 sessions do not expose
an inline PTY, because they run in the V4 structured engine.

## Conversation context and manual compaction

Own V4 conversations expose Context beside Queue. Opening it reads only the
owned local saved context. The byte sample includes normal text and metadata
before image hydration, including stored image references or the normal
text-only placeholders. Hydrated binary and unsent drafts are excluded. The
server supplies the model-specific byte guards. Model context-window metadata,
last provider-reported token counters and native-history receipt sizes have
separate labels; missing counters are Not reported, and zero is preserved.

The local endpoint authenticates an exact owned parent without recovering other
sessions or repairing history. It samples a single saved revision and rejects
stale publication after parent activity changes. Reads have per-session single
flight and a global worker cap; a timeout or abandoned HTTP waiter retains the
worker permit until the work finishes. Opening Context does not resolve provider
credentials, connect MCP/browser tools or start inference. Existing encrypted
MCP settings need a matching minimal declaration cache, refreshed only through
their normal authorized settings/load paths. Missing or stale metadata makes
the sample unavailable. Paired-host Context reads remain blocked.

Compact is explicit. Optional instructions and their revisions use a separate
device store, scoped by verified account, full home API, environment and session.
The exact UUID, nullable instructions and reviewed conversation revision are
saved before POST. Normal composer text and queue drafts are not changed. Only
the submitted instruction revision clears on acceptance; newer edits survive.
Storage failure retains text and blocks submission, with an explicit local save
retry. Accepted compact identity stays durable until its terminal outcome is
confirmed. A separate compact receipt validator permits omitted messageId;
ordinary user-message receipts still require it.

Queue and Context forms render through portals. The shared composer accepts
submit events only from its own form; dialog actions cannot send or clear the
ordinary draft. Its own Send control and live Enter path retain normal behavior.

The existing WebSocket projects bounded command, compaction, usage and lifecycle
events without adding chat bubbles. Its entire encoded array is at most256000
UTF-8 bytes, at most64 events and at most64000 bytes per event. Every canonical
sequence advances authority, including omitted kinds. Replay reset and scope
changes invalidate old samples and in-flight reads synchronously. A new sample
is advisory; the server still decides admission against busy, cleanup and queue
state. Running work and dispatch reservations have priority; a held pending
queue remains held.

Recovery checks the original UUID and owned canonical command/body/turn before
settling it or explicitly retrying the frozen body. Lookup404 alone is not proof
that no command was accepted. Any rejected retry after uncertainty preserves
that identity. Mount/reopen, replay recovery and outcome checks never submit or
Stop a command. Bounded automatic read-only recovery coalesces reset/truncation
and matching terminal markers; after its limit the user can check the outcome
explicitly. Closing only stops UI waiting. Account/session/environment changes
reject old callbacks, including delayed JSON responses.

During an explicit submit or retry, the existing HTTP client may refresh an
expired access token after401 and repeat that same serialized request body.
This inline authentication retry keeps the original UUID and reviewed payload;
it does not authorize mount, reopen or recovery to submit a command. A definitive
refresh401/403 clears credentials, updates the mounted sign-in view and preserves
scoped drafts and intents. Network failures,429 and5xx retain the existing session
for retry. An authentication generation and the full home API address fence late
responses before credential/user writes or an inline retry. Explicit login and
logout change that generation; same-account token rotation preserves it. Initial
session validation remains pending until identity verification and cannot restore
an old user after a later login, clear or unmount. Native auth-storage changes
also update the mounted auth view. Passkey sign-in captures its auth generation
when it starts; late results and a closed sign-in page cannot adopt an account.
Scope-current explicit logout clears persisted credentials even if its provider
unmounts while waiting for the server.

Stop conversation is the existing explicit session-wide action and holds queued
work. Only cancelled with cleanupConfirmed confirms its cleanup receipt;
accepted/reconciled health alone does not. Stop never proves a particular
compact was rolled back: its exact outcome is reconciled separately and a
committed summary wins. Exact request cancellation, an archive/export UI,
cross-window locking and a new typed result endpoint remain separate work.

## Workspace scope and navigation

The selected session snapshot's canonical `cwd` supplies the global workspace
header, Preview context, Tools, Knowledge and initial Files location. Editable
thread `projectPath` controls sidebar grouping; it does not replace the execution
workspace. Structured project metadata is explicitly `unknown`: unrelated PTY
Git branches, detected project names and start commands are not borrowed.

Each split pane retains its own workspace for Tools and Knowledge. Focusing a
pane changes the global workspace, while another pane's Git metadata stays
isolated. Live PTY cwd updates are tied to their session and selection generation,
including when a pane returns to an earlier session. Late inventory, project and
restore responses cannot overwrite newer navigation or an account/environment
switch.

Explicit navigation reserves an intent before asynchronous restore or unarchive.
The last requested history item wins regardless of completion order; explicitly
selecting the current item also cancels older pending navigation. Automatic
startup restore preserves a later explicit choice. Selecting or reloading a
structured conversation does not implicitly create a PTY. The workspace start
screen's explicit New terminal action opens the folder/agent chooser with the
current workspace selected.

If a selected snapshot is missing, the mobile view and Files show a loading or
unavailable state instead of showing another session or listing home. Files
starts in the selected canonical workspace, preserves manual browsing between
threads with the same cwd, and resets when the workspace/account/environment
changes or the panel is reopened. Newer manual directory navigation also wins
when responses arrive out of order.

## Verification

Installed and source checkpoints are distinct:

| Checkpoint | Frontend gate | Actual App browser flows |
| --- | --- | --- |
| Installed `structured-pty-v1` bundle | 907 tests / 133 files | 17, using its compiled bundled assets |
| Installed `workspace-lifecycle-v1` bundle | 938 tests / 133 files, production build | 26, using its compiled bundled assets |
| Context source test checkpoint | 1068 tests, exact frontend source manifest | New Context App flows not yet executed at this checkpoint |

The new Context source phase is not an installed-bundle claim. The installed
workspace checkpoint's real HTTP/WebSocket App fixture retains the original 17 flows: provider/model selection, acceptance and
replay, lost-response lookup, same-UUID retry, exact approvals/rejection, queue
dispatch, owned images, cleanup-confirmed Stop, desktop/mobile text drafts,
reload recovery and uncertain-send continuity without another POST. Nine added
workspace flows cover canonical create/select/reload, mixed PTY inventory,
editable grouping isolation, authenticated Tools/Knowledge requests, Files
navigation, delayed PTY metadata, unknown Preview context, split-pane focus,
pending selected snapshots and mobile workspace panels.

Desktop evidence uses a 1440×1000 viewport; mobile uses 390×844. Directly inspected
captures include the split session menu within its owning pane, canonical Files
and Knowledge panels, mobile pending approvals and the separate queue dialog.
Normal pointer checks establish that the split menu receives input, mobile Files
is above its backdrop, its Close target is 44×44 px, and both Close and outside
backdrop clicks work. Mobile panels do not cause horizontal document overflow.
There are no browser page errors or implicit UI terminal-creation requests.

The task's `work/parity/structured-workspace-ui-evidence.json` records source
hashes, gates, the 26 flows, inspected captures and cleanup. The earlier
`work/parity/structured-pty-v1-installed-ui-results.json` preserves the 17-flow
installed proof. `work/parity/workspace-lifecycle-v1-installed-ui-results.json`
records all26 installed flows, and its static-file proof covers all24 bundled
and HTTP-served frontend files. The Context source gate is recorded in
`work/parity/compaction-frontend-reviewed-receipt.json`; actual runtime and
installed feature proof must bind their own binary/source/frontend hashes.
`work/parity/structured-runtime-results.json` records separate API/WebSocket and
recovery/compaction fixtures; `work/parity/queue-live-evidence.json` records
ordered queue execution and restart holds.

All fixtures use a fresh disposable account, storage, HOME, workspaces, a
synthetic localhost model and an owned stdio MCP process. No real provider
credentials, paid requests, private pages or email accounts are used. External
font loading is blocked. Native WKWebView pixels remain unverified because OS
capture permission was unavailable; these images establish Chromium behavior.
Blob/file attachment durability, cross-window send locking and structured
project-type/Git discovery remain outside this scope.

## Model reasoning and owned images

The model's explicit `reasoningLevels` list takes precedence over a provider
summary. An empty list means the model has no reasoning control. Refreshing the
catalog or selecting a different model removes unsupported settings. Unknown
custom V4 model IDs do not invent a reasoning setting. Older native catalogs
retain their provider-level fallback.

Typed `v4_image` tool content is rendered only through the authenticated
session artifact route. The client accepts SHA256 artifact IDs and PNG, JPEG,
GIF, or WebP MIME types, bounds each Blob to 8 MiB, and never fetches a source
URI from a tool result. Object URLs are revoked and requests aborted when the
session/environment changes or the component unmounts. Missing, invalid,
oversized, or undecodable images show an unavailable placeholder. Binary/base64
payloads are not embedded in the canonical transcript.

## Stop and cleanup

The structured conversation header exposes Stop while a turn is running. Stop
requests are single flight and failures are visible and retryable. Owned V4
cleanup receipts must explicitly confirm cleanup; an HTTP success without that
confirmation is insufficient. The transcript and pending approval remain
visible until matching canonical resolution/cancellation events arrive. A late
Stop response from an old session or environment cannot change the new scope.

A `v4_cleanup_pending` error or current `cleanup_required` /
`reconciliation_required` snapshot keeps **Retry cancellation** visible even
after a terminal turn event stops streaming. Unresolved approval cards and
partial tool output remain until their own canonical resolution. A confirmed
cleanup receipt or newer canonical `status: idle` clears the recovery flag;
a delayed receipt cannot hide a newer failure. Snapshot sequence watermarks
prevent historical errors from recreating a resolved cleanup blocker on replay.

## Follow-up queue access

Owned V4 desktop and mobile composers expose **Queue**, which opens the separate
follow-up review panel. Its text buffer and mutation identities are independent
of the normal draft. The dialog closes on session/account/environment changes,
traps keyboard focus, supports Escape, and returns focus to its trigger. Legacy
terminal and optional structured providers do not expose this V4 queue control.

When a queue operation is recovered from its durable receipt after an uncertain
response, the panel retains a scoped reminder across reloads. **Wake queue** is
an explicit, separately identified action for an already-running queue; it does
not repeat the recovered message or release manual, restart or error holds. A
held queue must be reviewed and resumed separately. A successful wake requests
processing; it does not prove that a message was delivered, and it remains
available while a running queue has pending items. In the default build, or when
any pending item lacks a durable authorization proof, Wake instead holds the
queue for review. Check the conversation before manually sending unsent work.
The experimental `queued-authority-preview` build can process proof-bearing
work after checking its authorization at dispatch. The existing Resume action
still has legacy dispatch behavior in default builds; it does not provide this
proof check. If wake confirmation is uncertain, its operation identity is
retained for a safe retry. Older servers that do not support Wake reject it.

The queue store supports a durable identity for a future background-delegation
binding. Existing queues without an identity remain readable; requesting one
adds `queueIdentity` to that queue's stored envelope. Older readers that reject
unknown fields will refuse that envelope, so this is not a downgrade path. Do
not run older and newer API versions against the same data directory: an older
process with a previously read snapshot may overwrite newer state. This storage
support does not enable background delegation or automatic parent wakeup.
