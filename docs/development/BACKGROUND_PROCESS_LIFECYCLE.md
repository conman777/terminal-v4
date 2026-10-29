# Background process lifecycle prototype

The Unix runtime reopens and retains an existing background-process manager;
it does not provision a fresh installation or expose background command tools.
An unavailable or remotely owned existing manager makes session deletion fail
closed; a later deletion attempt can reacquire the existing ledger after its
remote owner exits. Its implementation
starts each approved command in a new session and keeps a
lifeline pipe open while the worker owns the process. A small monitor in the
original process group kills that group if the pipe closes, including after an
abrupt host-process exit. The command receives null standard input. Its exit
status travels over a separate channel; the supervisor remains alive until the
worker stops and reaps the group.

This lifeline is best effort, not containment or proof of cleanup. A process
can leave the original group, interfere with its monitor, or take actions before
the monitor runs. A host crash leaves the durable claim `Unknown`; reopening
does not signal a saved PID, replay an action, or allow new actions. Neither the
command nor captured output is persisted, and arbitrary output is withheld.
The monitor does not make an unknown receipt safe to clear.
An explicit authorized review can still attest an unknown receipt after a
shutdown attempt reports unconfirmed cleanup; the stopped manager remains
closed to new actions, and a later shutdown attempt can verify the review.

The test-only tool layer includes a separate reviewed-output action. Status and
wait withhold process bytes. The output action shows the owning user the exact
bounded stdout/stderr snapshot and returns only that approved snapshot to the
agent; denial, cancellation, another owner's scope, or session retirement does
not release it. Output is held in memory only and cannot be recovered after a
restart. This action is not registered in the production agent.

A test-only provisioning experiment stores an `initializing` marker in the
application SQLite database before creating the ledger, and marks it `ready`
only afterward. A missing ledger with an intact marker, another live owner,
or an interrupted initialization fails closed. The experiment assumes the
database and marker remain intact and are not rolled back; it is not connected
to application startup and does not establish cross-process authorization or
cleanup. On Unix, the original ledger owner explicitly releases its locks on
drop so a forked child cannot accidentally retain them; a child cannot release
the parent's locks. This is not confirmation that a child process has stopped.

Before enabling the tools, call `bootstrap::open_or_provision` at trusted
startup (it exists, is tested for restart, crash-in-the-middle and lost-state
refusal), call `recover_unconfirmed` once before accepting launches, wire a
completion consumer, and consult `session_has_outstanding` from thread
settlement. Validate platform-specific behavior; the lifeline and the recovery
policy are implemented only on Unix, and the existing receipt implementation
fails closed outside Unix.

The structured-session launch actor is test-only. It requests a decision
through its bound structured approval gate and produces a private, single-use
start receipt only after approval. The receipt retains the prepared command,
workspace, credential generation, durable session incarnation and expiry; the
action ID is derived from the bound turn and tool-call ID. Start revalidates the
actor, credential, session and cancellation state. The actor rejects an ungated
manager or one whose retained owner-control database and receipt ledger do not
match its data root. It records the workspace directory's device and inode before
approval and rejects a different directory at that path when approval or launch
is attempted. These checks assume a stable, private data root and workspace: a
hostile same-user swap between the final identity check and the operating-system
spawn is not prevented.

The agent loop reaches commands only through that actor. Each structured V4 turn
binds a per-turn actor to its resources; the tool layer has no other path to the
process manager, so start, status, wait, cancel and output review all use the
actor's approval, owner-generation, credential-expiry, session-incarnation and
checkpoint fences. The older direct-manager wrapper is kept only for manager-level
tests and is not reachable from the agent loop. A test drives a scripted provider
through a real turn (launch, status, wait, cancel, reviewed output) with approvals
decided through the structured approval route. Status, wait and cancel use
incarnation-scoped action keys, verify the live session and checkpoint, and
recheck the owner generation, credential expiry and cancellation at the final
read or signal. Wait checks the actor again after completion. Output review shows
the user the exact bounded stdout/stderr snapshot, then re-fences immediately
before returning only the approved bytes; logout, a changed session incarnation,
expiry or denial release nothing. Output exists only in memory and is unavailable
after a restart. Existing unscoped receipt keys retain their original format; a
new scoped action refuses to reuse an existing legacy key. The reverse is not
guaranteed: an older or unscoped caller cannot detect a scoped receipt, so it may
replay the same action after a downgrade. Retirement remains scoped to owner and
session ID, so a recreated session with the same ID is held rather than reopened.

Capacity is refused before approval or any durable claim. Live processes are
capped at 8 per owner and 32 in total, counted from tracked entries that have not
finished, so a slot returns as soon as a worker commits a terminal outcome.
Durable receipts are capped at 32 per session, 64 per owner and 128 in total so
one session or owner cannot exhaust the shared budget. When a claim would exceed
a cap, the ledger first prunes the oldest finished receipts (exited, cancelled,
timed out, failed to start) in the affected scope, in one transaction with the
claim. It never prunes a running or unknown claim, a reviewed-unknown claim, or
any of a session's newest 8 receipts. A scope full of unfinished claims is still
refused. Pruning gives up replay protection only for old finished actions of a
still-open session: replaying one needs the same incarnation-scoped action key,
which exists only inside a completed turn's actor and still needs a fresh
approval. Retired sessions keep full replay protection. A refused start asks for
no approval and claims no receipt.

After a restart the actor reads durable outcomes (exited, cancelled, timed out,
failed to start) from the ledger. A claim a crash left unfinished is reported as
unknown, cannot be cancelled, blocks all new background starts until an
authorized review attests it, and keeps shutdown reporting unconfirmed cleanup.
The terminal outcome is committed once and later cancel, wait or status calls
cannot change it. After the ledger commit, the manager publishes a
metadata-only completion hint (scope, action ID, outcome; never the command or
output) on a bounded broadcast channel (`subscribe_completions`). That channel
is lossy and per-process. For a durable path, the terminal outcome and a
pending-completion marker (owner, session, workspace, incarnation, action ID,
outcome; no command or output) are committed in one ledger transaction, also
for outcomes resolved by recovery. `pending_completions()` peeks at up to 64
markers in order; `acknowledge_completion(seq)` removes one and returns true to
exactly one caller; `drain_pending_completions()` takes up to a page
atomically so concurrent drainers receive disjoint markers. Markers survive
restart. Markers are bounded by the receipt caps: pruning a finished receipt
or retiring its session also deletes its marker, so a marker that nothing
drained can be dropped; the ledger via status or wait stays authoritative.
Delivery after `drain` is at most once, so a consumer that must not lose a
notice should peek, inject, then acknowledge. Nothing in the agent loop or queue
consumes markers yet: a future delivery step must check owner, session
incarnation and checkpoint before injecting a completion notice, and must never
inject output without the reviewed-output action. `session_has_outstanding(owner, session)` is a read-only ledger query,
true while any command in the session is running or has an unreviewed outcome
(including after a crash) or the manager has unconfirmed cleanup. It is not yet
called by thread settlement: structured.rs must consult it next to
`parent_has_outstanding` in the settle branch of the thread update
(refusing settlement on true or on error) and in the inventory lifecycle
projection where `delegation_quiet` is computed.

Launch admission no longer holds a control-database transaction (or the gate
connection) while the spawn callback runs. `OwnerGate::admit_launch` checks the
owner hold and authorization generation in one short transaction, releases it,
runs the launch, then repeats the check. A hold or generation change in
between, or a launch that overran its budget (10 seconds), is reported as
`Revoked`: the child is still tracked and cancelled, its receipt reaches a
terminal `cancelled` outcome, and the manager is not poisoned. Only a failed
second check (database error) is `Uncertain`, which keeps the existing
fail-closed behavior (manager-wide unconfirmed). Holds cannot be acknowledged
while the claim is unfinished, because the claim is durable before the launch
and the acknowledgment requires every owner claim to be terminal. The short
`admit`/`admit_generation` forms remain, for in-memory status and cancel
closures only. A test proves that, with a launch stalled inside the callback,
a local Stop hold, another owner's hold, an unrelated authorization check and an
unrelated write transaction all complete in well under two seconds, and that
the late child is then stopped and recorded as cancelled.

Remaining limits: the spawn itself cannot be abandoned (the callback borrows
the command), so an over-budget launch is detected after it returns rather than
interrupted. The launching `start` call still holds the manager's registry
lock, so status, cancel and owner-hold servicing on the same manager wait for
that one launch (fail-fast actor paths return "busy; retry" instead).

On Unix, deletion holds a shared provisioning lock and an exclusive hashed
owner/session stripe until it finishes. First provisioning holds the same
provisioning lock exclusively. Unrelated deletions can usually continue while
another deletion waits; a stripe collision fails closed with a retry. There are
at most 65,536 persistent stripe lock files and one provisioning lock file.
An unsafe lock path also fails closed, and the operating system releases locks
when their owner exits. These locks prevent the absence check from racing a new
installation. They assume a private, stable data directory, and older binaries
do not honor them.

A separate durable session fence (`background_session_fence.rs`, under
`<data>/.background-session-fence/`) closes the stale-actor gap. Every launch
takes an exclusive hashed stripe lease and checks for a tombstone before the
claim; `retire_session` writes the tombstone (created exclusively, file and
directory synced) after the ledger retirement and under the same lease. A
launch in flight in any process therefore makes retirement fail with a retry,
and after retirement no actor in any process can launch for that owner/session
even if it still holds a stale in-memory view. The tombstone is permanent and
capped at 4,096. It is enforced only when the ledger lives under
`<data>/background-processes` (the provisioned layout); callers must run
retirement as the last step of deletion and treat an error as a failed delete.
Two-process tests cover a holder blocking retirement and a retired session
rejecting later launches. Stripe collisions fail with a retry rather than
waiting.

Recovery of unconfirmed processes. After each spawn the ledger records the
supervisor PID, process group and OS start time (macOS `proc_pidinfo`, Linux
`/proc`) beside the claim, and removes the identity in the same transaction as
the terminal outcome. Reopening still never signals anything and keeps the
claim unknown. `recover_unconfirmed()`, run once at trusted startup before
launching (it skips entries this manager owns), applies this policy to every
unreviewed unknown receipt: PID alive with the same start time and process
group, then SIGKILL the group and wait for it to vanish, record `cancelled`
(`killed`); PID and group both absent, record `cancelled` (`group_empty`;
the real exit status is unknown); a different start time or group
(`identity_mismatch`), a leader that is gone while group members remain, an
unreadable process, or a signal/wait that does not complete (`unverifiable`),
and a receipt with no recorded identity (`no_identity`) are left unknown, are
never signalled, and still need authorized review. The outcome is kept in a
recovery table. Descendants that left the process group, a crash between spawn
and the identity write, and a kernel that cannot report a start time are not
recoverable and fall into the review path. A real-subprocess test aborts a host
process that leaves a detached process group, then recovers it; others cover
mismatch, missing identity, an already-stopped group, and surviving members.

Session cleanup closes admission and signals the session's processes while
holding the registry lock, then releases that lock while it waits for their
terminal outcomes. A stalled cleanup therefore does not by itself block another
owner's background process operations; it still keeps the affected session
closed until cleanup and any retirement are confirmed.

A controlled manager can now use a shared SQLite owner hold. A cooperating
server persists a scoped request; launch admission and hold creation serialize
through SQLite's write lock. The ledger owner cancels that owner's processes,
waits for their durable terminal receipts, and only then acknowledges the same
request. The hold continues to reject starts after acknowledgment. An unknown
receipt keeps its owner's request held; another owner's cleanup can proceed.
The controlled manager also offers a supervised polling loop, but no production
service starts it yet. Holds are capped at 4,096 and never silently evicted.

The command tools remain test-only; manager reopening and reviewed logout
cleanup are available in the Unix runtime. All cooperating servers must use the same intact, durable
control database and the one retained ledger manager; the trusted bootstrap
must create the control table only once and must not recreate lost state. The
caller must authenticate the owner and derive its scope from trusted session
context, supervise the monitor, treat a stopped monitor or missing response
as unconfirmed cleanup, and retain the hold through reauthentication until a
separately authenticated release is designed. Old binaries do not honor this
gate, and the design does not protect a rolled-back database or a swapped data
root. The new owner-scoped receipt field means old experimental ledger schemas
fail closed and require explicit migration. Deletion also needs the separate
structured-session actor fence. Production tools remain disabled.

The test-only same-process coordinator can use one exact logout request ID for
the background hold and validate an instance-bound cleanup receipt before
removing that hold in the coordinator's transaction. A lifecycle guard must be
retained until the transaction commits. The proof checks the retained control
database identity and rejects stale managers and unknown outcomes; it does not
prove liveness of a manager owned by another process.

An independent Unix quiescence verifier can instead validate an exact
owner/request acknowledgment bound to the canonical background ledger's root,
guard, lock and database identities, then remove that hold in the caller's
existing authorization transaction. Before acknowledging, the manager drains
its owner entries, rejects uncertain outcomes and checks the ledger for
nonterminal owner claims; the verifier repeats the owner-ledger check read-only
and rejects a pending journal, missing receipt, changed identity or renewed
hold. A cooperating remote manager may exit after its durable acknowledgment:
the unchanged hold must prevent every subsequent launch until release. This is
evidence of quiescence, not proof that the remote manager remains alive, and it
inherits the existing process-tree and escaped-descendant limits. Legacy or
alternate ledger layouts do not produce this remote proof. An existing ledger
without the new receipt table fails closed until explicitly migrated; it is not
silently recreated. The verifier is not yet wired into production logout and
must not be used to bypass the structured or delegation cleanup requirements.
All cooperating processes must honor the same durable hold. These identity
checks assume intact, private, stable local storage and do not protect against
database rollback or a hostile same-user swap and restoration during SQLite
open. Old binaries do not honor the hold protocol.

A crash-unknown claim can now be attested without a logout cleanup request.
`review_unknown_owner_standalone` runs inside the same owner-review
transaction as the cleanup flow (live direct credential, auth-generation and
admission checks, tracked processes terminal, ledger identity unchanged) and
persists the same audit row. It requires that the owner has no background or
structured cleanup hold; a held owner must use the cleanup review. Because the
control-database write transaction is held, launch admission cannot interleave.
The request identifier is `standalone-<operation>`, and a retry of the same
operation is idempotent. The review never replays the action or proves that a
process stopped; it only lets new starts proceed. No HTTP route or UI calls it
yet. A route would mirror `review_background` in structured/ownership_recovery.rs
(direct `LocalAuthority`, explicit acknowledgment, operation ID) and call the
function on a blocking worker through the structured manager's bound background
manager, and the owner-cleanup recovery panel would need a standalone entry
point showing the owner's unknown count (`owner_cleanup_unconfirmed`).
