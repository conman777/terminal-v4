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
- `list_schedules` reports next/last run and missed-run fields but not the last
  task's status or error; those require the task store and remain a gap.
