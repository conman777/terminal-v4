# Hermes capability matrix

This is a source inventory, not a release or parity certification. It compares
the documented built-in Hermes tools and selected runtime behavior with the V4
agent tool registry in the current shared checkout. It does **not** establish
what is deployed, configured, or usable with a real account. Other V4 surfaces,
native agents, and explicitly configured MCP servers may offer related features.

Reference: [Hermes v0.22.5 release, commit `bf0203a794a`](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5),
and its pinned [built-in tool reference](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/website/docs/reference/tools-reference.md).
That reference makes availability conditional on platform, toolsets, credentials,
and configuration. V4 source was re-verified on branch `fix/macos-app-verification`
at HEAD `61f1e21`; the shared worktree may contain uncommitted changes made
concurrently, so status cannot be reproduced from that commit alone.

Status meanings (exactly one per row):

- **Implemented**: a model-callable or user-visible V4 feature for this
  capability exists in current source and is available without extra account
  setup beyond the platform noted. It does **not** assert Hermes semantic parity;
  listed differences still apply, and nothing here was run against a real provider.
- **Conditional**: implemented, but registered or usable only under the stated
  condition (setting, credential, platform, provider support).
- **Missing**: no equivalent was found in the current V4 agent registry or UI.
  This is not a claim about arbitrary MCP servers or external providers.
- **Not yet assessed**: evidence is insufficient; no parity claim is made.

Core capabilities (file, command, memory, session, schedule, delegation) are
listed separately from optional, provider-, platform- and credential-dependent
ones; Hermes catalogue breadth (messaging, plugins, backends) is not core.

V4 registry evidence: [`tool_definitions`](../../rust/crates/api/src/v4_agent/mod.rs),
[`file and command tools`](../../rust/crates/api/src/v4_agent/tools.rs),
[`knowledge tools`](../../rust/crates/api/src/v4_agent/knowledge.rs),
[`schedule tool`](../../rust/crates/api/src/v4_agent/scheduling.rs),
[`integration registration`](../../rust/crates/api/src/v4_agent/integrations.rs), and
[`browser tools`](../../rust/crates/api/src/v4_agent/browser.rs). The registry
filters out integrations and writes for the internal read-only child policy.

## Core tool mapping

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| `read_file` | Implemented | `read_file` reads workspace UTF-8 files with bounded line pages and byte pages (up to 512 KB per read); symlinks and credential paths are refused. Hermes documents additional document formats. |
| `write_file` | Implemented | `write_file` writes within the workspace with bounded atomic replacement. Hermes's whole-file read baseline and syntax checks were not compared. |
| `patch` | Implemented | `replace_text` replaces one literal match, or an explicit `expected_count`. `apply_patch` applies 1 to 50 hunks atomically (all-or-nothing, one atomic write), with per-hunk `expected_count`, a whitespace-tolerant line match used only when unambiguous, an optional content-hash `expected_revision` rechecked just before writing, and `dry_run`; it is filtered out for read-only children. It takes structured hunks only (no unified-diff format) and has no syntax check. |
| `search_files` | Implemented | `search_text` (content or filename mode; literal and, on Unix, regex) and `list_files` (one directory). Regex case folding is ASCII-only, long lines may be skipped, scan limits apply, and non-Unix search is unavailable. See the [runtime guide](../features/V4_RUNTIME.md). |
| `terminal` foreground | Implemented | `run_command` needs exact-action approval, runs in the workspace, 60 s limit; unattended tasks deny it. Approved commands have normal host access, not an OS sandbox. |
| `terminal` background/notification modes and `process_manage` (list, poll, read logs, wait, kill, write) | Conditional | `background_start`/`status`/`wait`/`cancel`/`read_output` are registered in the production turn on Unix only when the server starts with `TERMINAL_V4_BACKGROUND_COMMANDS=1` (default off), are never offered to read-only delegated children, and run through the approval-, owner-, session-incarnation- and checkpoint-fenced per-turn actor; completion is delivered to the owning session once as a metadata-only notice. Verified with scripted-provider turns and real subprocesses (restart, deletion, logout, capacity, mismatches, crash recovery). No list, stdin write or streaming log tail (`process_manage` list/write/log follow are Missing); output is reviewed-only, in memory, bounded. Live-provider behavior is unverified. See [BACKGROUND_PROCESS_LIFECYCLE.md](BACKGROUND_PROCESS_LIFECYCLE.md). |
| `execute_code` (programmatic tool orchestration) | Conditional (Unix, needs `python3`) | `execute_code` runs a model-supplied Python 3 script after an exact-action approval that shows the script text verbatim. The script can call `read_file`, `list_files` and `search_text` (plus the write tools when the parent policy allows writes) over a private Unix socket through the same dispatcher and policy as direct calls: at most 50 nested calls, 60 s timeout, 50,000 bytes each for stdout and stderr, scrubbed environment, process group killed on cancel or timeout, result returned as untrusted text. Unattended runs and read-only children cannot use it. On macOS with a working `/usr/bin/sandbox-exec` the script runs under a sandbox profile: the OS denies all network access except the tool socket and denies file writes outside the workspace and temporary directories (tested, including bypassing the Python guard); file reads are NOT restricted. Where `sandbox-exec` is absent or unusable (Linux, nested sandbox) there is no OS boundary: only the best-effort Python network guard applies, and the tool description and approval text say so. Nested calls are not recorded as separate tool events. |
| `delegate_task` | Implemented (Unix) | Approved read-only child in a separate context while the parent waits; `delegate_tasks` runs two to four concurrently. Children get only read/search/recall/skill-read tools. Not available on non-Unix. |
| `delegate_task` background | Conditional | `delegate_task_background` is registered only on Unix, for the Standard tool policy, when the delegation supervisor is present and the provider supports durable tasks. Integrated real-provider behavior is unverified. |
| `clarify` | Implemented | Hermes asks 1-5 questions (single-select, multi-select or open-ended); V4 `ask_user` takes one to four structured questions (choices or free text) bound to the active turn, and multi-select was not confirmed. CLI and unattended runs cannot answer. |
| `todo_list` | Implemented | Owner/workspace/session-scoped revisioned list with nesting, replace/merge/read and compaction preservation; stricter bounds than Hermes; cleared in rewind forks. |
| `mcp__<server>__*` | Conditional | `mcp_list_servers` is always registered; `mcp_list_tools`, `mcp_call_tool`, resource and prompt wrappers are registered only when at least one MCP server is enabled, and every call needs approval (unattended calls are disabled). |
| `manage_connections` | Missing | Hermes displays, checks, connects, reconnects and renames managed connectors or local MCP servers (needs the Nous Portal to enable connectors; it cannot disconnect or revoke). MCP servers are configured in the UI (`McpSettingsPanel`); no agent-callable management or Hermes managed-connector flow. |
| `manage_catalog` | Missing | Hermes (desktop app sessions only; not in `all`) searches and, with approval, installs catalog plugins and hub skills into the profile. V4 has no agent-callable plugin/skill catalog installation. |

## Browser tools and action safety

All V4 browser and `web_extract` tools are **Conditional** on the account's agent browser setting being enabled (`browser::load_config(...).enabled`); each action needs exact-action approval, is limited to configured origins, and is bound to the reviewed tab and document. V4's own browser is a disposable Chromium profile; when the shared in-app browser is available, `browser_open`, `browser_tabs` and `browser_close` act on the human-visible browser instead.

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| `browser_navigate`, `browser_back`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll` | Conditional | Registered with the agent browser. Refs come from the latest snapshot; stale refs are rejected; password values are redacted. Snapshot semantics differ from Hermes. V4 additionally registers `browser_open`, `browser_forward`, `browser_select`, `browser_wait`, `browser_tabs`, `browser_close`. |
| `browser_vision` | Conditional | Hermes screenshots the page and falls back to an auxiliary vision model on text-only models. `browser_screenshot` returns the active tab viewport as a PNG. Hermes also describes a fallback vision route; whether the selected V4 model accepts tool images must be checked per model. |
| `browser_get_images` | Conditional | Registered with the agent browser. Lists bounded image URLs and alt text from the reviewed document and open shadow roots; does not fetch images, read closed shadow roots or iframes. URLs may be sensitive. |
| `browser_press` | Missing | Implemented only under `#[cfg(test)]` (`browser.rs`) and not registered. An isolated Chromium test shows a focus handler can redirect a key to an element other than the reviewed ref, and settings changes must be serialized through confirmed release including modal interruption. `browser_evaluate` (approved script) does not establish native key behavior. |
| `browser_console` | Conditional | Requires the agent browser enabled and an exactly approved action; isolated V4 browser only. Returns buffered console messages and uncaught exceptions (200 per tab, 500 characters each) from the reviewed document's main world, with heuristic secret redaction. Iframe and worker messages are not included. Not given to read-only children. |
| `browser_cdp` | Missing | Hermes gates it on a CDP endpoint (raw DevTools command). V4 has no raw-CDP tool. |
| `browser_dialog` | Conditional | Same conditions as `browser_console`. It cannot act on a dialog that is already open (that blocks the browser's input); instead it arms a one-time accept or dismiss for the next dialog on the reviewed origin, expiring after 60 seconds, and unarmed dialogs are auto-dismissed. Matched by origin, not frame. |
| `browser_exec` | Missing | The tools reference names it (with five vault tools) only in its intro count and lists no description. Hermes's Browser Use backend tool ([pinned implementation](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/tools/browser_use_cli.py)); V4's `browser_evaluate` is page-side JS, not an equivalent host driver. |
| `browser_vault` | Missing | [Pinned implementation](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/tools/browser_vault_tool.py) provides list/fill/save-login/one-time-code/unlock; no equivalent. Verify release-specific registration rather than assuming the upstream summary's count. |
| `web_extract` | Conditional | Hermes (`web` toolset) extracts clean content from up to 5 URLs including PDFs and needs one of EXA, PARALLEL, FIRECRAWL, TAVILY, PERPLEXITY or KEENABLE API keys. V4 registers it only with the agent browser enabled (no provider key, no PDFs, one URL not established). Exactly approved unauthenticated GET of an allowlisted origin; bounded UTF-8 HTML/plain text; public IPv4 pinned; no redirects, proxies, credentials or nonstandard ports. Not a rendering or provider extractor. |
| `web_search` | Conditional | Hermes needs one of EXA_API_KEY, PARALLEL_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, PERPLEXITY_API_KEY or KEENABLE_API_KEY and returns 5 results by default. V4 registers it only when the account has a configured Tavily key in the Vault (Unix). Fixed-host client with pinned public IPv4, no proxy/redirects, bounded responses. One provider versus Hermes's provider selection. |
| `desktop_preview`, `drive_preview`, `annotate_preview` | Conditional | Hermes limits these to desktop app sessions (open/close/read the preview pane; interact with the in-app page; persistent element outlines). Shared-browser variants of `browser_open`/`browser_tabs`/`browser_close` exist when `workspace_browser::shared_available`; no annotation tool. Lifecycle equivalence with Hermes unverified. |
| `computer_use` | Missing | Hermes needs `cua-driver` on `$PATH` and controls the desktop in the background without taking the cursor. V4 has web-page control only; no OS-wide desktop control. |

## Memory, skills, recall and compaction

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| `memory` | Implemented (review-gated) | `inspect_knowledge` reads account/workspace memory and proposals; `propose_knowledge` stages changes for human review and never self-applies. Hermes can write memory directly; V4 intentionally differs. External memory providers (Hermes `plugins/memory`: byterover, retaindb) are Missing. |
| `session_search` | Implemented | Hermes searches or reads past sessions in its local database with FTS5 and no LLM calls. V4: `recall_sessions` and `read_session` give scoped, redacted search with anchored reads, `read_context_archive` reads compaction archives. Bounded scan with revision check by default. An optional SQLite FTS5 index (`rust/crates/api/src/recall_index*`, default OFF; enable with `<data>/recall-index/ENABLED` or `TERMINAL_V4_RECALL_INDEX=1`) covers V4, terminal, structured and imported histories with owner/workspace binding, redacted-only text, shadow-generation rebuilds, tombstones and generation-bound `indexCursor` pagination; incomplete freshness falls back to the scan and is reported in `index`. Token-prefix matching and bm25 ranking, so not scan substring parity or Hermes FTS parity. See the prerequisites below. |
| `skills_list`, `skill_view` | Implemented | `discover_skills`, `list_skill_files`, `read_skill_file`; project `.v4/skills`, `.agents/skills`, `.claude/skills` packages are read-only. Scripts are never executed. |
| `skill_manage` | Implemented (review-gated) | Via `propose_knowledge`; external project packages stay read-only. |
| Context compaction | Implemented | Model-generated compaction with recoverable archives and request-byte budgets (`compaction.rs`). Token accounting and auxiliary-model selection not compared with Hermes (including the `context_engine` plugin). |
| Always-on and on-demand skills in prompt | Implemented | Account/workspace memory and always-on skills are injected; opt-in skills are listed by reference. Background learning and session-pinned memory: Missing. |

## Scheduling and task management

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| `cronjob_manage` create | Implemented | `create_schedule` accepts reviewed interval, one-shot, calendar and 5-field cron jobs (IANA time zones; a spring-forward gap runs once after the gap, a repeated fall-back hour runs once) and saved-skill jobs (`skillRef`, snapshotted into the reviewed prompt). Workspace/owner/provider/model derive from the session. Unattended tasks cannot run commands or MCP calls. |
| `cronjob_manage` list/update/pause/resume/run/remove | Implemented (Unix) | `list_schedules` and reviewed `manage_schedule` for schedules linked to the current owner, conversation and workspace. A schedule can opt in to `deliverTo: telegram` (reviewed in the approval, or a UI toggle) to get a bounded, redacted result summary in the owner's paired Telegram chat; no other delivery platform exists, and Hermes `cron_providers` were not found. |
| Scheduling recovery | Implemented, with known gaps | Owner-scoped schedules, worker leases and interruption receipts. A worker-protocol marker makes an older worker refuse newer data ([worker upgrade](WORKER_UPGRADE.md)); when the result and receipt writes both fail the outcome goes to a synced journal merged on the next pass; overdue runs beyond a grace window are recorded as missed (`missedRuns`, `lastMissedAt`) instead of coalescing. Telegram result delivery is at-most-once per run with an honest `deliveryStatus` (see [worker upgrade](WORKER_UPGRADE.md#messaging-delivery)). Remaining: script jobs, delivery to anything but Telegram, an older build that rewrites a store drops the new fields. UI: `WorkspaceTasksPanel`. |
| `kanban_*` (show, list, complete, block, create, link, unblock, comment, heartbeat, request_review, request_changes, attach, attach_url, attachments) | Missing | Hermes registers these only for dispatcher-spawned workers (`HERMES_KANBAN_TASK`) or with the `kanban` toolset; `kanban_list` and `kanban_unblock` are orchestrator-only; attachments cap at 25 MB. V4 has no model-callable board; V4 workspace tasks and `todo_list` are separate. |
| `desktop_project` (Projects: named multi-folder workspaces), `read_terminal`, `close_terminal`, `read_window_below`, `focus_pane`, `react_to_message`, `gui_tour`, `show_tip`, `set_theme` | Missing | UI controls exist for projects, terminals and theme but no model-callable equivalents. Hermes limits these to desktop app sessions; `react_to_message` is also opt-in via `display.message_reactions`. |

## Image, audio and video

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| `vision_analyze` / image input | Conditional | Hermes returns pixels to vision-capable models or an auxiliary-model description otherwise. V4: Bounded image attachments (`user_images.rs`) and browser screenshots reach the model only when the selected model's catalog confirms image input. No standalone analyzer tool or auxiliary-model fallback. |
| `image_generate` | Missing | Hermes generates or edits via a configured backend (FAL_KEY, OPENAI_API_KEY, Codex OAuth, xAI OAuth or KREA_API_KEY). V4 has no native tool; an MCP server may add one. |
| `video_analyze`, `video_generate`, `xai_video_edit`, `xai_video_extend` | Missing | No native tools; Hermes makes `video_analyze` (`--toolsets video`) and generation (`--toolsets video_gen`; XAI, FAL, OPENROUTER or DEEPINFRA credentials; edit/extend need xAI credentials and a public HTTPS MP4 URL) opt-in and backend-dependent (`plugins/video_gen`). |
| `text_to_speech` | Missing | Hermes converts text to audio delivered as a voice message or attachment. Not a V4 agent tool. The UI has browser speech-synthesis read-aloud (`frontend/src/utils/readAloud.js`), which is not generated audio or messaging voice. |
| Speech-to-text (voice input) | Conditional | `transcribe.rs` uses a local Whisper server if available, else Groq `whisper-large-v3` with a key; the composer records and transcribes. Real device/provider behavior unverified. |
| `x_search` | Missing | Upstream is read-only search of public X posts, profiles and threads; it requires opt-in via `hermes tools` and `XAI_API_KEY` or xAI Grok OAuth. |

## Providers and execution environments

| Capability | V4 status | Evidence and work to establish parity |
| --- | --- | --- |
| Provider routes | Conditional | The agent loop (`supports`) runs a catalogued provider only if auth is `api-key` and transport is `openai-chat`, `openai-responses` or `anthropic-messages`: 34 of 40 entries in [`agent_provider_definitions.json`](../../rust/crates/api/src/agent_provider_definitions.json) (including OpenRouter, xAI, DeepSeek, Nous, LM Studio, Fireworks and Ollama Cloud). Each needs its own credential or local server. Not in the agent loop: `copilot`, `moa`, `copilot-acp`, `bedrock`, `vertex`, `azure-foundry`. Hermes keeps its providers under `plugins/model-providers/` (per-provider enumeration **not yet assessed**); do not claim parity from the count. |
| Streaming, tool-loop limits, cancellation | Implemented | Streams supported formats, bounds requests, scoped interaction/cancellation. Retry, incomplete-turn and reconnect behavior per provider not compared. |
| Execution environments | Local (Implemented); Docker (Conditional, opt-in via `V4_RUN_COMMAND_BACKEND=docker` and an image setting: no network by default, capability drop, resource limits, `--pull=never`, workspace mounted read-write; every container gets a unique `--name`, `--cidfile` and ownership labels, is killed and removed by name and id on cancel, timeout, failure or dropped run, and containers of dead runs are reaped at server start; tested only against a fake `docker` that keeps containers alive after their client is SIGKILLed, no real Docker daemon exists on the development Mac); SSH (Conditional, opt-in via `V4_RUN_COMMAND_BACKEND=ssh` with `V4_RUN_COMMAND_SSH_HOST` and `V4_RUN_COMMAND_SSH_WORKDIR`, optional `_USER`, `_PORT`, `_IDENTITY`, `_KNOWN_HOSTS`: `BatchMode`, strict host-key checking, no agent/X11/port forwarding, no connection multiplexing, 10 s connect timeout, POSIX-quoted remote command, local client killed on cancel or timeout; tested with a fake `ssh` and an env-gated private loopback sshd); the rest Missing | V4 runs commands on the V4 host. Hermes `tools/environments` includes `local`, `docker`, `ssh`, `modal`, `managed_modal`, `daytona` and `vercel_sandbox` (listing may be incomplete). No Docker, SSH, serverless or remote-sandbox backend in V4's agent. Paired-environment remoting (`RemoteEnvironmentsPanel`) targets other V4 hosts, not these backends. |

## Tools moved out of the Hermes built-in set

| Hermes capability | V4 status | Evidence and difference to resolve |
| --- | --- | --- |
| Honcho memory, Home Assistant and Spotify tools | Missing | The pinned reference says these are installed as plugins (`hermes plugins install honcho|homeassistant|spotify`; Spotify also needs `hermes spotify login`). V4 has no plugin loader; an explicitly configured MCP server could provide similar tools. |

## Messaging and optional integrations

| Capability | V4 status | Evidence and work to establish parity |
| --- | --- | --- |
| Telegram gateway | Conditional | [`telegram_gateway.rs`](../../rust/crates/api/src/telegram_gateway.rs) with a Settings UI (`TelegramSetting.jsx`) needs the user's own bot token and a pairing code. Per-user polling worker with `/pair`, `/threads`, `/use N` and plain messages relayed to a chosen structured thread; replies are the final assistant text, chunked, with a 30-minute wait. Pairing codes expire after 10 minutes, are single-use, are burned after 5 wrong guesses and work only from private chats; the update offset is persisted so a restart does not replay old messages (at-most-once delivery); failed polls back off and Telegram's `retry_after` is honoured. A turn blocked on an approval or question sends a notice (tool name only) to approve in the app; approvals cannot be answered from Telegram. Voice messages from the paired chat are downloaded (getFile, 2 MB / 2 minute limit, paired chat only) and transcribed by a local Whisper server only (`WHISPER_SERVER_URL`; audio is never sent to a cloud provider), echoed back as `Heard: ...` and relayed to the chosen thread; without a local Whisper server the user is told so. Photos, documents, video and audio files get a reply that they are not forwarded (nothing is downloaded or stored). Scheduled results can be delivered to the paired chat through an owner-bound send entry point (`send_to_owner`). No streaming or outbound attachments. Verified only against a local mock server (voice download limits, owner-bound send, retry, delivery with real worker processes); the worker loop has not run against a real bot, and Telegram's real voice container (OGG/Opus) depends on the local Whisper server accepting it. |
| Other Hermes messaging channels | Missing | Pinned `plugins/platforms` lists a2a, bluebubbles, buzz, dingtalk, discord, email, feishu, google_chat, irc, line, matrix, mattermost, ntfy, photon, qqbot, raft, signal, simplex, slack, sms, teams, telegram, wecom, weixin, whatsapp, whatsapp_cloud, yuanbao; `gateway/platforms` adds api_server and webhook ingress (listings may be incomplete). V4 has none of these except Telegram. Includes the platform-bound tools: `discord` (read/participate; needs `DISCORD_BOT_TOKEN`, gateway only), `discord_admin` (channels, roles, timeouts, kicks, bans; token plus bot permissions), `feishu_doc_read`, `feishu_drive_add_comment`/`list_comments`/`list_comment_replies`/`reply_comment` (document-comment handler only, Feishu credentials) and `yb_query_group_info`, `yb_query_group_members`, `yb_send_dm`, `yb_search_sticker`, `yb_send_sticker` (`hermes-yuanbao` platform, Yuanbao credentials). All Missing. |
| Plugin ecosystem | Missing / not yet assessed | Hermes `plugins/` has 18 directories (browser, computer_use, context_engine, cron_providers, dashboard_auth, delegation, disk-cleanup, google_meet, hermes-achievements, image_gen, kanban, memory, model-providers, platforms, security-guidance, teams_pipeline, video_gen, web) plus `plugin-catalog` and `optional-mcps`. V4 has MCP configuration and skill packages but no plugin loader; each plugin needs separate inventory. |
| User interfaces and native integrations | Not yet assessed | V4 browser UI and optional native shell versus Hermes desktop/TUI/web surfaces; the T3 matrix is not Hermes UI evidence. |

## Verification and next steps

1. Recheck source against a stable V4 snapshot; this shared checkout may change
   concurrently. Record its actual commit plus patch and build identity.
2. Expand each conditional family using the pinned source and test configured
   paths, failures, permissions, persistence, cancellation and restart behavior.
3. Inventory Hermes v0.22.5 plugin, messaging, provider and execution-backend
   implementations separately; the tool-reference table is not exhaustive.
4. Verify the existing conditional background delegation lifecycle and keep background
   commands disabled until their lifecycle and recovery are integrated and verified.
   A mock or isolated fixture is evidence for that scenario only, not proof of
   real-provider or deployment behavior.

Last re-verified against V4 source at `61f1e21` and the public Hermes GitHub tree at `bf0203a794a` (directory listings were truncated by the viewer and may be incomplete).
This review inspected the published reference and selected local source only.
It did not run tests, services, integrations, or access private accounts.

## Remaining gaps (prioritized)

1. Background commands are integrated behind `TERMINAL_V4_BACKGROUND_COMMANDS=1`; decide on `process_manage` equivalents (list, stdin write, log follow) and live-provider verification.
2. Decide on `browser_press`: resolve the focus-redirect and settings-serialization boundaries, then register it. (`browser_console` and an arm-ahead `browser_dialog` now exist; a decision on an already-open dialog is not possible with the current protocol.)
3. Verify provider and delegation paths against real accounts (mocks are the only evidence); add Bedrock, Vertex, Azure and Copilot to the agent loop or document them as unsupported.
4. Add an image-generation path (native tool or documented MCP route) and an agent-callable image analyzer/fallback.
5. Telegram: photo/document handling, approval/question handling, streaming, then a real-bot test; then decide whether any other channel (Slack, Discord, email, webhook) is in scope.
6. Execution backends: Docker (opt-in, container tracking and reaping, verified only against a fake docker) and SSH (opt-in, verified with a fake ssh and a loopback sshd) exist; the other Hermes environments are missing. Not proven: a real Docker daemon, and remote process cleanup after an SSH client is killed (remote commands may keep running).
7. Syntax checks for patching (multi-hunk `apply_patch` and `execute_code` exist).
8. Agent-callable project, terminal-read and connection management tools; background learning and external memory providers.
9. Inventory Hermes plugins and model-provider plugins individually before any parity claim; indexed recall is implemented but opt-in (see prerequisites below).

## Prerequisites for an indexed recall implementation

A complete index must cover V4, structured, PTY and imported histories. An
index filled only by queries can omit new or changed conversations, so it must
not claim complete search results. A design should establish:

- Owner- and workspace-bound identities, verified on reads, with only redacted
  searchable text; terminal fragments must be reassembled before redaction.
- A durable source-change record or equivalent recovery protocol for every
  create, update and deletion, including crashes between source and index
  writes. Deleted records require durable tombstones until index cleanup is
  confirmed. Existing history sources do not share one transaction.
- Bounded, restartable shadow-generation rebuilds with source watermarks,
  per-record and total storage limits, and explicit handling of corruption,
  symlinks, oversized records and interrupted rebuilds. Incomplete freshness
  must be reported or use the existing bounded scan rather than implying a
  complete negative result.
- Pagination bound to the owner, workspace, query, filters and immutable index
  generation; changed or expired generations must reject continuation. Source
  revisions must be checked when returning hits.
- Integration tests across all sources for ownership, redaction, mutation,
  deletion, rebuild, crash boundaries, concurrent writers, limits and stale
  pagination, before claiming global relevance or FTS parity.

### Indexed recall status

Implemented behind a default-OFF setting; enable only after validating on real data:

- Identity: one SQLite database per hashed owner under `<data>/recall-index/`; owner is verified in metadata and every row, workspace filters use the normalized workspace key, symlinked storage is refused, copied or corrupt databases are quarantined.
- Text: only `safe_history_text`-redacted text is stored; terminal fragments are reassembled before redaction and private keys spanning messages are withheld.
- Change record: every create, update and delete is written to a durable journal before it is applied; deletes keep a tombstone until the index confirms no rows remain. Source files have no shared transaction, so changes are also detected by diffing the source manifest (size and mtime) on each search.
- Rebuild: shadow generation with a persisted queue and watermark, resumable after a kill, catch-up passes before an atomic activation, per-record (2 MB), total (256 MB) and manifest (50,000) limits, oversized or unreadable records counted as skipped.
- Pagination: `indexCursor` binds owner, workspace, query, filters and generation revision; any change or rebuild rejects continuation. Hit file revisions are re-checked before results are returned.
- Freshness: if the index is rebuilding, over a limit, has pending changes beyond the per-search budget, or a source changed mid-search, the bounded scan answers and `index.used=false` with a reason.
- Not claimed: scan substring parity, global relevance, or Hermes FTS parity. Queries with no alphanumeric term use the scan.
