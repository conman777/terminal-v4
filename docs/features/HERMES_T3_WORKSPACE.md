# V4 workspace

Terminal V4 combines its own Rust agent runtime with terminal and preview tools,
Git review, managed workspaces, durable tasks, searchable history and reviewed
project knowledge. Hermes Agent and T3 Code inform feature design. V4 implements
its runtime and interface independently. See [V4 runtime](V4_RUNTIME.md).

## Workspace interface

Phones use one 52px thread header for navigation, the current thread and project,
terminal, Files, Git and thread actions. For a structured conversation, the
terminal action opens a companion terminal in the thread's workspace; closing
the panel preserves the conversation draft and reopening it restores the
thread's terminal. The server chooser, thread search, global preferences and
process/browser settings live in the navigation drawer. Desktop keeps project
and thread navigation in the sidebar, including saved conversation search.
On phones, use the thread's More menu to pin or unpin it; pinned threads appear
first within their project in the drawer. The same menu can archive or restore
the open thread. Archived active threads can also be restored from the drawer;
older inactive threads are available through saved-history reopening.
Unpinned structured background threads with known state that are working appear
in an always-visible **Working** section. The open thread and threads whose
pending state is unknown stay in the main list. Working rows remain visible
because background approval state is refreshed by polling; an approval indicator
may still take until the next successful refresh to appear. After more than
30 seconds of inactivity, the next visible-window touch, pointer, wheel or
keyboard activity requests a fresh inventory; this is not a push notification.
Structured threads
use their server lifecycle status, so quiet running work is not marked
idle solely because it has not produced recent output. Conversations requiring
cleanup or reconciliation stay in the main list with an attention indicator.
On a compatible server, structured threads can be snoozed for one hour from
their desktop action menu or mobile More menu. Snoozing does not stop a running
agent or discard its draft; the thread remains visible in the Snoozed section.
The server records the deadline and event sequence and projects the thread back
to the main list when the deadline passes, a structured approval or question
arrives, a native browser approval is registered, or a new failure occurs. An approval or recovery already pending blocks
snoozing. The inventory refreshes while the workspace is visible, so an event
may appear at the next refresh rather than instantly. Other separately tracked
requests are not yet included in automatic wake. Native browser approvals are
tracked in the local server process, rather than a cross-process receipt.
Terminal-backed threads cannot be snoozed with this control.

On compatible Unix servers, an idle V4 conversation can be moved to the visible
**Settled** section from the desktop thread menu or mobile More menu. Settling
does not delete the conversation or its draft, and removes its pin. It requires
the server to confirm there is no active turn, pending approval or question,
queued work, or unresolved delegated child. If that state cannot be checked,
the control is unavailable. New user input, changed queue items, a request or a
failure brings the thread back to the main list; **Un-settle thread** does so
explicitly. A queue restart hold without changed items does not wake it.
Settlement is currently manual and V4-only: native Claude/Codex queues are
browser-local and cannot yet be checked across devices. Automatic settlement,
pull-request rules and thread terminal cleanup are not implemented. Inventory
checks the owner's retained delegation records for each V4 thread; the outbox
is bounded to 1,024 records, but large thread and task histories may make that
check slower. If its storage is busy or unavailable, the thread remains in the
main list and settlement cannot be confirmed. Background command tools are not
enabled yet; their eventual admission must add process activity to this check.

The new frontend requires the server's lifecycle capability and a confirmed
response before showing the change. Legacy sessions load without snooze metadata.
Older servers do not preserve that metadata when rewriting a thread, so stop old
workers before upgrading and avoid downgrade or mixed-version operation on the
same data directory. Cooperating current Unix runtime servers hold an exclusive
owner lease; unfenced construction, older servers and non-Unix platforms do not
have the same verified cross-process guarantee.
Project tools, Knowledge and New terminal live in navigation on both layouts.
Tools can add reviewed context or saved prompts to the active editable draft;
opening or closing navigation does not send it.

The composer contains message input, attachments, model settings and Send/Stop.
On phones, the writing area starts compact and expands on focus, and a divider
separates it from model and action controls. Message and terminal
command placeholders identify what will be sent. Tapping the composer padding
focuses its text field; tapping a control keeps that control's behavior. Return
adds a line on mobile; Send (or Cmd/Ctrl+Return with a keyboard) submits. Desktop
Enter behavior is unchanged.
Session-specific queue and conversation controls remain close to message input.
Directory, runtime and branch information open from **Session context**, including
branch switching where available, instead of occupying a persistent footer. On
phones this action is in **More composer actions**.
The start screen retains project and agent/model choices required to launch a task.

The interface follows the layout hierarchy inspected in T3 Code's installed
desktop app and its [official mobile screens](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824): project/thread navigation,
a quiet conversation timeline, compact activity details and an expandable
composer with nearby agent controls. V4 uses its own terminal branding,
theme colors, selection markers and workspace tools.

Mobile Codex conversations expose model, reasoning and speed in the composer.
The model trigger opens an anchored, searchable list with selection checkmarks.
Reasoning and speed controls switch the contents of that same popup; Back or
Escape returns to the model list. Long catalogs scroll inside the popup, and
its position follows viewport changes while keeping touch targets at least 44px.
Selection changes apply to the next turn through the existing structured-session
API and preserve the draft. Controls are disabled during generation, pending
sends, cancellation, recovery and model updates. Catalog loading starts only
when model settings are opened. Ready conversations keep the title in the
navigation bar; active responses retain visible status, approval and Stop controls.

Desktop composers, the start screen, new-thread setup and project defaults use
the same searchable model popup as mobile. Provider choices retain explicit
custom model IDs and catalog capability limits. Nested pickers keep their parent
dialog open and restore focus when dismissed.

Conversation Markdown supports inline `$...$` and block `$$` math using bounded
KaTeX rendering. Mermaid fences render a limited flowchart subset (`graph` or
`flowchart` with `TD`, `TB` or `LR`, simple and decision nodes, and arrows with
optional labels) as accessible
SVG. Unsupported syntax, cyclic graphs and unfinished fences remain selectable
code. Flowchart labels are text, not executable markup, and no user-supplied
diagram URL is loaded. This is not full Mermaid syntax support.
Bounded `sequenceDiagram` fences also render participants and aliases, solid or
dashed messages, and self-messages. Loops, notes and other unsupported sequence
constructs remain selectable source.

Workspace Tools groups its nine tools under Code & history, Plan & improve, and
Share & move. Desktop shows vertical navigation beside the selected tool. Phones
start with the grouped index and open one tool at a time; All tools or Escape
returns to the index without clearing that tool's current input. A second Escape
closes the dialog and restores its opener. Tool lists and content scroll within
the visible viewport.
Auto-follow scrolls only the message pane, keeping the conversation header and
Stop action on screen. Phone inputs use 16px text, and composer menus limit their
height to the space above their trigger and below the navigation header.

## Start a session

Configure a provider API key in Settings, then choose that provider and a model
in the new-thread picker. Project defaults apply to the selected directory; an
explicit choice overrides them. Saved profiles contain model and reasoning
choices. Capabilities come from the exact selected model's metadata; unknown
custom models do not gain assumed image or reasoning support.

Owned V4 conversations run in the authenticated API's structured engine with
streamed events, durable acceptance receipts, approvals and cancellation. Native
Claude Code and Codex can also start from the start screen as conversation
threads (Claude Code runs one `claude -p` turn per message and resumes the same
native session). Gemini and other CLIs open in a terminal. A terminal's agent
picker lists only agents this host can run. Installation and authentication
state belongs to those programs.

## API providers through the V4 runtime

V4 implements Anthropic Messages, OpenAI Responses and compatible Chat
Completions adapters. Interactive structured threads, the optional
`terminal-v4-api agent` CLI and supported unattended tasks use V4's own provider
loop, tools and conversation storage.

Each run resolves the current app account's encrypted provider credential from
the local vault. Keys are excluded from launcher arguments, transcripts and
workspace tool-process environments. Provider metadata controls compatible
models and transports. Configured host endpoint overrides require HTTPS, with
loopback HTTP allowed for local services; redirects are disabled.

OAuth-only, Bedrock, Vertex, Azure-specific and virtual ensemble transports need
separate adapters and remain unavailable. A configured key or catalog entry does
not establish successful provider execution. See [V4 runtime](V4_RUNTIME.md) and
[Anthropic gateway configuration](ANTHROPIC_GATEWAY.md) for the current boundaries.

## Workspace knowledge and learning

Open **Knowledge** to save project notes, reusable instruction text, and task
defaults. Choose notes and skills, then **Add to prompt** to review the draft.

Open **Tools > Learning** to prepare a constrained learning request. Send that
editable request through the active agent, then preview the matching complete
JSON answer. Stage changes, inspect them, and explicitly accept or reject them.
Replacement/removal operations carry previous values; stale updates return a
conflict. Accepting persists the profile and its receipt atomically. Manual saves
preserve proposal metadata. These operations synchronize within one API process.

**Installed skills** discovers bounded SKILL.md text from fixed project and host
provider roots and inserts selected instructions into the draft. Supporting
scripts are not executed by this picker. Provider-native enablement settings and
all supporting-file behavior are not reproduced by text import.

## Git review and isolated workspaces

**Tools > Git & worktrees** reviews staged, unstaged/new-file, branch/base, and
checkpoint changes. Text is escaped; binary changes and truncated previews are
identified. Create a managed worktree from a selected Git ref, then start a
terminal there. Each checkout gets a separate codex/ branch.

Worktree creation retains a request identity across an uncertain response. A
retry of that request will not run Git again; an unresolved checkout is shown
as unconfirmed and unavailable for manual review. Starting a different request
is explicit. These records count toward the 64-worktree limit and are not
automatically removed. The protection assumes a stable, private local data
directory and does not cover older clients or mixed server versions. Creation
is currently unavailable on non-Unix hosts. The following agent-session launch
has a separate retry boundary and can still have an uncertain outcome.

File checkpoints use private indexes and hidden refs without changing the live
staging area. They include tracked and new non-ignored files. Restore is limited
to managed checkouts and rejects HEAD, file, staging, and ignored-file collisions
against the latest recorded state. The UI requires explicit confirmation.
Restoring files alone does not rewind a native agent conversation. Use
[coordinated rewind](PAIRED_ENVIRONMENTS_AND_REWIND.md) to select both a native
conversation boundary and a files checkpoint.

Archive saves a checkpoint and retains the complete checkout, including ignored
files. Reactivate changes its saved status without modifying files. Archiving
does not stop a running agent or reclaim disk space. Git commit, push, and PR
creation remain available through the terminal.

## Tasks and schedules

**Tools > Tasks & schedules** saves task intent before starting a native agent.
The queue records parent links, activity, output, final results, exit failures,
cancellation, and optional before/after Git checkpoints. Results can be inserted
into a parent conversation's editable prompt.

Up to three tasks run across distinct canonical workspace directories. Tasks
targeting the same directory wait, including tasks submitted by different app
accounts. Use managed worktrees for parallel changes. Native provider permission
behavior remains enforced; the queue does not add permission-bypass flags.

Cancellation terminates the process tree. Graceful server shutdown records
interrupted work. On restart, runs without a durable result are not silently
retried: they are marked interrupted, with a warning that the actual outcome is
unknown and may have completed. Durable completion receipts recover a result if
replacing the owner store temporarily fails. The worker retains its lease while
retrying failed result writes, but if both the owner store and receipt remain
unwritable and its process exits, the actual outcome can be lost. Review
workspace changes before retrying. An already-started checkpoint or blocked
storage operation can delay shutdown.

The task store can retain a delegated child's session identity in every task
state. Such records use a versioned task-ID marker that older readers expecting
a plain UUID reject, rather than treating the child as an ordinary task. Early
unmarked delegated records are migrated when read by the current server; they
are not protected before migration. This storage support does not itself enable
background delegation or parent wakeup, and it does not make mixed-version
servers safe. A delegated completion receipt must match the saved child and
task scope; a mismatch leaves the stored data untouched and blocks recovery.

Schedules start disabled unless explicitly enabled and run while the server runs.
They support recurring intervals, selected weekdays, five-field cron expressions
in an IANA time zone, and one-time runs. Existing fixed-offset calendars retain
their original meaning. Named-zone weekday calendars skip nonexistent local
times and use the earlier occurrence of a repeated time. For cron schedules, a
time in a daylight-saving gap instead runs when the clock advances; a repeated
time uses the earlier occurrence. Overdue runs beyond a grace period are recorded
as missed: recurring schedules advance, and a one-time schedule is disabled.
The worker avoids overlapping runs. Pause, enable, run now, and remove are
explicit actions. Enabling a paused one-time schedule whose time has passed is
rejected; use Run now or create a future schedule instead. Results can optionally
be sent to the owner's paired Telegram chat; an unconfirmed send is reported and
is not automatically retried. These are Terminal V4 application schedules.

On supported local filesystems, cooperating server versions take an OS-backed
worker lease per data directory and serialize task-store transactions across
processes. A second server can serve task requests; its worker waits for the
lease and retries after the first server stops. Do not run older versions alongside the current server: they do
not honor these locks. Network filesystems with unreliable file locking are not
supported for shared task storage.

The panel checks the authenticated, no-store scheduling capability endpoint and
rechecks immediately before creating a one-time, named-zone calendar, or cron schedule.
Without protocol version 1, it disables those creations; interval schedules remain
available. Advanced requests also use a zero interval that older interval-only
servers reject; a server with calendar support but no cron support rejects cron
payloads without their required calendar fields. Agent-reviewed scheduling executes
on the new server directly and does not use this frontend handshake.

Advanced schedules use a storage marker that makes the previous version reject
the entire owner store instead of treating them as intervals. This is not a
general downgrade guarantee: early advanced records written before the marker
are migrated only when the current server reads each owner store, and unreadable
stores cannot be migrated. Stop all servers and remove or otherwise safely
migrate advanced schedules before downgrading; do not start the older worker on
unverified data. The old version will not display tasks from a marked store.

## History and context handoff

**Tools > History** searches saved PTY and structured message bodies, with
workspace filtering and bounded, redacted snippets. Opening saved history
restores the app session and its workspace/pane assignment.

Native history discovery supports source-specific Claude/Codex JSONL and Hermes
SQLite records from fixed operator roots. Import creates an app-user-owned,
workspace-scoped transcript snapshot. A portable handoff inserts bounded text,
role labels, and source provenance into the draft. It starts with explicit text
context; native tools, approvals, runtime state, and conversation position are not
transferred. Native history is an operator-owned host resource; app-account
ownership applies to imported copies.

## Storage, APIs, and limits

Profiles use hashed authenticated-user and canonical-directory keys below
workspace-profiles in the application data directory. Directory aliases share
a profile; separate worktrees currently have separate profiles. Atomic JSON
records contain the strict profile plus internal workspaceMetadata. Reads return
only profile fields; invalid storage raises an error rather than discarding data.
Sensitive responses use private, no-store caching.

Limits:

- Notes: 6000 characters; 20 skills, each 80-character name/6000-character text;
  50000 context characters overall; 1 MB combined profile/metadata storage.
- Proposal history: 30 records, at most 15 pending. Reviewed receipts are bounded;
  idempotence applies while the receipt remains retained.
- Git: 64 managed worktrees per owner/repository; 100 checkpoints per workspace;
  5000 files/100 MB total/10 MB per file; 200 KB diff previews.
- Tasks: 200 records and 20 schedules per owner; 32000-character prompts,
  64 KiB saved output tail, minimum 60-second schedule interval, 30-minute run limit.
- Skill discovery and native history use bounded scans and omit oversized sources.

See [API architecture](../architecture/API_ARCHITECTURE.md) for routes. Git
checkpoint times use Unix seconds; task/schedule timestamps use milliseconds.

## Source inspection

Both complete source repositories were downloaded into the original checkout's
ignored output/reference-sources directory. The implementation is original
Terminal v4 code adapted to the existing Rust API and React UI.

| Source | Pinned revision | Source paths inspected | Feature selected |
| --- | --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/79651b71bd56efd76d06f3de1df64dde09b58ff3) | 79651b71bd56efd76d06f3de1df64dde09b58ff3 | tools/memory_tool_store.py, agent/memory_manager.py, agent/skill_commands.py | Bounded durable knowledge, explicit skill loading, context snapshots |
| [T3 Code](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae) | 7ac952c630ef8a60d14ca8f6a0c7adce33db4bae | packages/shared/src/projectSettings.ts, packages/shared/src/t3ProjectFile.ts, packages/shared/src/composerContextReferences.ts | Project-specific defaults, live provider selection, reviewable task context |

Reference sources are comparison material and must remain outside application
packages. Implementation changes use V4-owned modules. Source comparison is
bounded evidence; it is not a guarantee about authorship or complete feature parity.

## Verification and boundaries

Colocated pure tests cover context/default resolution, proposal parsing, native
history parsing, provider command arguments, and lifecycle state transitions.
I/O tests use authenticated Axum routes, temporary Git repositories, real source
files/SQLite fixtures, and harmless local child processes. They exercise owner
isolation, restart persistence, stale writes, checkpoint drift, Windows process
descendants, concurrent workspaces, and completion receipt recovery.

Frontend tests cover loading, saving, errors, explicit prompt insertion, model
selection, saved-session restoration, and desktop/mobile component wiring.
Browser checks use an isolated localhost API and temporary test identity. No
model request or real provider login is needed for these checks.

This integration does not reproduce every upstream interface or deployment.
Messaging gateways and additional remote execution backends remain separate
feature work. Paired environment management and coordinated conversation/files
rewind are documented in [Paired environments and rewind](PAIRED_ENVIRONMENTS_AND_REWIND.md).
Approved V4 background investigations can deliver their results to the parent
through its follow-up queue and wake it when that queue is running. A manually
created workspace task does not automatically wake a parent. Supported API
providers use the owned V4 adapters; catalog presence alone does not establish
end-to-end parity.

## Terminal v4 workspace interface

The workspace follows T3 Code's layout and palette: near-black canvas (#0a0a0a), black sidebar, #101010 cards, hairline white borders and an indigo accent fill (#3a4bbd; #1b4ed8 in light mode). Tokens live in `WorkspaceUI.css`; components read them rather than defining private palettes.

- **Sidebar:** a flat list of thread cards sorted by activity, each with a project badge (`ProjectBadge`), relative time, title and Git branch (`POST /api/workspace/git/branches`). The toolbar holds search, the project filter, Add project, New terminal and New thread; the footer holds Settings, tools, profile and the Workspace apps menu.
- **Conversation:** each finished turn folds its tool activity into one "Worked for …" group (`groupTurnWork`). A turn that changed files is followed by a "N changed files" card with per-file diffs (`TurnChangesCard`).
- **Composer:** a single rounded card with the agent/model picker on the left and attach, mic, info and a round indigo send button on the right. Claude chats can switch model and effort between turns.
- **Thread details:** a floating card (1280px and wider) shows the machine, Open in Files, Open in <editor>, the branch, uncommitted Changes and Commit, push & PR. The header also toggles a per-thread terminal drawer (a companion PTY hidden from the sidebar) and the browser panel.
- **Mobile** keeps its own layout and picks up the same theme tokens.

### Agent control

- **Access modes** (composer → Access, Claude Code and Codex): *Supervised* asks before edits and commands; *Auto-edit* (default) edits files in the thread's folder without asking; *Full access* runs anything. Claude maps these to `--permission-mode manual` with `--permission-prompt-tool mcp__terminal_v4_browser__permission_prompt`, `acceptEdits`, or `--dangerously-skip-permissions`; Codex maps them to `untrusted`/`on-request`/`never` approval with `workspace-write` or `danger-full-access`. Changes apply from the next turn.
- **Approvals** show in the conversation with Approve, Reject and *Allow for this session* (Codex `acceptForSession`; for Claude the tool name is remembered for that chat). Codex questions (`item/tool/requestUserInput`) become question cards with options or free text.
- **Plan mode** (composer → Plan; on phones, **More composer actions → Plan mode**) sends `[Plan] …`; the turn runs read-only (Claude `--permission-mode plan`, Codex `read-only` sandbox with planning instructions). The finished plan offers *Implement plan* and *Implement in a new thread* when the conversation is available for execution.
- **While a Claude or Codex reply runs**, sending queues the message; *Send now* stops the reply first. The queue is saved in the current browser tab and survives a page reload, but not reliably closing that tab or moving to another device. After a reload, pending entries wait for review; an in-flight send is marked unconfirmed and must be checked in the conversation before removal. Restored pending entries should also be checked before resuming in case another tab sent them. Queued messages wait until the conversation is connected, cleanup is complete, and the environment allows agent execution. Drafts can be stashed and restored (composer → Stash).
- **Messages** offer *Edit as new message*, *Fork from here* (a new thread seeded with the conversation so far), *Read aloud* and Copy. On phones, editing copies the earlier message into the composer after any existing draft so the current text is preserved. Forking and plan execution are available for supported Codex and Claude conversations when execution is permitted.
- **Notifications** (Settings → Interface) notify when a thread that worked for at least 5 seconds finishes, or needs approval, while the window is not in front.

### Composer and navigation

- Installed skills appear as `/skill-name` slash commands; choosing one inserts an instruction to follow that skill's file. `@` lists matching project files (`GET /api/workspace/files`).
- The Files panel can search text within the selected thread's project. On Unix, searches skip symlinks, binary files, dependency directories and files over 256 KiB, returning up to 100 matches under a 32 MiB, 20,000-entry and two-second soft budget. Results can be truncated, and cancellation takes effect between filesystem operations. Selecting a result preserves the search snapshot; **Open current file at line** reads and highlights up to 15 current lines in a bounded preview. If the workspace or file changes, the preview can fail and the snapshot remains available. This is a read-only preview, not an editor, and files can change again after it loads. Changing accounts or servers clears the panel; reopen Files to load the new workspace. Paired environments require file-transfer permission. Non-Unix hosts currently report that search and preview are unavailable.
- Files can be attached in Claude and Codex chats (`POST /api/files/attachment`); attachments reach the agent as an "Attached files" list of paths. The picker, drop and file paste accept ordered batches of up to 100 files, and sending waits for the batch to finish. Ordinary files have a 25 MiB limit; recognized screenshot MIME types use the 10 MiB screenshot route, while other image formats such as SVG are attached as ordinary files. A failed batch stops at the first failure, reports any files already attached and requires acknowledging the incomplete selection before sending. Before an upload or V4 image selection begins, the composer saves a review marker scoped to the account, environment and thread. An interrupted selection remains held for review after reload if browser storage is intact; each outstanding marker needs a separate acknowledgement. Markers contain no filenames or file contents, and at most 100 can be stored per scope. A successful native file batch clears its marker only after the selection is saved and checked. If the marker cannot be saved, the upload does not start; if review records cannot be read, sending is held until storage is available. Acknowledging a marker in another tab does not atomically exclude an upload or send already in progress; check other tabs before continuing. Clearing browser data or using an older client can lose or bypass the hold. The upload route does not deduplicate retries: an interrupted or failed response can leave an extra server copy, even if the file did not appear in the draft. Detected folder drops or pastes are rejected with guidance to choose individual files; the browser does not provide the local folder path used by T3's desktop bridge.
- In supported Codex and Claude composers, a text-only paste of at least 32 KiB in UTF-8 is uploaded as a text attachment. Smaller pastes first stay in the draft and are removed only after the attachment and unchanged draft are saved. For authenticated users, larger pastes that approach the normal 1,000,000-byte draft-record limit are saved as a browser-local recovery source before upload, without filling the editor with the full text. If the draft changes, the existing draft and saved paste are held for review. The desktop paste-as-text shortcut bypasses conversion, and phones offer **Paste next as text** in the composer menu. Recovery stores the original draft and pasted text locally, scoped to the account, home server, environment and thread; it allows one saved paste per thread and up to eight records or 64 MiB per account and home server. Files are limited to 25 MiB. When IndexedDB is available, opening an authenticated thread checks for saved sources even if the review marker is missing, and recreates the marker when possible. Send is held while the check runs or if previously used recovery storage cannot be read. A small scoped browser-local history indicator is recorded before a save attempt, remains afterward and contains no pasted text; it helps detect when IndexedDB later becomes unavailable, even if that attempt failed. If IndexedDB is unavailable and the indicator was never recorded or was removed, an older hidden source cannot be detected. A reload can expose actions to restore the text, review an interrupted upload, retry it, or discard its saved source. Retrying may leave an extra server copy because uploads are not deduplicated. If device storage is unavailable or full, the upload does not start and the text remains in the open tab; pasted text beyond 25 MiB also stays inline. A tab closed before the recovery storage transaction commits may leave only a warning, with no recoverable text. Browser data removal, older clients, and cross-tab changes can bypass or erase browser-local recovery; upload checks and draft writes are not one atomic cross-tab transaction. V4 image-only conversations keep text inline.
- Unsent file selections are saved on this device by account, environment and thread, and return after a reload. Only names and paths are saved in the browser; the files remain on the server and can be changed or removed, so check restored files before sending. If device storage cannot save the selection, the composer reports the problem and blocks sending until saving succeeds. Concurrent edits in separate tabs are detected on a best-effort basis, not as an atomic cross-tab transaction; review the other tab when a conflict is reported.
- A context meter shows how full the context window is, from the usage Claude and Codex report. Settings → Usage totals tokens and cost per thread.
- ⌘K opens the command palette; ⌘F finds within the current thread; both are rebindable in Settings → Keyboard shortcuts. On phones, use More → Find in thread. Search can open collapsed completed work to show matching messages, reasoning, plans and visible tool output. In-progress tool output, rendered edit diffs and images are not indexed.
- New threads can start *In a new worktree* from the start screen. The base branch or commit defaults to `HEAD` and resets when the project changes. The branch picker lists up to 200 local and remote refs when supported by the server; a manual ref remains available.

### Thread details and tools

- The details card docks beside the conversation at 1280px and wider; on narrower windows its toggle opens it over the content. With split panes only the active pane shows it.
- Rows: machine, Open in Files, Open in <editor>, project scripts (run in their own terminal), branch, Changes, Commit/push/PR, and the branch's pull request with check counts and review.
- Diffs (turn changes and Git review) show line numbers, stacked or side-by-side layouts, and *+* line comments that are added to the draft as notes for the agent.
- The terminal drawer can hold several terminals per thread.
- Schedules can run on an interval or at a time on chosen weekdays.
- After a few turns, a thread offers *Review what to remember*, which opens the Learning tool; nothing is saved without review.
- Settings → Messaging connects a Telegram bot. Pair one chat with `/pair CODE`; then `/threads`, `/use N`, and messages go to that thread with replies sent back.
  Incoming updates are handled at most once: the polling cursor is saved before
  the update is dispatched, so a crash in between can lose that message rather
  than replay it.
  Voice captions are included with the locally transcribed voice message. Settings changes require a current local credential and are available on Unix; other platforms reject those changes. If an in-flight send or transcription holds the gateway, a settings change waits up to three seconds, then reports that the gateway is busy and can be retried. Authentication admission also reports a busy or unavailable result without waiting for its lock; filesystem work can still delay a settings change. A send whose delivery cannot be confirmed is not automatically repeated. Polling positions are tied to the bot, so switching bots starts a separate cursor and replacing the token for the currently configured bot retains its cursor; existing numeric cursors remain readable. Disconnect removes the cursor. Cursor files are synced before replacement, but recovery from disk rollback or power loss has not been established. If a cursor is corrupt or cannot be written, polling stops processing messages until storage is available. Older binaries do not understand the new cursor format and may replay updates after a downgrade. The gateway admission and revocation locks are process-local: do not run multiple API processes against the same data directory for Telegram, since a second process can race a settings change. These paths have only been tested with local synthetic Telegram and transcription services, not a real bot.
- Settings → Setup check lists required and optional tools with fixes. When a check needs attention, the start screen shows a compact, expandable notice; dismissing it is scoped to the current account and environment. The current doctor considers Codex and Claude as native agents, so their absence does not establish that configured V4 agents cannot run. On phone-sized or coarse-pointer screens, selecting a project does not automatically focus the composer or open the keyboard.

Turn changes are recorded by snapshotting the working tree into a private Git index when a turn is accepted (Claude: when the user message is sent) and again when it completes (Claude: when the CLI run ends). Trees are diffed with `git diff --numstat`, and summaries are kept per session under `structured-turn-changes/` in the data directory (last 200 turns). Turns outside a Git repository, without changes, or over the checkpoint size limits (5000 files, 100 MB) record nothing.

Commit and push run Git with repository hooks enabled and terminal prompts disabled. Pull requests use the GitHub CLI (`gh pr create`) and report when it is missing.
