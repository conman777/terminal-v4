# Resource efficiency implementation

The first implementation batch removes complete histories from recurring sidebar
requests and replaces per-event structured-history rewrites with synced append
records. It applies to the shared structured conversation manager, including
local Codex and V4. No history retention, tools, approvals or controls were removed.
The 23 October follow-up below adds bounded PTY delivery, deferred dialogs and
less monitoring work. Other recommendations in the
[original audit](RESOURCE_EFFICIENCY_AUDIT.md) remain future work, including PTY
storage, idle task scans, preview capture, conversation rendering and replay.

## 23 October 2026 follow-up

- Closed Settings, Bookmarks, Notes, API settings, Browser settings and Process
  Manager dialogs now mount on first use. After opening, they remain mounted
  while closed so their existing draft and selection behavior is preserved.
- The shared system-stats poller allows one current request, schedules its next
  poll five seconds after completion, and aborts on inactivity or when its last
  subscriber leaves. Resuming makes one request instead of two. Retired responses
  cannot update a newly mounted subscriber, and the last subscriber clears the
  cached sample.
- The resource monitor still samples animation frames, but publishes the average
  frame interval and updates its chart once per second instead of updating the
  entire view on every frame. Existing focus-based suspension remains in place.
- Each PTY reader now hands output to persistence through a 64-chunk channel.
  When full, only its dedicated reader thread blocks, allowing PTY backpressure
  rather than unbounded queued allocations. Each read is at most 4 KiB; normal
  UTF-8 queued text is approximately 256 KiB, with additional space possible for
  replacement characters from invalid UTF-8, one pending chunk and channel
  overhead. Saved histories and EOF drain behavior retain their existing rules.
  This bounds the handoff queue, not total session memory.

### Evidence and limits

The production frontend was built before and after these changes from the same
working checkout. An isolated headless Chrome profile used synthetic local API
responses, with all other origins blocked. At authenticated startup, the six
dialog JavaScript chunks went from **129,649 uncompressed bytes to zero bytes**
requested. This excludes their shared/transitive dependencies and CSS. Settings,
Process Manager, Notes, Bookmarks and API Settings opened successfully, the
Settings section survived closing/reopening, and neither version produced page
errors. Browser Settings has no current launch action in this desktop fixture;
its first opening was not exercised.

A controlled React Profiler regression test observed 60 renders during 60 frames
before the monitor change, versus zero during the first 960 ms afterward and one
at 1,024 ms. This verifies update frequency, not a measured whole-browser CPU
percentage. Poller tests reproduce duplicate resume requests, overlapping slow
requests and stale completion after unmount, then verify the corrected behavior.

The PTY queue test uses 900,026 input bytes containing Unicode, ANSI controls and
an incomplete final UTF-8 sequence. Before the fix, the reader consumed the full
fixture in 221 reads while the consumer was paused. Afterward it stalled at 65
reads (64 queued chunks plus one pending send), then drained the exact expected
decoded text. Existing real PTY, shutdown and final-drain regression tests also
passed as part of the API suite.

Verification: frontend suite **2,171 passed, one skipped**; API library suite
**1,010 passed, five ignored**; production frontend build, debug backend build
and changed Rust-file format check passed. The frontend build retains its
existing large-chunk warning.
Strict Clippy (`-D warnings`) reports 62 existing lint violations outside this
follow-up's edited code; that gate is not green. The frontend has no separate
configured lint or type-check script.
No total-app RAM, battery, sustained agent-load or Windows/Linux savings are
claimed. Frontend assets and the debug backend were rebuilt. The running backend
was not restarted; its queue change takes effect after restart.

## Measured comparison

Both versions used debug Rust binaries, the same synthetic local Codex app-server,
the same machine, and isolated generated accounts/workspaces. Each history size
used three fresh conversations per version. The provider emitted 200 chunks of
200 bytes and a complete final message. No native model request was sent.

| Existing text | Median backend CPU before | Median backend CPU after | CPU reduction | Median elapsed before → after |
| --- | ---: | ---: | ---: | ---: |
| None | 0.46 s | 0.09 s | 80.4% | 1.39 → 0.87 s |
| 128 KiB | 1.42 s | 0.09 s | 93.7% | 2.29 → 0.97 s |
| 512 KiB | 4.50 s | 0.12 s | 97.3% | 5.39 → 0.89 s |

All eighteen turns completed. Persisted histories retain exactly 200 deltas,
their complete 40,000-byte text, and one matching final assistant message in
every case. This is a backend integration/storage benchmark with an immediate
synthetic provider, not a model speed claim.

Twenty generated conversations with 128 KiB of text each produced the same
**2,633,921-byte** full snapshot response in both versions. The new metadata-only
response is **10,041 bytes**, a **99.62% payload reduction** for this workload.
At the existing eight-second active polling cadence this is about 18.84 MiB/min
versus 73.54 KiB/min of uncompressed JSON equivalents. The polling interval itself
and focus/idle backoff are unchanged; actual traffic depends on activity and
compression. Full history remains available when a conversation is opened.

Exact trials and method notes are in
[RESOURCE_IMPROVEMENT_MEASUREMENTS.json](RESOURCE_IMPROVEMENT_MEASUREMENTS.json).
The runs were before then after on a shared development host, not randomized.
CPU covers only the backend process; elapsed time includes provider startup,
cleanup and 100 ms receipt polling. Release builds, total application RAM,
long-duration leaks, battery and Windows/Linux results were not measured.

## Preserved behavior and storage boundaries

- `?view=inventory` is an opt-in projection. Default list/detail responses and
  authenticated WebSocket history retain their existing shapes and full events.
  Explicit sequence watermarks preserve lifecycle ordering against delayed polls;
  legacy full-snapshot responses are still accepted by the frontend.
- The existing owner-scoped file now contains a version 2 checkpoint followed
  by newline-terminated event records. File sync precedes live state updates and
  broadcasting. Acceptance and metadata operations remain atomic checkpoints.
- Journal compaction validates the existing writer/file binding before replacing
  the checkpoint. Cursor preparation is precommit; no error after successful
  rename can incorrectly roll back already-published attachments. Directory sync
  is attempted after rename and logged if unavailable, preserving the original
  atomic-checkpoint behavior. Ordinary event appends sync the existing file.
- Legacy snapshots migrate automatically. Recovery ignores only an unterminated
  final record, rejects malformed complete records or sequence gaps, then writes
  a clean checkpoint before further events. Failed writes do not broadcast or
  silently recreate missing files. Explicit retry can resume after restoring
  exactly the committed owned history; different content requires reconciliation.
- Context and knowledge readers decode appended events from the same stamped
  file. Cleanup barriers, busy state, request receipts, model/workspace binding,
  completed content and sparse legacy knowledge recall remain intact.
- The canonical 16 MiB / 32,768-event limits and terminal-event reserve remain.
  A separate bounded physical allowance covers journal framing. Earlier events
  are retained through compaction. Older version-1-only binaries cannot read
  migrated version 2 files.

## Verification

The full Rust workspace passed: 811 API tests, six core tests, and 340 provider
connection tests; three opt-in API tests remain ignored. The frontend passed
1,424 tests across 174 files and its production build. Backend compilation,
changed-file formatting and whitespace checks passed. Strict Clippy ran after
configuring the temporary toolchain and reports 60 existing diagnostics in
unchanged code, including async-trait macro warnings; none point to the new
storage, inventory projection or reader changes.

The isolated production-app browser checks passed on desktop and phone layouts:
Codex creation, separate approvals, continued conversation, reload without
duplicate messages, Stop, and username account reuse/separation. Source and
cross-interface changes also received independent review; reported recovery,
file identity and legacy-reader issues were fixed before final verification.

Remaining resource work is a subsequent batch, not a claim that the entire audit
is implemented. Event sync still occurs synchronously under the session lock;
this batch removes history-sized work rather than adding a cancellable storage
worker. A future worker must retain ownership through cancellation and preserve
the same acknowledgement boundary.
