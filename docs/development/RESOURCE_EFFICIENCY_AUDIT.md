# Resource efficiency audit

The first implementation batch now addresses inventory payloads and structured
stream persistence. See [implemented changes and before/after measurements](RESOURCE_EFFICIENCY_IMPLEMENTATION.md).
The findings and source references below record the original audit baseline;
the remaining recommendations have not been implemented in this batch.

The idle Codex conversation has a small backend footprint in the measured local workload. The largest scaling costs come from repeatedly processing complete histories, frequent idle scans, and retaining duplicate terminal representations. The recommended changes preserve full history, tools, approvals, cancellation, replay, and accessibility.

The audit covers the current Rust API and React frontend on 20 October 2026: startup, idle work, saved conversations, streaming, PTYs, preview instrumentation, replay, storage, and agent lifecycle. Resource changes below are recommendations; this implementation changes only local testing account access and its authentication boundaries.

## Measured behavior

The measurements use the debug Rust backend, production frontend assets, headless Chrome, an empty workspace, and generated accounts/history on macOS. No model requests or private histories were used for these audit workloads. CPU is backend process CPU time divided by elapsed time, expressed as a percentage of one CPU core. RAM is that process's resident set; browser values are JavaScript heap samples. Browser engine/GPU memory, shell child processes, and active model/tool processes are additional.

Each quiet-window sample lasts about 20 seconds, with no simulated typing. Focus-aware polling can pause or back off in this browser setup. These short samples are observations, not total application memory budgets, leak tests, or sustained foreground benchmarks. The host was shared with development work.

| Workload | Backend resident memory | Backend CPU, one core | Browser JS heap |
| --- | ---: | ---: | ---: |
| One idle Codex conversation, no running agent | 32.4 MiB | 0.10% | 5.8 MiB |
| Same conversation plus five idle `/bin/sh` PTYs | 34.7 MiB | 2.15% | 4.8 MiB |
| Twenty generated conversations with about 2.5 MiB of saved text | 50.2 MiB | 0.15% | 8.0 MiB |

The final row follows the earlier workloads in the same backend process. Allocator retention and loaded owner caches contribute to its resident memory, so it does not isolate a per-conversation cost.

The actual structured-session inventory response for those twenty conversations is **2,634,471 bytes**. While the user is active, the source allows inventory polling every eight seconds: the equivalent uncompressed JSON volume would be about **18.8 MiB/minute** at that cadence. That is a calculation from measured payload size and source interval, not observed steady-state traffic; idle/focus backoff and HTTP compression affect actual transfer.

### Streaming and existing history

A controlled synthetic app-server emitted 200 chunks of 200 text bytes, followed by completion, through the real Codex adapter and session manager. Each case completed successfully. This measures backend integration/persistence work with an immediate synthetic provider, not inference latency. Receipt polling occurred every 100 ms; each case is a single run.

| Existing text before the turn | Completion elapsed time | Backend CPU time | Final snapshot |
| --- | ---: | ---: | ---: |
| None | 1.71 s | 0.48 s | 112,345 bytes |
| 128 KiB | 2.39 s | 1.47 s | 243,558 bytes |
| 512 KiB | 5.53 s | 4.66 s | 636,774 bytes |

The same 40,000 newly streamed text bytes required substantially more CPU as existing history increased. Source inspection confirms that each event copies, serializes, and rewrites the accumulated snapshot. The current event format also retains deltas and the final full assistant message.

The accompanying `RESOURCE_AUDIT_MEASUREMENTS.json` preserves the measured values separately from estimates.

## Recommended priorities

| Order | Change | Expected benefit | Main preservation requirement |
| --- | --- | --- | --- |
| 1 | Metadata-only session inventory with explicit status sequence | Remove complete transcripts from recurring sidebar requests | Keep cleanup ordering, activity badges, search, and explicit history access |
| 2 | Event-driven task wakeups and shared discovery polling | Reduce idle disk work and duplicate requests | Keep schedule deadlines, restart recovery, and URL discovery |
| 3 | On-demand preview runtime capture and genuinely deferred modals | Avoid unused instrumentation and module initialization | Preserve requested recording and first-open behavior |
| 4 | Append-based durable structured and PTY history | Stop repeatedly copying/rewriting all prior output | Preserve exactly acknowledged work, recovery, approvals, and final drain |
| 5 | Stable conversation rows and incremental replay/Reader rendering | Reduce CPU as visible histories grow | Preserve text fidelity, seeking, selection, and accessibility |
| 6 | Paged history, byte budgets, and bounded output framing | Bound memory under long sessions and high output | Preserve older output through storage and backpressure |

The persistence redesign has the largest active-work potential, but requires more careful recovery testing than the first three changes. No percentage saving is established until each change has a measured before/after comparison.

## Backend findings

### Complete histories are used for inventory

`rust/crates/api/src/structured.rs:248` constructs a full snapshot, including all events, for every owned conversation. `frontend/src/contexts/TerminalSessionContext.jsx:328` fetches this alongside app state; its active polling interval is eight seconds at `:1068` and backs off with inactivity. `buildStructuredSession` also derives status ordering from the events.

Return an inventory DTO containing identity, title, workspace, model, timestamps, status, and explicit `statusSeq`/`latestSeq`. Leave full event retrieval on explicit history, WebSocket replay, and search paths. Verify reload, rename, project grouping, stale polls, cleanup recovery, and the existing selection/draft coherence test. Merely omitting events without the sequence field would weaken lifecycle reconciliation.

### Every structured event rewrites its accumulated history

`rust/crates/api/src/structured.rs:1393` scans event identity, clones the current events into a snapshot, checks bounds by serializing it, and persists it. `:1618` clones and serializes again, writes a temporary file, calls `sync_all`, and atomically replaces the saved file. This synchronous work occurs while holding the session's async mutex.

Use an ordered storage actor with an append journal or transactional event table, plus periodic compact snapshots. Preserve the rule that acknowledgement follows durable acceptance. Sequence, acceptance, approval, cancellation and completion boundaries must remain recoverable; display updates can be coalesced without discarding canonical events. Moving the same full rewrite into `spawn_blocking` improves executor availability but does not remove its cumulative disk/CPU cost.

### PTY output has growing copies and an unbounded handoff

`rust/crates/api/src/terminal.rs:1253` retains output history; `:1983` copies and serializes the accumulated history during output persistence. The reader-to-consumer channel is unbounded at `:1868`. Slow persistence or rapid output can therefore retain both a growing transcript and a queued second copy.

Persist append records, maintain a metadata index and bounded in-memory tail, and use bounded lossless backpressure from the existing reader thread. Keep complete output accessible on disk. Test split UTF-8, ANSI sequences, final output during exit, disconnect/reconnect cursors, slow disks/clients, restart recovery, search and copy. Lowering retention limits alone would lose product behavior.

Terminal metadata loading also reparses saved histories at `terminal.rs:400` and `:1363`; an index can avoid that work during listing and recovery.

### Idle task work scales with saved owner stores

`rust/crates/api/src/workspace_tasks.rs:1362` wakes a task-claim scan every 500 ms. `:1092` loads owner stores; `:1138` compares serialized stores around mutation. The scan reads/parses stores twice and serializes them twice even when no task is runnable.

Use notifications for task mutations and a timer for the earliest scheduled deadline, with occasional reconciliation for changes made by other processes. Keep restart recovery, schedule catch-up policy, cancellation, worker shutdown, the existing three-task concurrency cap, and per-workspace exclusion. Measure populated stores; the small idle sample does not represent this worst case.

### Histories and process logs need aggregate memory policy

`structured.rs:1482` loads an owner's saved histories together and retains them in the manager. A per-file 16 MiB limit does not bound aggregate memory over many conversations. Load history on demand behind lightweight metadata and evict inactive cached bodies without deleting disk data.

`rust/crates/api/src/processes.rs:7` permits 1,000 log entries of up to 50 KiB per process, a theoretical 48.8 MiB before object overhead. Exited records remain in the process map. At `:329`, line reading can allocate an unlimited newline-free line before truncation; slicing at an arbitrary byte boundary can also split UTF-8. Bound framing before allocation, drain excess bytes through the newline, truncate at character boundaries, and use byte-budgeted live rings with persisted older/exited logs.

### Preview response limits apply after allocation

`rust/crates/api/src/preview/external_proxy.rs:48` awaits the entire upstream response body before checking its 10 MiB limit. Read bounded chunks, as the local proxy already does, and stop once the limit is crossed. Preserve redirect limits, DNS pinning and URL checks. Test oversized chunked bodies, absent/incorrect Content-Length, redirects and cancellation.

`rust/crates/api/src/preview/proxy.rs:32` also creates an HTTP client for each local asset request. A shared bounded local-preview client can reuse connections. External preview pooling needs separate care because the current validation binds requests to approved resolved addresses.

### System monitoring initializes more data than its endpoint needs

`rust/crates/api/src/system_stats.rs:41` eagerly creates `System::new_all`, while the current endpoint refreshes CPU and memory and re-enumerates disks at `:62`. Narrow initialization to required data and share short-lived disk samples. Keep the current shared, activity-aware UI polling and verify displayed system readings before changing sampling cadence.

## Frontend findings

### Preview runtime telemetry runs without a visible consumer

`rust/crates/api/src/preview/script_inject.rs:289` installs performance capture; `:384` starts an unconditional animation-frame loop. Runtime samples are batched into roughly thirty metric POSTs/minute while a visible preview is active. `frontend/src/components/devtools/DevToolsPanel.jsx:9` hides the Performance tab by default, but that does not disable collection. Browser throttling reduces hidden-tab animation work; this is not a measured 60 Hz hidden-tab cost.

Keep cheap initial navigation/vitals data and subscribe to continuous FPS/heap/long-task capture only while viewing or recording it. Preserve explicit recording across panel closure if requested. Console information also travels through both parent messaging and POST; consolidate delivery while retaining reconnect recovery.

### Closed lazy modals still load on startup

`frontend/src/App.jsx:1467` renders six lazy modal components with `isOpen=false`. The import resolves before the component can return null. The current build's Settings, Notes, Bookmarks, API settings, Browser settings and Process Manager chunks total about 116 KiB raw / 32 KiB gzip, excluding dependencies and CSS.

Mount on first use. If a dialog currently retains unsaved settings while closed, use a loaded-once latch rather than destroying its state on every close. Verify no module requests before first use, each modal's first opening, retained drafts and account/environment changes.

### Streaming renders scale with all previous messages

`frontend/src/hooks/useStructuredSession.js:265` scans/copies the messages array on assistant deltas. `frontend/src/components/DesktopConversationView.jsx:1226` rebuilds row input objects. `ToolCallBlock.jsx:257` and `:630` split output even for collapsed rows, so its memo boundary is less effective than it appears.

Use stable completed message objects, indexed lookups and memoized tool summaries. Coalesce text projection updates to an animation frame or a short 30–50 ms window while processing approval, Stop and receipt state immediately. Window older DOM rows while keeping full accessible history. Test long tool-heavy chats and verify final text is byte-for-byte equivalent.

### Terminal and Reader representations multiply memory

`frontend/src/utils/terminalSurface.js:17` permits 100,000 desktop scrollback rows and twenty million history characters; mobile allows 10,000 rows and two million characters. `TerminalChat.jsx:408` also retains history entries and a joined representation. Filled 100,000-row, 80-column xterm cell arrays alone have a **91.6 MiB theoretical capacity** at twelve bytes per cell; this excludes objects, text, rendering and more columns. Installed xterm uses three Uint32 values per cell (`frontend/node_modules/@xterm/xterm/src/common/buffer/BufferLine.ts:22` and `:68`). It is not measured idle RAM. Split panes multiply retention.

`TerminalChat.jsx:723` visits xterm rows/cells for Reader conversion before trimming mobile to 2,000 lines, and `ReaderView.jsx:196` renders retained spans. Desktop also maintains Reader text during terminal display at `TerminalChat.jsx:3115`.

Use a bounded live terminal tail with paged history and incremental Reader projection. Preserve ANSI attributes, wrapping, cursor positions, scroll anchors, search, selection/copy and screen-reader behavior. Do not silently make older output inaccessible.

### Replay repeats full work and downloads

`frontend/src/components/SessionReplayPanel.jsx:27` resets xterm and replays the preceding transcript on each 100 ms playback tick. `:59` re-fetches selected recordings every three seconds, including completed recordings.

Append newly elapsed events during forward playback; rebuild only when seeking backward or switching recordings. Cache immutable completed recordings and fetch incremental events for active recordings. Validate exact terminal state at seek positions and each playback speed.

### Preview discovery has duplicate pollers

`frontend/src/contexts/PreviewContext.jsx:95` polls ports every ten seconds when a preview exists; `PreviewPanel.jsx:677` independently polls every five seconds while visible. This permits about eighteen discovery requests/minute before user-triggered refreshes. The context slows to thirty seconds while inactive; the panel pauses.

Share a single-flight cache with activity-aware subscribers. Keep immediate refresh when opening the port picker and updates when processes start/stop, so discovery responsiveness remains available.

## Preserve existing resource safeguards

- Codex and V4 conversation views do not mount xterm. Native Codex app-server processes are created for active turns and cleaned up after completion (`structured/codex.rs:105`). This favors low idle memory. Measure real startup/tool initialization before considering a bounded warm-worker option, which would retain memory between turns.
- Inventory polling already pauses for inactive windows and backs off while idle; equivalent state replacements are skipped.
- Terminal writes are frame-batched with client-side queue bounds and recovery behavior; mobile WebGL is disabled.
- V4 browser processes start on approved browser use (`v4_agent/browser.rs:1348`), and MCP clients initialize lazily after approval (`v4_agent/integrations.rs:570`). Keep turn resource cleanup.
- Workspace background tasks are capped at three. Interactive agent sessions have their own per-session busy checks; choose any additional global budget only after measuring native agent/tool costs, and expose queuing/cancellation rather than silently skipping work.
- Process-tree tracking checks descendants every 50 ms (`process_tree.rs:151`). Consolidating inspection may reduce idle-shell cost, but simply slowing it could weaken descendant cleanup. Measure and preserve the orphan tests before changing it.

## Verification and remaining measurements

Source inspection covered the named paths, with independent frontend/backend reviews. Runtime evidence includes the three quiet workloads, actual large-inventory response size, synthetic streaming through the adapter, and username account browser tests. The local account implementation passes creation/reuse, normalization, account separation, password-account preservation, origin restrictions and disabled-mode token checks, including preview/query WebSocket paths.

Before choosing performance budgets or shipping optimizations, add repeated release-build measurements; real Tauri/WebKit and physical-phone profiles; sustained output, long histories and multiple mounted panes; foreground/background transitions; large task stores; active native agents, browser/MCP processes; and Windows/Linux measurements. These were not benchmarked here. No long-duration leak or battery claim is established.

For each optimization, compare CPU time, resident memory, transferred bytes, serialization/write volume, p95 interaction latency and recovery results on the same workload. Acceptance requires unchanged history fidelity, request identity, approvals, cancellation cleanup, scheduling, preview behavior, replay and accessibility. Active external agents and browsers will still need resources; concurrency budgets trade parallel throughput for lower peaks and should be visible to users.

Implementation verification: the Rust core tests, full API tests (798 passed, three opt-in tests ignored), provider-connection tests (340 passed), full frontend suite (1,413 passed), and username-only browser test passed. Production frontend and backend builds, changed-file formatting and whitespace checks passed. Clippy was unavailable in the configured local toolchain. The username-only change and this source-plus-controlled-workload audit are complete for the declared scope; performance optimizations remain proposed.
