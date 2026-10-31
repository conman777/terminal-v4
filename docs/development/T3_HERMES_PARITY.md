# T3 and Hermes feature parity

This is a working inventory, not a claim of complete parity or live deployment.
Compare V4's observable behavior, permissions and recovery against the reference
feature, then verify it in the integrated application before marking it done.
Source-only observations can become stale in the shared checkout.
Detailed scoped mappings live in the [T3 capability matrix](T3_CAPABILITY_MATRIX.md)
and [Hermes capability matrix](HERMES_CAPABILITY_MATRIX.md).

**This snapshot is work in progress and is not ready to deploy.** Seven
cross-tab authentication regressions remain: a refresh can publish credentials
after another tab signs out or changes accounts. The stricter session authority
is experimental and remains unmounted. Terminal HTTP input now rechecks the
credential after request admission, but that check is not atomic with the
subsequent asynchronous PTY write; terminal WebSocket input also needs its own
effect-boundary review. The complete frontend suite has not passed on this
snapshot: a November 1, 2026 run reported 5,006 passes, nine failures and 78
skips; seven failures were the authentication races. The other two System
Resources cases passed when rerun separately. Strict Clippy (`-D warnings`)
reported 161 errors and is not a passing release check. See
[authentication authority status](AUTH_AUTHORITY_FIRST_PHASE.md) before
attempting a coordinated update.

Reference points:

- T3 web source: commit [`5f64c5eb299a23d278ef043c416bd4dc801bc53c`](https://github.com/pingdotgg/t3code/tree/5f64c5eb299a23d278ef043c416bd4dc801bc53c).
- Hermes project baseline: commit [`79651b71bd56efd76d06f3de1df64dde09b58ff3`](https://github.com/NousResearch/hermes-agent/tree/79651b71bd56efd76d06f3de1df64dde09b58ff3).
- Newer Hermes reference: [v0.22.5](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5), including its [tool reference](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/website/docs/reference/tools-reference.md).

The available T3 phone-screen reference is native source; it does not establish
the behavior of T3's mobile browser. Expand this inventory across the reference
releases, configurations and integrations before declaring full coverage.

## UI and conversation

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Desktop and mobile navigation | Thread navigation, saved-message search and mobile sign-out are implemented in source. Phone-width fixture checks cover sign-out and same-account text draft recovery. | Verify integrated workflows and exact-match behavior. Terminal output and legacy messages without IDs cannot jump to an exact position. |
| Mobile thread terminal | Desktop and mobile source provide a thread-owned terminal drawer. Isolated real-backend Chromium checks at 320 and 390 pixels cover PTY input, thread switching, reload, restarting an ended shell in the same terminal, and draft preservation. Scoped retries preserve other terminals after out-of-order failures, and an add failure does not hide a working terminal. Mobile users can close the selected terminal with a confirmation; isolated 320px and 390px real-PTY tests preserve the conversation draft and verify the terminal disappears from inventory using a freshly built current backend. On Unix, HTTP create, restore and thread-link updates acquire the owner lock after the terminal lifecycle wait and retain it through their operation, ordering them with cooperating logout and paired-grant revocation. A disconnected request is rechecked before launch; if a final check fails after publication, a newly restored shell is stopped while the thread link and non-tmux history are retained. Existing tmux-backed restores retain their prior behavior of using the live tmux session for history. | This ordering assumes cooperating servers and a stable, lock-capable data directory. An operation that holds the owner lock too long can make logout or grant revocation time out and require retry. Credential expiry or client disconnection after the final check can still race publication, and a shell may perform work before cleanup completes. A link update already admitted for persistence may finish after its client disconnects. The retry handle for a created-but-unlinked terminal is kept in the tab's sessionStorage: it survives reload and unmount but not closing the tab, and another tab cannot see it. Only the first terminal of an empty thread is deduplicated across tabs; an unconfirmed create still needs manual review before starting again. Browser emulation does not establish physical phone keyboard behavior. |
| Mobile composer | Compact composer, dictation, file mentions, skills and supported Claude/Codex model controls exist in source. The new-thread input and send button were checked at 320 and 390 pixels. | Verify microphone and attachment behavior against real providers; compare remaining model and mode controls with desktop and the reference. |
| Conversation actions | Desktop and mobile have edit, fork and plan actions for supported Codex and Claude sessions, with draft preservation checks. | Verify real-provider behavior and remaining runtimes. |
| Thread lifecycle | Structured conversations can be snoozed for an hour and manually woken. Idle V4 conversations can be manually settled on supported Unix servers; a visible shelf preserves drafts and the server checks pending queue work, requests and unresolved delegated children. New user or queue activity wakes them, while a restart hold alone does not. Working threads remain visible while offscreen approval state is polled; renewed touch or other activity after idle requests a refresh. | Verify full integrated lifecycle and separately tracked requests; an approval indicator may lag until the next successful inventory refresh. Snooze now offers 1 hour, 4 hours, tomorrow morning and a custom duration. Automatic settlement exists for V4 conversations only, off by default (enable with `TERMINAL_AUTO_SETTLE_IDLE_SECONDS`), and settles only threads that are already provably quiet; native Claude/Codex and terminal sessions stay non-settleable and say why. Pull-request rules and terminal cleanup remain unfinished. The existing terminal activity heuristic is not sufficient for hiding threads. |
| Context and new threads | V4 supports slash commands, file mentions, bounded project-content search and worktrees with a chosen base ref. | Compare inline context workflows, attachment support and branch discovery with T3. Project-content search is Unix-only and does not jump to an editor line. |
| Queue and approvals | Pending decisions appear near the composer. Unix local and paired queue reads and mutations revalidate credentials after waiting; uncertain published mutations retain their operation identity. The queue panel offers explicit Wake and retained-receipt review. V4 and opt-in native Codex/Claude queues provide server-owned dispatch; the composer uses the server queue when available and labels any retained local entries separately. | Native dispatch remains behind the non-default `native-codex-queue-preview` and `queued-authority-preview` features plus provider-specific environment switches. The previews need integrated paired-credential and real-provider verification; separate-process execution and concurrent managers sharing one data directory remain unsupported. Unproven legacy and paired items lack durable dispatch proofs, and default Resume retains legacy authorization behavior. Key-installation holds, loss and migration limitations are described in [session ownership](STRUCTURED_SESSION_OWNERSHIP.md). Non-Unix read fencing is weaker; filesystem I/O under authorization fences can delay logout or revocation. Verify cross-device drafts. |
| Attachment drafts | Source changes retain selected file paths across thread and pane switches and recover path metadata after reload, scoped to the account, environment and thread. When another tab changes the saved selection, the composer keeps the current files and message, blocks sending, and lets the user compare paths and explicitly adopt the saved selection without overwriting it. Each tab also keeps a path-only session-storage copy, so its selection survives a reload after a conflict; accepting the saved selection replaces that copy. Cooperating current tabs serialize their shared localStorage comparison and write using an IndexedDB read-write transaction. When files are selected, final validation and submission initiation use that same lock; the composer blocks send while a save is pending and retains the draft if transaction storage is unavailable. A text-only submission does not need that lock. [IndexedDB transaction scheduling](https://w3c.github.io/IndexedDB/#transaction-scheduling) serializes overlapping read-write transactions. Isolated two-tab Chromium checks cover competing saves, recovery and reload at phone and desktop widths. Five phone-browser checks passed against the current frontend and an isolated current backend, including a real two-tab send conflict; the attachment endpoints and structured conversation events were mocked. | Verify real-provider attachment behavior and browser behavior on other engines. Older tabs do not use the lock and can still race a new tab. A tab's recovery copy is lost when the tab is closed. After a submission is admitted, later file changes do not cancel the already-started request; its selected paths are fixed. Restored paths may have changed or disappeared. One intermittent mobile browser assertion remains unexplained. |

## Agent runtime

Automatic-settlement sweeps use bounded, separate slots for each owner and
canonical data directory. A running or cancelled sweep releases its slot;
automatic settlement remains opt-in and limited to supported V4 conversations.

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Delegation | Unix V4 source exposes approved read-only foreground single and parallel investigations, and can expose background delegation when its supervisor is available. See [runtime delegation](../features/V4_RUNTIME.md). | Synthetic-provider tests cover reviewed approval, enforced read-only child tools, delivery, cancellation, logout, restart and deleted-parent handling. Finished-but-undelivered results are included in the cleanup review and displayed by its UI; recovery of unfinished children still needs the owner's review. Local and attested paired results can wake an idle parent while authorization remains valid; manual and restart holds remain in place. Two loopback APIs cover paired proxy delivery, graceful restart and explicit recovery after killing an active child supervisor. Live-provider and physical-device behavior remain unverified. A child lifeline detects supervisor death but not a stopped supervisor; the ledger retains tombstones for pruned delivered records. Compare writable delegation only after a separate permission design. |
| Background commands | The tools (`background_start`/`status`/`wait`/`cancel`/`read_output`) are registered in the Unix agent turn only when the server starts with `TERMINAL_V4_BACKGROUND_COMMANDS=1` (default off; never offered to read-only delegated children). Startup recovery, session retirement, reviewed unknown outcomes and a scoped metadata-only completion consumer are integrated. Scripted-provider turns and isolated HTTP/subprocess tests cover approval, ownership, restart, deletion and logout; see [background lifecycle](BACKGROUND_PROCESS_LIFECYCLE.md). | Verify live-provider behavior and assess the documented operational limits before enabling. This is not an OS sandbox: descendants that leave the process group are unreachable. Output is retained only in memory for the newest finished commands; lifecycle-lock collisions can produce a retryable busy response. Windows is unsupported. |
| Logout and admission | Unix source orders local V4 message publication against logout and includes a structured-session, delegation and background cleanup coordinator. Thread metadata and title PATCH routes, and Stop, have scoped post-wait authorization checks in source. An uncertain title update is reviewed after a no-cache refresh before another same-tab write. | Verify integrated startup, recovery and cross-process cleanup. Structured list, get and inventory reads revalidate local and paired credentials after every wait, before each recovery checkpoint and before publishing, and omit sessions deleted mid-read; recovery is not atomic across checkpoints and a session whose delete is still in flight is not hidden. Browser and MCP resources still use process-local logout cleanup. The fence assumes a private, stable data directory; the equivalent Windows boundary remains unverified. |
| Agent questions | The V4 structured runtime can request an owner-bound answer with choices or free text. | Compare Hermes question batching and presentation; unattended and CLI runs cannot answer. |
| Scheduling | One-shot, interval, named-zone calendar and cron schedules, reviewed agent creation, saved-skill jobs, status/error fields and opt-in owner-bound Telegram delivery exist in source. Real-process worker tests cover contention, takeover and shutdown. | Verify real-provider and real Telegram delivery; script jobs, other delivery channels and Hermes cron providers remain unimplemented. A worker-protocol marker protects newer data from older workers, but older binaries that rewrite a store can drop new fields. A checkpoint already in progress can delay shutdown; old and new workers must not share a data directory concurrently. See [worker upgrade](WORKER_UPGRADE.md) for the journal and at-most-once delivery limits. |
| Memory, skills and recall | Reviewed memory, optional on-demand skills, bounded recall and compaction exist. | Compare learning, snapshot timing, search quality and compaction options; retain owner isolation and reviewed writes. |
| Browser, web and media | Approved browser/MCP operations and image inputs exist. | Inventory search, generation, audio, video and computer-use workflows and their credentials and platform requirements. |
| Messaging | Telegram gateway code exists locally. | Verify it independently and inventory other Hermes channels and delivery capabilities. |
| Providers and environments | V4 supports several provider protocols and local execution. | Inventory additional provider transports and execution environments, then test configured integrations separately from mocked protocols. |

## Third implementation wave (source evidence only)

Nothing here has run against a real provider, a real Docker daemon, a real Telegram bot or a physical phone.

- **Pull-request and git routes:** every `/api/workspace/git` and `/api/workspace/rewind` route authorizes the repository path against the file roots or the caller's own managed checkouts before any git or `gh` process runs. Pull-request actions are bound to the repository, PR number, URL and head commit, and merge passes `--match-head-commit`. A project outside the allowed roots needs its root added to `TERMINAL_V4_ALLOWED_FILE_ROOTS`.
- **Background commands:** registered in the agent turn behind `TERMINAL_V4_BACKGROUND_COMMANDS=1` (default off, read once at startup, operator decision). Verified through scripted-provider turns and real subprocesses; not an OS sandbox; no live-provider run.
- **`execute_code` and `run_command` backends:** `execute_code` runs under a macOS `sandbox-exec` profile where available (network denied, writes limited to the workspace and temp), otherwise with an accurately described best-effort Python guard. Docker uses tracked containers and cleanup, but has only been tested against a fake daemon. Production SSH selection is disabled: a loopback test confirmed that a remote command can continue after its client is killed, and remote cleanup cannot yet be verified.
- **Worktrees:** creation shows stages with a cancel that kills the process group and removes only what the run created. A repository `.v4/worktree-setup.sh` is not run unless the server sets `TERMINAL_V4_WORKTREE_SETUP_SCRIPTS=1`; a per-run review and approval flow is not built.
- **Terminal drawer:** horizontal splits with a resizable divider (desktop), tabs on mobile, terminal "Add to chat" on desktop and mobile, pull-request mentions, and worktree lineage. An isolated Chromium fixture exercised real xterm selection at 1280px and simulated touch at 320px and 390px while preserving drafts. Its terminal history was mocked; it was not a live PTY or physical-phone test.
- **Schedules:** the panel creates and describes cron schedules and falls back to schedule status/error fields when the linked task is unavailable. Results can be delivered to the owner's paired Telegram chat at most once (`deliverTo`), with a durable marker. `WORKER_PROTOCOL` is 2: an older worker refuses data a newer one wrote.
- **Recall:** an FTS5 index with journals, tombstones, restartable rebuilds and generation-bound cursors exists, default off (`TERMINAL_V4_RECALL_INDEX=1`), matching by token prefix rather than substring.
- **Queues and sharing:** the composer uses the server-owned queue when one exists, with edit, reorder, run-next, pause and optimistic rows. One-use, 24-hour, read-only conversation guest links use a separate narrow credential; guest messages are suggestions the owner must approve. Guest revocation and expiry are rechecked after waits, and proposal insertion is fenced to the session incarnation. Redaction is best effort: complete private-key opening markers are handled across messages and pages, but already delivered partial marker fragments cannot be recalled. Shares are not auto-revoked on owner sign-out.
- **Known pre-existing clippy errors** in `preview/proxy.rs` and `system_stats.rs` test targets were not introduced by this work.

## Audit follow-up fixes

- Stashed composer drafts are stored per account and environment; entries written under the old unscoped key are ignored, never adopted. A stash that cannot be saved keeps the draft in the composer and says so.
- A queue snapshot that already holds an enqueued item no longer shows a duplicate optimistic row.
- A terminal-close answer that arrives after the drawer was removed or switched to another thread no longer reopens that thread's drawer.
- Deleting a conversation checks background-retirement capacity before any irreversible step. A retirement record is written only once background commands have ever been enabled for the data directory (a durable marker), or the session has a background claim, so installs that never enable them can no longer exhaust the 4096-record limit. Installs that do enable them still stop at the limit, early and without partial deletion; recovery is an operator action described in the lifecycle guide.
- A refused task worker (newer data directory marker) is now reported: schedule capabilities carry `workerAvailable`, scheduling operations return 503, and the panel shows a banner. Status is per server process.
- Not addressed here: the file-preview defects (literal `?`, `#`, `%` filenames; empty-file paging) concern `ProjectFilePreview.jsx`, which exists only in an uncommitted checkout elsewhere and is not in this branch.

## Matched-build verification (browser emulation, scratch data)

A debug API and a frontend built from clean commit `c534e38` were served from scratch data on loopback with a synthetic provider. `node scripts/verify-deployment.mjs --url <base> --expect-commit c534e38 --dist <dist>` printed OK (commit, asset manifest and bytes matched; the tree was not dirty). The real app was then driven in isolated Chromium at 320, 390 and 1280 pixels. Passed at all three widths: login, empty state, thread creation, composer focus, multiline, send, stop and draft recovery after reload, approvals and questions, thread search, rename, pin and archive, mobile drawer and menus, thread terminals (create, switch, restore), terminal Add to chat, code highlighting and copy, citation chips, schedule create, enable, run now and pause, the provider modal's Azure fields, Files browsing, and no horizontal overflow.

Fixed during that pass: question-card actions were clipped under the composer in short viewports (now sticky like approval actions), file breadcrumb segments were narrower than 44 pixels on touch, citation chips were 20 pixels tall (now 24), and a missing or signed-out GitHub CLI no longer shows raw `gh` text in the pull-request row.

Gaps found in that pass and since closed: the mobile composer now has a Stash control and the mobile Git panel has the pull-request row and "Commit, push & PR" (same head-commit confirmation as desktop); the mobile drawer closes after Project tools and clears its search; the mobile Add to chat long-press reads the selection after a short settle so a wrapped first row works; provider setup is reachable from the new-thread screen ("Set up <provider>") and from a V4 thread's model chip; the thread details panel is closed by default; and the V4 thread terminal drawer no longer wastes about 87 pixels on the left. Mobile Git now distinguishes loading from an absent repository. An isolated Chromium fixture exercises real xterm selection with mocked terminal history, but not a live PTY or phone. Still open: the Set up flow was covered by tests with a mocked modal, not end to end against a real server; the Set up button is hidden in remote environments; plain terminals expose Control+M to switch Tab between shell input and focus navigation; screen-reader and physical-keyboard testing remains outstanding; the mobile `TerminalPane` stash and the new `useDraftStash` hook duplicate logic; and a real GitHub pull-request row and a physical phone were not exercised.

A cross-tab race was also fixed: in the fallback path used when the browser has no Web Locks, a tab that acquired the refresh lock before the other tab's rotated tokens reached its `localStorage` view could send an already-spent refresh token. A consumed-token ledger (fingerprints of the last eight spent tokens, written under the lock) now makes that tab wait up to three seconds for storage to catch up instead of replaying the token, and a server that answers with the same refresh token is not recorded as spent. The Web Locks path has the same theoretical staleness and is not covered.

## Reconciliation verification, 2026-10-31

The pushed `82f8dea` branch and previously uncommitted local source were combined
in an isolated worktree. This is a dirty integration snapshot, not a deployed
release. The Rust API library suite passed 2,618 tests with 50 ignored, and the
remaining workspace suites passed 349 tests. Rust formatting passed. The full
frontend suite passed 4,605 tests with 78 skipped before two new authentication
regressions were added. On the later combined snapshot, 4,664 passed, two failed
and 78 were skipped. The two failing regressions concern logout racing credential
publication and a stale tab combining access and refresh tokens from different
rotations. The earlier full-suite pass does not cover them.
Synthetic Chromium coverage for the changed refresh path passes 49 tests and
fails those two regressions. IndexedDB coordination holds an uncertain refresh
attempt rather than replaying it; this can require a new sign-in.

The reviewed direction is a single session-bound authority for a complete
credential pair, with transactional login, logout, and refresh publication.
Previously opened clients still use the old localStorage keys and cannot be
fenced by the new browser code alone. A safe deployment needs a coordinated
server-side protocol cutover and credential revocation; that cutover is not
implemented. Its possible sign-out of existing sessions must be addressed in
the deployment plan. No current result establishes mixed-version safety.

An isolated loopback build served the expected backend and frontend assets and
passed 23 synthetic Chromium conversation-layout checks at phone and desktop
widths. The separate real-router project file preview and search fixture passed.
These checks predate the pending authentication protocol work and do not prove
the deployed Tailscale version, real-provider behavior, or physical-device input.

The previously uncommitted file-preview changes include fixes for literal
punctuation in filenames and paging after a file becomes empty. A split-pane
citation now uses its originating pane's workspace; mobile drawer search resets
on close. Background retirement still has a finite capacity when enabled, with
safe refusal before partial deletion.

Subsequent isolated-worktree changes add per-setting appearance resets, a
per-message image gallery with zoom, and terminal file links into the scoped
project preview. Terminal links are limited to unambiguous absolute paths in a
structured thread's workspace; touch users can open a supported selected path
from the selection menu. Optional `apply_patch` syntax validation currently
supports JSON only. The board panel and routes remain unavailable while their
authorization and durable receipt boundaries are hardened. Focused tests cover
the other changes; the current full suites must be rerun after all integration
changes, and physical-device behavior has not been established.

## Release evidence

- Verify the current source on a stable snapshot with the full frontend and Rust
  suites and isolated integration tests.
- Test desktop and mobile browser workflows, including draft retention,
  microphone lifecycle, approvals, terminal access and reconnects. A real iPhone
  check is a follow-up, not the initial release gate.
- Keep unverified or unsafe features disabled; distinguish source changes from
  what is actually served on Tailscale.
- Complete queued authorization and its logout, session cleanup and recovery
  boundaries before enabling it or the background command tools.
- Upgrade backend and frontend together using a controlled worker transition.
  Never run an older worker and a newer worker concurrently on the same store.
