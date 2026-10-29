# Structured session ownership prerequisite

## Reproduced defect

Two independently constructed structured managers can load the same owner/session and then accept the same Codex request ID twice, returning two different turn and message IDs and starting the provider twice. The ignored regression `structured::codex_queue_prerequisites::two_managers_do_not_accept_the_same_codex_request_twice` reproduces this with two managers and a synthetic provider in one process. Separate API processes have the same independently loaded actor state. This is an existing structured-session defect, not proof of a currently enabled native follow-up queue.

The first test run failed with different durable receipts; rerunning the ignored test after moving the start-count assertion first demonstrates two provider starts. The normal suite leaves this test ignored until ownership is implemented. Existing queue storage locking serializes individual queue-file operations; it does not own the parent session or serialize canonical input admission, journal updates, provider spawn, or deletion.

## Stored incarnation prerequisite

New structured sessions record a random `sessionIncarnation` UUID in their
owner-bound checkpoint. Checkpoint rewrites and reopen retain it; it is not part
of the public session snapshot. Older checkpoints and raw legacy snapshots with
no field remain without one, including after migration. No automatic migration
assigns an incarnation to an existing session: doing so safely requires the
cross-process ownership boundary described below.

This field is inert metadata, not proof of ownership, a durable enrollment, or
an authorization token. Older binaries ignore it and can discard it on their
next checkpoint rewrite, so mixed-version operation cannot preserve it. A
checkpoint rename can also succeed when syncing the containing directory fails;
the existing writer logs that failure rather than establishing a fully durable
enrollment. Do not use this field to enable delegated delivery, queue recovery,
or any other security or lifecycle decision until the required boundaries are
implemented and verified.

New session checkpoints use a no-clobber publish operation: an already existing
checkpoint at the chosen session ID cannot be overwritten by creation. A local
four-process regression verifies one winner for the same ID. This is only a
collision guard; session creation still generates a fresh ID for every request,
does not bind retries to the same inputs, and does not make a directory-sync
failure a confirmed durable commit.

The test-only `structured::start` experiment reserves an owner-scoped request
and its exact creation inputs, including the first prompt, before a checkpoint
is created. It preallocates the session ID and incarnation; matching unfinished
requests remain held, conflicting inputs are rejected, and completion requires a
caller-supplied checkpoint verifier. Focused tests cover separate-process races,
process exit after reservation, corrupt or symlinked storage, and checkpoint
deletion without reallocating the completed request. This is not an API or a
browser start flow. It assumes a stable private local data directory with
working locks and sync; old servers do not cooperate. It has no trusted
bootstrap identity for detecting a missing or rolled-back ledger, and the
verifier must retain the independently established session lease through commit.
Completed records do not prove a session still exists; an eventual route must
check that identity and leave deleted or uncertain results held. The prototype
caps each owner's records at 4,096 and does not evict them.

The event-writer recovery path now compares the stored incarnation as well as
the owner and public snapshot before rewriting a checkpoint. This prevents a
recovery from replacing a missing or changed incarnation with its in-memory
value. The focused storage tests cover matching, changed, missing and legacy
values. Before using the field as an ownership boundary, test those cases under
the session lease, including old-reader rewrites and restart recovery.

The test-only detached-delegation path now persists an exact held-to-running
task claim before launching a read-only child, and serializes a cooperating
task cancellation with that launch. An owned supervisor drains bounded output,
waits for confirmed process-tree cleanup, and persists a terminal result only
after verifying the child's output and exit status. A dropped start receipt
does not abandon a supervisor retained by its caller. The outbox can bind the
current queue revision under the parent lifecycle and queue gates immediately
before its first delivery attempt. Once an attempt is durable, its mutation
remains immutable: a missing receipt stays uncertain, and a matching committed
receipt can be reconciled without another enqueue. Tests cover cancellation,
lost acknowledgements, manual and restart holds, concurrent parent deletion,
and child-result verification. A successful delivery wakes a running, idle
parent queue; admission closing during delivery prevents a new wakeup. Busy
parents and manually or restart-held queues remain subject to their existing
resume behavior.

These pieces are not a production detached-delegation flow. The application
does not retain such supervisors or deliver their outcomes to a parent, and
the queue gates alone do not establish cross-process actor ownership. A crash
between child-result proof and durable task settlement can require manual
review. Existing process-tree tracking cannot prove containment of a child
that escapes before observation. Older binaries do not honor the new fences.

When an actor has a storage cursor, ordinary checkpoint rewrites hash the bounded
current file before publishing and require it to match the writer's committed
checkpoint and journal. On Unix the file must also have private permissions.
This permits an identical restored file while rejecting removed, changed or
insecure files in the tested sequential cases, including same-size edits on the
same inode. Event appends check identity and length, and hash the history when
its modification/change timestamps differ from the writer's last observation
or are unavailable. Unchanged timestamps are not proof that content is unchanged
on every filesystem. The separately validated event-recovery path retains its
existing recovery behavior. None of these checks is atomic with the subsequent
write or fences another manager, provider, or process. Initial history loading
can still rewrite a live actor's history; the ownership boundary and quiescence
requirements below remain necessary.

Owner loading validates and prepares all discovered histories, including the
size and event limits of each recovered checkpoint, before it rewrites
checkpoints or removes duplicate legacy files. A malformed later history, or
one whose recovery would exceed those limits, therefore cannot rewrite an
earlier history during the failed load.
The subsequent writes are not a transaction: an I/O error or process failure
can still leave a partial recovery, and another process can change files between
validation and writing. This ordering does not establish session ownership or
confirm that a previous actor has stopped.

A test-only existing-install inventory can inspect one authenticated owner's
current checkpoint directory without writing session files. It validates each filename,
owner binding, file identity and complete history; preserves existing
incarnations; records missing incarnations for later migration; and detects
different current file identities or contents when revalidated. A change that
is fully reverted on the same inode is not detected. Legacy raw-history
directories are rejected for manual migration instead of being silently
omitted. This inventory is not connected to enrollment or the runtime and does
not prove that a server, provider or descendant has stopped. It assumes a stable
private local data directory, and revalidation is not atomic with any later
migration action.
An independently enforced offline/quiescence boundary, production migration
intent and recovery, and handling of legacy raw histories are still required.

A test-only migration-intent prototype records the complete reviewed inventory
in a bounded, owner-scoped intent file. Two entries in an anchored enrollment
journal bind that file's SHA-256 digest to the owner and operation. The first
journal entry is synced before the intent file, and the second entry is synced
before preparation is reported. On reopen, a fully
bound record is checked against the current inventory; a changed inventory is
reported separately, and missing, damaged or partially bound records remain
held. An interrupted journal or anchor update can instead make opening fail
closed and require manual recovery. No path in this prototype writes or creates
session history. The caller must supply an authenticated owner and an
independently reviewed inventory.

The test-only intent service also has an explicit repair operation for a valid
anchored journal with a completed first binding and no second binding. It
requires the same owner, operation and independently reviewed inventory: the
payload must match any existing intent file and the first 128 bits of its
SHA-256 binding, and the inventory is revalidated before finalizing the second
binding. An interrupted repair can be retried with the same review; a missing
payload after both bindings have committed, a conflicting payload, an orphaned
binding, a changed review, or an unstarted operation cannot be silently
recreated. Separate-process fixtures cover interruption before and during repair
without writing session history. A journal or anchor interrupted inside an
append may still fail closed and need manual recovery.

These operations do not authorize migration or establish that older servers and
their descendants are stopped. The anchored
bootstrap still only supports a fresh empty root, so this is not yet an
existing-install migration flow. It assumes stable private local storage,
cooperating processes and intact journal/anchor state; rollback of the entire
storage to an earlier consistent state and same-user path-swap races are not
prevented. Intent files are capped at 128 and journal entries are retained;
there is no retirement or space-reclamation procedure yet.

## Ownership boundary

A Unix owner-scoped live-manager guard is being integrated. Its current
`structured::live_ownership` module is not bound in production: normal session
loading and API operations do not yet acquire it. It binds a private lock file's
identity to the owner and data-root identity in the local SQLite database. A
cooperating manager holds the OS lock and persists a fresh unconfirmed epoch
before admission; only an explicit release after confirmed actor and process
cleanup marks that epoch clean. A missing, replaced, insecure, or damaged lock
does not get silently recreated. This guard serializes an entire owner's
sessions, so a second current-version manager using that owner and data root
would be unavailable while the first holds it; different owners are independent.

After an unclean release, inspection reports the unconfirmed epoch. An explicit
owner-authenticated review can acknowledge that cleanup remains unverified;
the acknowledgment and its exact operation ID are durably recorded as
`cleanup_unconfirmed` before the same epoch is made available again. Repeating
that operation is idempotent, while stale epochs, different review operations,
and a still-live manager are rejected. This review neither stops old processes
nor proves that they have stopped, and it must not replay interrupted turns or
clear queue holds. A user-facing recovery flow must explain those limits and
require the user to stop or review old processes before acknowledging. A
partially provisioned lease, unreadable state, or a torn marker stays held; it
is not repaired by this acknowledgment flow.

The experimental manager refuses to bind ownership after any unfenced actor
admission. Its guarded instances also use distinct queue epochs, so a recovered
manager in the same process establishes the same restart hold as a new process.
The experimental delegated-result delivery and receipt-confirmation paths require
the parent manager's live ownership lease before loading the parent or changing
the queue or outbox receipt. The parent lifecycle and queue gates remain held
through each corresponding operation. These checks do not by themselves enable
or complete production ownership or background delegation.

A separate test-only owner admission gate models per-owner cleanup holds.
It invalidates previously issued admission tickets, waits for that owner's
admitted work and cleanup callbacks, and requires the same hold identity and
zero in-flight work before reopening. Another owner's work stays independent.
The gate is process-local and is not connected to HTTP authentication,
paired-device admission, session actors, or logout. To use it safely, the
application must bind the ticket to a freshly revalidated credential and hold
the permit through each admitted action, coordinate all cooperating processes,
and retain failed or abandoned cleanup holds until explicitly resolved.

The marker's integrity check detects incomplete state/epoch writes, but is not
protection against a malicious actor able to rewrite it. The registry assumes
an intact local SQLite database, stable private data-root and lock identities,
working OS locks and synchronization. Whole-storage rollback, missing database
records, old binaries that do not honor the lock, filesystems with unsuitable
locking, and processes that escape cleanup are not fenced. In particular,
acquiring a lock after a crash is not evidence that prior processes terminated.
The guard must not be enabled for ordinary session loading until the actor
lifecycle and authenticated review UI are wired and verified together.

`load_user_sessions` loads and rewrites every owned session, and can append interrupted outcomes for turns with no terminal record. It must acquire ownership before recovery or migration, not only before first send. `submit_codex`, V4 submit/commands, native send/input, context and approval mutations, metadata updates, event callbacks, hold/drain/reconcile, interrupt, deletion and shutdown all mutate or rely on actor state. A lease held merely while a queue file is mutated cannot fence these operations.

A persistent owner/session lease should be tied to the exact authenticated owner and exact stored session identity in a stable canonical data-root identity. Legacy simple and hyphenated session IDs, including uppercase spellings, must retain their exact identity where their existing history records are distinct. Case-insensitive filesystems can conflate spellings: envelope validation must reject a mismatch instead of accessing another session's queue. The owner scope must be authenticated before creating a lock. Use safe, private, persistent lock objects whose identity cannot be replaced or unlinked while in use; acquire using OS cross-process locking, verify fd/path device/inode and scope, and fail closed on unavailable locking or unsafe directory identity. Do not remove a lock object on release. Existing older binaries do not honor a new lease; mixed-version concurrent writers require an enforced single-version deployment boundary, not just an advisory lock in the new code.

## Session list and get reads

`GET`/`HEAD` on `/api/structured/sessions` (including `?view=inventory`) and
`/api/structured/sessions/{id}` validate the caller's local or paired credential
before the lazy owner load and again after every wait that follows it. Lazy
recovery (appended interrupted outcomes, checkpoint rewrites, legacy-file
removal) re-validates immediately before each checkpoint rename and each legacy
removal, and the loaded sessions are published to the manager only after a
further check. A revoked request therefore leaves later checkpoints unchanged
and does not mark the owner loaded. Credential validation and each recovery
write run inside the same authentication transaction, so logout cannot
interleave inside one write, but recovery is not atomic across files: a
revocation between two checkpoints leaves the earlier one already recovered
(recovery is idempotent and is repeated by the next authorized load). The
checkpoint temp file and the directory permission normalisation happen before the
pre-rename check; a refused write removes its temp file. A session deleted while
a read waited on its state is omitted (list) or reported not found (get). The
delegated-result recovery that a read schedules starts only after the final
check and is then governed by the owner-cleanup fence, not per-step credential
checks. Tests: `structured::session_read_auth_tests`.

## Lifecycle and integration

1. Acquire before reading/recovering each persisted session. If unavailable, do not perform recovery or modify its history; provide explicit unavailable/read-only behavior that does not present cached state as authoritative. Do not block loading unrelated owned sessions. New sessions need lease acquisition before first durable creation.
2. Keep one lease for the complete lifetime of each live actor, across async callbacks, queue admission and dispatch, reconnects, and active provider work. Lease object must remain owned during deletion, stop, resource cleanup, and durable terminal receipt persistence; do not release if process cleanup is unconfirmed. Keep lock order consistent with session lifecycle, state, dispatcher and storage to avoid deadlock.
3. On takeover, reload the authoritative durable snapshot under the lease before serving mutations. Determine whether previous provider subprocesses can survive the server process and prevent overlapping side effects; interrupted/unknown outcomes must remain held for reconciliation rather than replay. Confirmed process exit alone must not be confused with confirmed cleanup of descendants. Recover stored queue reservations against canonical receipts while preserving restart and manual holds.
4. Fence all paths that write or act on session state, including direct Codex `send_input`, callbacks and metadata changes. Ensure cached objects held by another manager cannot be used after ownership loss. Protect parent deletion against late child completion and prevent deleted-session revival. On shutdown, stop intake, await actors and resource cleanup, save outcomes, and only then release leases. Process crash releases OS locks but does not establish subprocess cleanup or permit safe immediate takeover.
5. Resolve data-directory symlink/rename changes by pinning and validating root identity over the lease lifetime. The queue store's current path re-resolution after acquiring its directory lock assumes a stable root; inode locking alone does not make retargeted aliases safe.

## Verification gates before exposure

Use actual separate processes, not just manager instances. Cover same request and conflicting payload races, same owner/session exclusion, independent owners/sessions, alias paths, historical ID spellings, absent and unsafe roots, lock replacement and restart. Exercise recovery racing an active turn; delete versus submit, callback, queue admission and child delivery; stop and graceful shutdown; process exit with surviving children; failure before/after durable acceptance and queue reconciliation; retained manual/restart holds; stale cached manager; malformed, foreign, or deleted identities. Confirm no duplicate provider start and preservation of the exact durable receipt across restart. Keep native queue endpoints disabled until these integration checks pass. Validate Unix and Windows semantics separately and report unsupported configurations.
