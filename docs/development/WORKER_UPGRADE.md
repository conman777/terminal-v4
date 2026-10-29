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

## Known limits

- If both the owner-store write and every receipt write keep failing, the worker
  retries indefinitely holding ownership. If the process exits during that
  window, the task stays `running` and is reported `interrupted` after restart
  with its result unrecoverable.
- Missed recurring runs coalesce into one catch-up run after downtime; there is
  no grace window that skips stale runs.
