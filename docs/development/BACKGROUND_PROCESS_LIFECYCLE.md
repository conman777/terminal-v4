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

Before enabling the tools, finish fresh-install provisioning without recreating
lost state, complete a durable cross-process session actor fence,
define scoped completion and output handling, and provide a recovery policy that
accounts for escaped or otherwise unconfirmed processes. Validate
platform-specific behavior; the lifeline is implemented only on Unix, and the
existing receipt implementation fails closed outside Unix.

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
Durable receipts, kept for replay protection until the session is deleted, are
capped at 32 per session, 64 per owner and 128 in total so one session or owner
cannot exhaust the shared budget. A refused start asks for no approval and claims
no receipt. Failed-to-start, denied-after-claim and cancelled-before-launch claims
still consume a receipt until their session is deleted.

After a restart the actor reads durable outcomes (exited, cancelled, timed out,
failed to start) from the ledger. A claim a crash left unfinished is reported as
unknown, cannot be cancelled, blocks all new background starts until an
authorized review attests it, and keeps shutdown reporting unconfirmed cleanup.
Completion is observed by polling status or wait; the terminal outcome is
committed once and later cancel, wait or status calls cannot change it. There is
no push delivery to the agent or the thread's settlement state when a command
finishes.

The current owner gate holds an SQLite write transaction while invoking the
spawn callback. Local Stop and unrelated authorization operations also need a
write transaction on the control database, so a stalled callback can delay
them even though cancellation admission itself fails fast. Before enabling
background tools, redesign or bound this launch boundary without weakening
revocation and cleanup guarantees, and verify Stop and unrelated authorization
under a stalled launch. A focused owner-gate test demonstrates database lock
contention; it does not demonstrate an end-to-end Stop outcome.

On Unix, deletion holds a shared provisioning lock and an exclusive hashed
owner/session stripe until it finishes. First provisioning holds the same
provisioning lock exclusively. Unrelated deletions can usually continue while
another deletion waits; a stripe collision fails closed with a retry. There are
at most 65,536 persistent stripe lock files and one provisioning lock file.
An unsafe lock path also fails closed, and the operating system releases locks
when their owner exits. These locks prevent the absence check from racing a new
installation, but do not prove that a stale session actor in another process
cannot launch after deletion. They assume a private, stable data directory, and
older binaries do not honor them.

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
