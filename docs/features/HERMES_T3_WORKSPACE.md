# Hermes and T3 inspired workspace

Terminal v4 combines its terminal and preview tools with a real Hermes runtime,
native coding agents, Git review, isolated workspaces, durable tasks, searchable
history, and reviewed project knowledge.

## Start a session

Install and configure the desired native runtime on the backend host. Hermes
installation, executable overrides, configuration, and verified Windows setup are
documented in [Hermes runtime](HERMES_RUNTIME.md). A provider catalog distinguishes
installation, credential configuration, and runtime capabilities. Native
authentication remains unknown until the native program checks it.

Select Hermes, Claude, Codex, or another supported agent in the new-session
picker. Project defaults apply to the selected directory; an explicit choice
overrides them. The live host supplies executable paths and shell conventions.
Saved profiles contain model and reasoning choices, never executable commands.
Hermes can use its configured model or an explicitly entered model identifier.

## API providers through Hermes

The host also maps 25 verified API-key providers to Hermes's actual tool engine.
Supported providers use the current app account's encrypted vault entry, looked
up again when starting the child. The key is injected into the appropriate child
environment variable; it is never included in launcher arguments or catalog
responses. Missing credentials prevent launch.

These runs use separate account/provider homes under
hermes-profiles/profiles/<hashed-account-and-provider>. HOME, USERPROFILE,
APPDATA and LOCALAPPDATA are scoped as applicable; inherited API keys/endpoints
are removed. Operator custom configuration is ignored. Existing inline
credentials in the isolated profile are rejected rather than overriding the
vault. Native Hermes sessions continue to use their explicit operator profile.

Unsupported OAuth/cloud/custom endpoint adapters remain unavailable in the
catalog. Provider-key configuration is not proof of successful authentication;
the actual runtime checks the provider when work starts. Both interactive
sessions and durable tasks use this bridge.

## Workspace knowledge and learning

Open **Knowledge** to save project notes, reusable instruction text, and task
defaults. Choose notes and skills, then **Add to prompt** to review the draft.

Open **Tools > Learning** to prepare a constrained learning request. Send that
editable request through the active agent, then preview the matching complete
JSON answer. Stage changes, inspect them, and explicitly accept or reject them.
Replacement/removal operations carry previous values; stale updates return a
conflict. Accepting persists the profile and its receipt atomically. Manual saves
preserve proposal metadata. These operations synchronize within one API process.

Hermes also has its own runtime-managed memory and learning features. Those are
separate from Terminal v4's reviewed workspace profile. The native Hermes entry
uses the configured operator profile; deployments must account for that ownership.

**Installed skills** discovers bounded SKILL.md text from fixed project and host
provider roots and inserts selected instructions into the draft. Supporting
scripts are not executed by this picker. Provider-native enablement settings and
all supporting-file behavior are not reproduced by text import.

## Git review and isolated workspaces

**Tools > Git & worktrees** reviews staged, unstaged/new-file, branch/base, and
checkpoint changes. Text is escaped; binary changes and truncated previews are
identified. Create a managed worktree from a selected Git ref, then start a
terminal there. Each checkout gets a separate codex/ branch.

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
interrupted work. On restart, interrupted runs are not silently retried. Durable
completion receipts recover a result if replacing the owner store temporarily
fails. A persistence outage stops the affected task and reports an actionable
server error.

Recurring interval schedules start disabled unless explicitly enabled. They run
while the server runs, coalesce missed intervals, and avoid overlapping runs of
the same schedule. Pause, enable, run now, and remove are explicit actions.
These are Terminal v4 application schedules, separate from Hermes's scheduler.

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

Both upstream projects use the MIT license. Their source copies retain their
license files. No upstream runtime or UI source files were incorporated verbatim.

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
Optional Hermes browser/computer tools, messaging gateways, and remote execution
backends require their own setup. Paired environment management and coordinated native conversation/files rewind
are documented in [Paired environments and rewind](PAIRED_ENVIRONMENTS_AND_REWIND.md).
Automatic parent-agent wakeup is not implemented. API-provider support depends on a verified runtime adapter;
catalog presence alone does not mean a provider can execute tools.

## Terminal v4 workspace interface

The workspace uses T3-inspired project/thread hierarchy with Terminal v4’s Carbon & Amber palette, terminal wordmark and existing typography. A continuous shell replaces detached rounded panels and decorative window controls. The compact sidebar exposes workspace tools even while a session is active; files and previews retain their own controls.

On desktop, New thread and the Terminal v4 home button open a composer without starting a shell. Selecting an existing thread returns to its running session; New terminal explicitly starts terminal work. Existing native PTYs retain their terminal surface, and structured agents retain their conversation surface. Tool and device dialogs share input, focus and button styling. Mobile keeps its dedicated terminal controls with a continuous shell and touch-sized dialog actions.

Verification covers the home/new-thread callbacks, workspace composer and sidebar controls, the full frontend suite and production build, plus real desktop/mobile browser checks including light mode, sidebar collapse and tool dialogs. Native desktop-control and internet deployment limitations are described in REMOTE_WORKSPACE.md.
