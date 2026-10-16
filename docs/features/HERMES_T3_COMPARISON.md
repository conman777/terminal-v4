# Hermes, T3 Code, and Terminal v4: source comparison

This comparison records the downloaded source snapshots and Terminal v4 baseline
before runtime integration. The current implementation and remaining boundaries
are documented in [Workspace feature guide](HERMES_T3_WORKSPACE.md).

## Central difference

**Hermes owns an agent engine:** it connects models to executable tools, controls
conversation context, recalls past work, and curates memory and skills.

**T3 Code owns a development workflow around provider runtimes:** it normalizes
provider sessions, tracks durable tasks, prepares workspaces, records checkpoints,
and connects review, approvals, delegation, and remote clients to that timeline.

Both have grown beyond that distinction. Hermes also has Git review, worktrees,
checkpoints, and scheduling. T3 also has scheduling, skills discovery, cross-thread
search, and application-owned cross-provider delegation.

**Terminal v4 baseline owns terminal and preview tooling:** native agents run
inside PTYs, with one structured Claude adapter and a separate API reply streamer.
The first workspace feature batch adds manually curated project knowledge, skills,
and stored task defaults. Those additions do not constitute an autonomous agent
learning loop or a durable multi-provider task orchestrator.

## Feature-by-feature comparison

| Area | Hermes | T3 Code | Terminal v4 before runtime integration |
| --- | --- | --- | --- |
| Agent execution | Own model/tool loop; provider registry and configurable execution environments | Controls provider runtimes behind normalized adapters, with application-owned task orchestration | PTY launchers, structured Claude adapter, and API text streaming; API runner has no executable tool loop |
| Provider integration | Inference provider profiles/plugins; some transports use external runtimes | Native harness integrations, account/instance ownership, capability mapping, resume and handoff | Many labels and legacy provider definitions; active structured manager registers Claude only |
| Persistent knowledge | Agent-managed bounded environment notes and user preferences, loaded as session-start snapshots | Provider-native memory may apply; no equivalent T3-owned curator found in inspected production code | Manual per-user/per-directory project notes, explicitly inserted into prompts |
| Learning from work | Separate background agent reviews conversations and proposes/writes memory and skill updates | Native provider behavior may learn; no equivalent app-owned learning loop verified | No automatic learning or proposed-update review queue |
| Skills | Discovers, loads, creates, patches, and deletes skill instructions and support files | Discovers provider-native skills for the composer and preserves native scope/invocation behavior | Manually stored name/instructions fields; no provider-native discovery or support-file lifecycle |
| History search | Agent-callable FTS5 search, filters, anchored context windows, session links, and recall after compaction | Cross-thread message search plus in-thread find; thread read/list tools; native session import | Sidebar searches titles/topics/paths; saved body history is not indexed across conversations |
| Context management | Own compression, tool-output budgets, frozen memory snapshots, and retrieval | Native provider compaction plus budgeted portable history handoffs between providers | Native CLI owns context; app records output/events without its own compaction/handoff system |
| Git review | Uncommitted/branch/last-turn review, staged/unstaged patches, commit/push/PR actions | Checkpoint-based authored turn/thread diffs, split/unified views, PR/review workflows | Aggregate change counts and branch operations; commands otherwise run in terminal |
| Isolated tasks | CLI/web worktrees and optionally isolated delegated children | Root/existing/new worktree launch, preparation progress, setup scripts and retries | Session cwd selection; no managed worktree task lifecycle |
| Rollback | Optional filesystem snapshots around own mutating tools, including ordinary directories; safe restore guards | Hidden Git refs and temporary indexes; coordinates file restore with provider conversation rollback | No application-managed checkpoint or coordinated rollback |
| Delegation | Child agents with fresh contexts, constrained tools, budgets, parallel execution and steer/stop controls | MCP-enabled cross-provider child tasks, optional worktrees, durable completion and parent wakeup | Multiple independent sessions; the API ensemble combines answers rather than orchestrating executable child tasks |
| Approvals | Execution approvals plus optional durable memory/skill write staging and stale-write checks | Provider-aware action approvals and permission modes, including session-wide options where supported | Structured boolean approval channel; broader permission UI is disabled pending enforcement |
| Scheduling | Agent cron tool, fresh sessions, optional skills/models/workdirs/scripts, result delivery through gateway channels | Persisted interval/time/webhook tasks, new or bound threads, run status/errors and missed-run handling | No application-owned agent scheduler found in the active Rust runtime |
| Remote access | Messaging gateway plus tool backends such as local, Docker, SSH, Modal, Daytona, Singularity and Vercel Sandbox | Paired multi-environment web/desktop/mobile clients; execution and credentials stay on the owning server | Browser/mobile access to the application host, with PTY/session management |
| Task input | Agent toolsets and skills across chat/channel surfaces | Rich composer context references, file attachments, quotes, native skills, queued messages and steering | Composer, voice and image/file context; explicit project-knowledge insertion |
| Browser/developer workflow | General-purpose browser/search/computer tools as agent actions | Captures and context attachments tied to coding tasks; provider/browser integration | Embedded app preview, console/network/storage/performance inspection, screenshots and process/system tools |

“Not found” describes the inspected production code, not a proof that a feature
can never exist through plugins or an underlying provider.

## Differences that matter when combining them

### Memory is different from saved notes

Hermes's memory is callable by the agent, is curated across tasks, and interacts
with session boundaries and historical recall. Its background learning spends
real model inference. Optional approval gates are disabled by default in the
inspected revision; reviewed learning would be a deliberate Terminal v4 policy.

The current Terminal profile stores text selected by the user. A notes editor
alone does not reproduce learning, automatic recall, user modeling, or skills
with supporting files.

### A diff panel is different from turn-aware review

Both reference apps can show Git changes. T3 records checkpoint transitions and
authored paths so changes introduced by pulls/merges do not get misattributed to
an agent turn. Its rollback coordinates the repository and native conversation.
Hermes can capture a file before its own mutating tool and compare later hashes
to avoid overwriting subsequent user edits.

Terminal v4 needs reliable turn records and provider lifecycle events before it
can offer equivalent attribution or rollback.

### Several tabs are different from delegation

Hermes children receive explicit contexts, tools and budgets. T3 records child
tasks and routes completion back to a parent, including across provider types.
Independent terminal tabs provide neither that contract nor durable coordination.

### Both schedule tasks, but own different lifecycles

Hermes starts fresh agent sessions and delivers results to configured messaging
destinations; continuity can load previous job outputs. T3 schedules application
threads on an owning environment and persists their status. A Terminal v4 scheduler
would need a defined runtime, identity, cancellation, and result-delivery contract.

## Current Terminal v4 runtime gaps

Two concrete gaps were found while tracing the source:

1. Provider catalog and auth endpoints are registered by the legacy Fastify route
   registrar, but are absent from the active Rust router. The frontend model/auth
   UI requests those endpoints. Catalog-mocked UI tests do not establish live Rust
   runtime integration.
2. The legacy API runner streams text replies and stores user/assistant messages.
   It does not expose executable tools or dispatch model tool calls. Connecting an
   API provider is therefore different from giving it Hermes-style agent abilities.

The active Rust structured session manager also initializes only a Claude
provider. Other native agents can still run in PTYs, but the app does not thereby
gain their normalized protocol, capability or checkpoint integrations.

Relevant Terminal sources:

- backend/src/routes/agent-catalog-routes.ts, registration at line 179.
- backend/src/routes/agent-auth-routes.ts, registration at line 32.
- backend/src/routes/register-core-routes.ts, registrations at lines 92–93.
- frontend/src/components/AgentModelPicker.jsx, catalog request in loadCatalog.
- rust/crates/api/src/lib.rs, protected route construction at lines 104–105.
- rust/crates/api/src/structured.rs, provider initialization at lines 86–87.
- backend/src/agent/api-agent-runner.ts, message type at line 6 and runtime loop at line 234.

## Recommended combination

This is an engineering recommendation based on the source comparison:

1. Establish one active provider contract and fix Rust catalog/auth integration.
   Normalize native events, capabilities, identity, lifecycle and continuation.
2. Use T3's task/workspace design for durable tasks, message queues, worktrees,
   checkpoint diffs, review, cancellation and multi-environment ownership.
3. Connect Hermes-style executable tools, agent-accessible history recall, bounded
   memory and skill management to that runtime. Add explicit review for learned
   changes and preserve native provider memory behavior where appropriate.
4. Build scheduling and delegation on those durable contracts.
5. Keep Terminal v4's existing preview, DevTools, PTY and process/system features
   as useful workspace surfaces.

An alternative is to integrate Hermes as a first-class runtime rather than
reimplementing its entire agent engine. This reuses its learning/tool behavior but
adds a Python runtime and protocol boundary. Building that behavior directly into
Rust keeps one backend but requires substantially more agent-runtime work. Native
coding-provider adapters remain useful in either approach.

## Pinned source evidence

Hermes revision:
[79651b71bd56efd76d06f3de1df64dde09b58ff3](https://github.com/NousResearch/hermes-agent/tree/79651b71bd56efd76d06f3de1df64dde09b58ff3)

T3 revision:
[7ac952c630ef8a60d14ca8f6a0c7adce33db4bae](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae)

| Area | Hermes evidence | T3 evidence |
| --- | --- | --- |
| Execution/ownership | [Agent loop](https://github.com/NousResearch/hermes-agent/blob/79651b71bd56efd76d06f3de1df64dde09b58ff3/run_agent.py), [tool executor](https://github.com/NousResearch/hermes-agent/blob/79651b71bd56efd76d06f3de1df64dde09b58ff3/agent/tool_executor.py), providers/README.md | [Architecture](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/docs/internals/overview.md), packages/provider-core/src/server/ProviderAdapter.ts |
| Memory/learning/skills | tools/memory_tool_store.py, tools/memory_tool.py, tools/write_approval.py, agent/background_review.py, tools/skill_manager_tool.py, tools/skill_manager_batch.py | apps/server/src/provider/Drivers/ClaudeSkills.ts, packages/provider-cursor/src/server/skills.ts, apps/web/src/providerSkillSearch.ts |
| Search/context | tools/session_search_tool.py, hermes_state.py, agent/context_compressor.py | apps/server/src/orchestration-v2/ThreadSearch.ts, ThreadFind.ts, apps/server/src/project/AgentSessionScanner.ts, docs/user/portable-handoffs.md |
| Git/worktrees/rollback | hermes_cli/web_git.py, tools/checkpoint_manager.py, tools/subagent_worktree.py, hermes_cli/worktree_ops.py | apps/server/src/orchestration-v2/ThreadLaunchService.ts, CheckpointRestoreSafety.ts, apps/server/src/checkpointing/CheckpointDiffQuery.ts, apps/server/src/vcs/GitVcsDriver.ts, apps/web/src/components/DiffPanel.tsx |
| Scheduling/delegation | tools/cronjob_tools.py, tools/cronjob_job_args.py, tools/delegate_tool.py, tools/delegate_tool_config.py, tools/delegate_tool_toolsets.py | packages/contracts/src/scheduledTask.ts, apps/server/src/scheduledTasks/ScheduledTaskService.ts, apps/server/src/mcp/toolkits/orchestrator/tools.ts |
| Permissions/input/remote | gateway/platforms, tools/environments | docs/user/permission-modes.md, docs/user/composer.md, docs/user/remote-access.md, docs/user/snap-shot.md |

The full repositories remain in the original checkout's ignored
output/reference-sources directory. This comparison reads pinned source;
it is not a benchmark or a claim that both apps were installed and exercised.
