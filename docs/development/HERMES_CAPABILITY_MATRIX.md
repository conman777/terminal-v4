# Hermes capability matrix

This is a source inventory, not a release or parity certification. It compares
the documented built-in Hermes tools and selected runtime behavior with the V4
agent tool registry in the current shared checkout. It does **not** establish
what is deployed, configured, or usable with a real account. Other V4 surfaces,
native agents, and explicitly configured MCP servers may offer related features.

Reference: [Hermes v0.22.5 release, commit `bf0203a794a`](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5),
and its pinned [built-in tool reference](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/website/docs/reference/tools-reference.md).
That reference makes availability conditional on platform, toolsets, credentials,
and configuration. V4's inspected worktree is based on commit
`a71bf926573917f42872810201771870c991e22c` but contains extensive uncommitted and
untracked changes, so its status cannot be reproduced from that commit alone.

Status meanings:

- **Partial**: related functionality exists in inspected source; differences or
  missing verification prevent a parity claim.
- **Conditional**: a related tool is registered only with the stated V4 setup;
  matching semantics and full coverage still require testing.
- **Not exposed**: no equivalent model-callable built-in was found in the
  inspected V4 registry; this is not a claim about arbitrary MCP servers or all
  native providers.
- **Uninspected**: source evidence is not sufficient to assess equivalence.

V4 registry evidence: [`tool_definitions`](../../rust/crates/api/src/v4_agent/mod.rs),
[`file and command tools`](../../rust/crates/api/src/v4_agent/tools.rs),
[`knowledge tools`](../../rust/crates/api/src/v4_agent/knowledge.rs),
[`schedule tool`](../../rust/crates/api/src/v4_agent/scheduling.rs),
[`integration registration`](../../rust/crates/api/src/v4_agent/integrations.rs), and
[`browser tools`](../../rust/crates/api/src/v4_agent/browser.rs). The registry
filters out integrations and writes for the internal read-only child policy.

## Tool-by-tool mapping

| Hermes capability | V4 source status | Evidence and difference to resolve |
| --- | --- | --- |
| `read_file` | Partial | Workspace-only UTF-8 reads support bounded line pages and byte pages for larger files. Hermes documents additional document formats and different reading behavior. |
| `write_file` | Partial | V4 writes within the workspace, with bounded atomic replacement. Compare Hermes's whole-file read baseline and syntax checks. |
| `patch` | Partial | `replace_text` replaces one literal match by default, or an explicitly expected number of matches; Hermes describes more flexible patch matching and syntax checks. |
| `search_files` | Partial | On Unix, bounded `search_text` supports literal and regex content searches and workspace-relative filename searches; `list_files` lists one directory. Regex syntax and case folding, scan limits, non-Unix behavior and Hermes output modes differ; see the [runtime guide](../features/V4_RUNTIME.md). |
| `terminal` foreground | Partial | `run_command` starts in the workspace, requires exact-action approval and is limited to 60 seconds; unattended tasks deny commands. Approved commands have normal host access, not an OS sandbox. |
| `terminal` background and `process_manage` | Not exposed | The background manager, ledger and tool wrappers are test-only; they are not registered in the production V4 turn. Inspect, cancel, output, completion and recovery remain unintegrated. |
| `browser_navigate`, `browser_back`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll` | Conditional | V4 advertises corresponding operations when its agent browser is enabled. Exact-action approvals, target restrictions and snapshot semantics differ. |
| `browser_vision` | Conditional | `browser_screenshot` returns a reviewed PNG. Hermes also describes a fallback vision route; V4 tool-image and provider support must be checked separately. |
| `browser_press` | Not exposed | The experimental implementation is not in the agent registry. An isolated Chromium test shows that a focus handler can redirect a key to an element other than the reviewed ref. Settings changes must also be serialized with the admitted action through confirmed release, including modal interruption. Both boundaries need resolution before exposure; approved script evaluation does not establish equivalent native key behavior. |
| `browser_console` | Not exposed | Browser/preview UI features do not establish an agent-callable equivalent in the inspected registry. |
| `browser_get_images` | Conditional | When the V4 browser is enabled, an approved action lists bounded image URLs and alt text from the reviewed document and open shadow roots. Both browser paths bind the action to the reviewed tab and document; standalone reads also coordinate with settings writes by current-version processes. It does not fetch images or include inline data, closed shadow roots, or iframe contents; URL queries may be sensitive. |
| `browser_cdp`, `browser_dialog` | Not exposed | Hermes conditionally registers these for CDP. V4 has approved browser actions and UI dialog handling, but the inspected agent registry has no corresponding raw-CDP or dialog-decision tool. |
| `browser_exec` | Not exposed | The [pinned implementation](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/tools/browser_use_cli.py) provides this for the Browser Use backend instead of the default browser tools. V4's approved page evaluation is not an equivalent host-side Python browser driver. |
| `browser_vault` | Not exposed | The [pinned implementation](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a/tools/browser_vault_tool.py) registers one model-facing tool with list, fill, save-login, one-time-code and unlock actions. No equivalent appears in V4's agent registry. The upstream reference's summary counts five vault tools, so verify release-specific registration rather than assuming that count. |
| `clarify` | Partial | V4's `ask_user` supports one to four structured questions with choices or free text, bound to the active turn. CLI and unattended runs cannot answer; compare Hermes batching and presentation. |
| `manage_connections` | Partial | V4 can configure and explicitly probe MCP servers in its UI and exposes approved MCP wrappers. A Hermes managed-connector flow and agent-callable management are not established. |
| `execute_code` | Not exposed | An approved shell command can run code, but there is no inspected Hermes-style programmatic tool-orchestration executor. |
| `cronjob_manage` create | Partial | `create_schedule` accepts reviewed interval, one-shot and calendar jobs. Workspace/owner/provider/model are derived from the active session. |
| `cronjob_manage` list, update, pause, resume, run, remove | Partial | On Unix, `list_schedules` and reviewed `manage_schedule` operate on schedules linked to the current owner, conversation and workspace. Management supports prompt or timing edits, pause, resume, run now and removal after explicit approval, with stale or unavailable storage rejected. Editing timing retains the reviewed first run and leaves existing tasks unchanged. Compare cron forms, skill/script jobs and delivery semantics. |
| `delegate_task` | Partial | On Unix, an approved read-only child runs in a separate context while the parent waits. `delegate_tasks` can run two to four such investigations concurrently. Where a supported provider and the background supervisor are available, `delegate_task_background` can deliver a result through the parent queue. See the [runtime guide](../features/V4_RUNTIME.md) for its recovery and approval limits; integrated real-provider behavior remains to be verified. |
| `memory` | Partial | V4 can inspect knowledge and propose reviewed memory/skill changes. Compare mutation rules, prompt snapshots and long-term learning without bypassing review. |
| `session_search` | Partial | `recall_sessions` and `read_session` support scoped, redacted search and anchored reads. Optional last-update time filters and ranked-window pagination narrow and compare matches across one bounded scan window with a revision check. This is not Hermes session-start filtering, global ranking or FTS5 parity. |
| `skills_list`, `skill_view` | Partial | `discover_skills`, `list_skill_files` and `read_skill_file` provide scoped discovery and bounded reads. Compare installed roots, metadata and continuation semantics. |
| `skill_manage` | Partial | `propose_knowledge` stages package changes for review; it does not apply them directly. External project skill packages are read-only in this flow. |
| `todo_list` | Partial | V4 has an owner/workspace/session-scoped revisioned list with nested items, replace/merge/read and active-task compaction preservation. It rejects invalid or cyclic updates and has stricter bounds than Hermes; it clears the list in rewind forks because earlier snapshots are unavailable. |
| `vision_analyze` | Partial | V4 handles bounded image inputs and browser screenshots; an agent-callable image analyzer with an auxiliary-model fallback is not established. |
| `image_generate` | Not exposed | No native generation/edit tool appears in the V4 agent registry. An external MCP server may independently provide one. |
| `video_analyze` | Not exposed | No native agent-callable video analysis tool appears in the inspected registry. |
| `video_generate`, `xai_video_edit`, `xai_video_extend` | Not exposed | No native agent-callable generation or editing counterparts appear in the inspected registry. Hermes describes these as opt-in and backend dependent. |
| `web_search` | Partial | Unix V4 sessions can use opt-in, exactly approved Tavily search through an account Vault entry. The fixed-host client pins public IPv4 addresses, disables proxies and redirects, and bounds responses. It supports one provider rather than Hermes's provider selection. Local mock tests do not establish real-provider availability. See the [runtime guide](../features/V4_RUNTIME.md) for host scope and data-directory race limits. |
| `web_extract` | Partial | An exactly approved unauthenticated GET extracts bounded UTF-8 HTML or plain text from an origin explicitly allowed in the agent browser settings. Public IPv4 addresses are pinned; redirects, proxies, browser credentials and nonstandard ports are unavailable. This is not a browser rendering or Hermes provider parity. See the [runtime guide](../features/V4_RUNTIME.md). |
| `x_search` | Not exposed | No dedicated public-X search tool appears in the inspected registry; upstream requires opt-in and xAI credentials. |
| `text_to_speech` | Partial | V4's conversation UI uses browser speech synthesis for read-aloud. It is not an agent-callable generated audio artifact or messaging voice delivery. |
| `computer_use` | Not exposed | V4 agent browser controls web pages; the inspected registry does not provide Hermes's OS-wide desktop control. |
| `mcp__<server>__*` | Conditional | V4 provides local server listing plus approved tool/resource/prompt discovery and invocation wrappers when a server is enabled. Compare registration, auth, live tool refresh and MCP host capabilities. |
| `feishu_doc_read`; `feishu_drive_add_comment`, `feishu_drive_list_comments`, `feishu_drive_list_comment_replies`, `feishu_drive_reply_comment` | Not exposed | Hermes scopes these to its Feishu document-comment handler and credentials; no direct built-ins appear in the inspected V4 registry. |
| `discord`, `discord_admin` | Not exposed | Hermes scopes these to its Discord gateway and token; no direct built-ins appear in the inspected V4 registry. |
| `yb_query_group_info`, `yb_query_group_members`, `yb_send_dm`, `yb_search_sticker`, `yb_send_sticker` | Not exposed | Hermes scopes these to its Yuanbao gateway and credentials; no direct built-ins appear in the inspected V4 registry. |
| `kanban_show`, `kanban_list`, `kanban_complete`, `kanban_block` | Not exposed | V4 workspace tasks have their own task lifecycle; the inspected agent registry has no Hermes kanban dispatcher contract. |
| `kanban_request_review`, `kanban_request_changes`, `kanban_heartbeat`, `kanban_comment` | Not exposed | No equivalent model-callable board-review/heartbeat/comment contract was found in the inspected registry. |
| `kanban_create`, `kanban_link`, `kanban_unblock` | Not exposed | No model-callable dependency-graph operation was found in the inspected registry; the synchronous read-only delegation tool is not linked to a board. |
| `kanban_attach`, `kanban_attach_url`, `kanban_attachments` | Not exposed | V4 image and file handling does not establish task-board attachment parity. |
| `desktop_project` | Partial | V4 UI supports workspace/project selection. An agent-callable project create/list/switch tool was not found in the inspected registry. |
| `manage_catalog` | Not exposed | No Hermes-style agent-callable plugin/skill catalog installation flow was found in the inspected registry. |
| `read_terminal`, `close_terminal` | Partial | V4 has UI terminals and terminal history; model-callable desktop-terminal reading or view-only closing was not established. |
| `desktop_preview`, `drive_preview`, `annotate_preview` | Partial | V4 has an in-app browser/preview and conditional approved browser actions. Inspect whether those operations target the same human-visible pane and match the requested lifecycle and annotations. |
| `read_window_below`, `focus_pane` | Not exposed | No matching model-callable OS-window metadata or application-pane focus tool appears in the inspected registry. |
| `react_to_message`, `gui_tour`, `show_tip`, `set_theme` | Not exposed | UI controls and user preferences are not evidence of Hermes-style model-callable actions. Hermes limits these tools to desktop sessions. |

## Core runtime and integration behavior

| Capability | Status and evidence | Work to establish parity |
| --- | --- | --- |
| Provider protocols and models | Partial: V4 documents Anthropic Messages, OpenAI Responses and compatible Chat Completions; other named transports are explicitly unavailable. | Inventory the exact Hermes v0.22.5 provider routes, auth flows, local models and execution backends; test configured providers separately from mocks. |
| Streaming, tool-loop limits and cancellation | Partial: V4 streams supported provider formats, bounds requests and uses scoped interaction/cancellation. | Compare retries, incomplete turns, interruption and reconnect behavior for each provider. |
| Context and compaction | Partial: V4 has model-generated compaction, recoverable source archives and request budgets. | Compare token accounting, auxiliary-model selection, compaction timing and recovery; do not treat compaction as missing. |
| Memory and skill timing | Partial: account/workspace memory and always-on saved skills are injected; opt-in on-demand skills are discoverable. | Compare session-pinned memory, background learning and progressive loading; preserve reviewed writes. |
| Scheduling recovery | Partial: V4 has owner-scoped schedules, worker leases and interruption receipts. | Close known storage-failure and mixed-version-worker gaps; compare missed runs, delivery and schedule management. |
| Messaging gateways | Partial/uninspected: local V4 source contains a Telegram gateway, but it was not run or fully audited here. | Inventory each Hermes channel's inbound/outbound, approvals, attachments and recovery against the relevant V4 integration. Do not access any private account without the user's explicit consent. |
| Plugin ecosystem | Uninspected: Hermes v0.22.5 includes core and catalog plugins; V4 has MCP configuration and installed skill support. | Inventory plugin lifecycle, security review, configuration and credential handling individually; no plugin count is a parity score. |
| User interfaces and native integrations | Uninspected for complete parity: V4 desktop/mobile browser UI and optional native shell differ from Hermes desktop and messaging surfaces. | Compare supported workflows by platform, including platform-gated tools and accessibility. The separate T3 UI reference is not Hermes UI evidence. |

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

This review inspected the published reference and selected local source only.
It did not run tests, services, integrations, or access private accounts.

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
