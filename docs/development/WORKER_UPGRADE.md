# Task worker upgrade procedure

The workspace task worker owns scheduled and queued agent tasks in a data
directory. Two server versions must never run workers against the same data
directory at the same time.

## Guards

- `workspace-tasks/worker.lock` is an exclusive file lock. A second worker
  (same or different build that includes the lease) waits and takes over only
  after the first process exits.
- `workspace-tasks/worker-protocol.json` records `{"protocol": N}`. A worker
  acquires the lock first, then:
  - creates or upgrades the marker when it is absent or older;
  - refuses to start (logged as an error, no retry) when the marker is newer or
    unreadable. Restore a compatible build, or review the marker before
    deleting it.
- Builds that predate the marker still honour the lock but do not read the
  marker. They can run again after a downgrade and rewrite stores without the
  newer fields, so never downgrade over a newer data directory.

## Upgrade

1. Stop the old server and wait for the process to exit (shutdown awaits an
   already-started checkpoint, up to ten seconds; the lock is released only on
   exit).
2. Confirm no other server uses the data directory.
3. Start the new build. Tasks left running are marked `interrupted` ("outcome
   unknown after app restart"); review workspace changes before re-running.
4. Pending completion receipts under `workspace-tasks/completions/` are merged
   into owner stores by the new worker. Oversized outcomes are kept as a
   truncated receipt with an error note rather than lost.

## Rollback

Stop the new server, restore the previous data directory backup, then start the
old build. Do not roll back in place after the marker advanced.

## Outcome durability

A finished task is written to the owner store; if that fails, to a receipt
under `workspace-tasks/completions/`; if that also fails, to the fsynced
append-only `workspace-tasks/outcome-journal.jsonl`. The next worker replays
journal entries into owner stores (idempotently, only for tasks still not
terminal) and then removes the applied entries. A torn last line is ignored.

## Missed runs

When an enabled schedule is found overdue by more than its grace window, the
worker does not run it. It records `missedRuns` / `lastMissedAt` on the
schedule (visible in `list_schedules`), advances recurring schedules to the
next future slot and disables one-shot schedules. The grace window is half the
interval clamped to 2 minutes..2 hours; calendar and one-shot schedules use 2
hours. A schedule whose previous task is still in flight is overlap, not a
missed run. Both fields are absent from stored records until first used, so
older stores load unchanged (an older build that rewrites a store drops them).

## Cron schedules

`at.cron` holds a standard 5-field expression (minute hour day-of-month month
day-of-week; lists, ranges, steps, `jan`..`dec`, `sun`..`sat`, `7` for Sunday;
when both day fields are restricted either may match). It is evaluated in the
schedule's IANA `timeZone`, or its fixed `utcOffsetMinutes`. `hour`, `minute`
and `weekdays` must be absent or empty when `cron` is set; an expression with no
reachable date within eight years is rejected. A time inside a spring-forward
gap runs once at the first instant after the gap. A repeated fall-back hour
runs once, at its first occurrence. Cron schedules use the advanced storage
format, so a build without cron support fails closed instead of misreading
them. Calendar (`hour`/`minute`/`weekdays`) schedules keep their earlier
behaviour: a gap day is skipped.

## Last outcome

`list_schedules` and `GET /api/workspace/tasks` add `lastStatus` (the status of
the schedule's most recent task) and `lastError` (that task's error, or its
non-zero exit code; redacted and capped at 500 characters). They are derived
from the owner's own task store when listing and are never persisted. They are
absent when the schedule has not run or its last task was deleted. `missedRuns`
and `lastMissedAt` are omitted while zero or unset.

## Skill jobs

`create_schedule` accepts `skillRef` (`workspace:<id>` or `account:<id>`, from
`discover_skills`) and optional `skillInput` instead of `prompt`. The saved
skill's instructions become the task prompt, the approval shows that exact
prompt, and the record keeps `skill` (`skillRef`, `name`, `revision` = SHA-256
of the instructions). The task is an ordinary unattended task, so the existing
policy applies (no commands or MCP calls). Editing a schedule's prompt clears
its `skill` label.

## Messaging delivery

Not implemented. `telegram_gateway.rs` exposes no owner-bound send entry point
(its sender, configuration and token handling are private). Delivery needs a
small `pub(crate)` function there, for example one that sends text to the
owner's paired chat and reports whether it was sent; the worker could then call
it after `persist_final_record`.

## Multi-process coverage

`workspace_tasks::worker_process_tests` re-executes the test binary as real
worker processes on one temporary data directory, with a fake `codex` (via
`CODEX_BIN`): two contending workers run a due schedule once and the standby
takes over after `kill -9`; an older worker refuses a newer protocol marker;
shutdown mid-run stops the agent process and is not re-run; owner-store loss
(mid-run and after completion) is journaled and replayed by the next worker.

## Known limits

- If the owner store, every receipt and the journal all fail, the worker
  retries indefinitely holding ownership. If the process exits during that
  window, the task stays `running` and is reported `interrupted` ("outcome
  unknown") after restart. This is the only case where a result is lost.
- Journal entries for an owner whose store is missing or unreadable are kept
  until that store loads again.
- A checkpoint already in progress at shutdown is awaited (bounded by the
  ten-second shutdown wait); one still waiting for the lock is abandoned and
  the task is recorded as interrupted before launch.
- Cron expressions use wall-clock matching: a fall-back repeated hour fires
  only for its first occurrence, so a wildcard-minute job does not run again
  during the repeated hour.
- A skill job runs a snapshot of the saved skill's instructions taken at
  review. Later edits to the skill do not change the schedule; support files
  are not included.
- A task that loses access to its owner store mid-run is stopped and recorded
  as `failed` ("Task storage became unavailable"); the outcome is journaled
  and replayed, never re-run.
