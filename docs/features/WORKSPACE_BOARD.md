# Workspace board backend

**Not available:** the route registration and the navigation entry are disabled
while authorization, workspace identity, and durable receipt recovery are being
hardened. The endpoints below describe the proposed contract, not a deployed API.

The board is a durable list of manual planning items. It does not start tasks, execute agents, or synchronize session todos. It is scoped by authenticated owner and the canonical path of an existing absolute workspace directory; aliases resolving to the same directory share a board. Paired clients are denied until a specific permission is designed.

The test-only routes check the canonical workspace against the existing file-root and owner-managed-checkout policy. An integration test covers another owner's checkout and, on Unix, a symlink to it. Unix reads and mutations require local authority and use the existing owner-authorized database transaction with a final authority check. Tests cover missing, expired, revoked and wrong-owner authority and requests submitted while logout is paused. The latter test does not prove the requests reached the admission fence before logout resumed. Admission runs on the blocking pool; a single-thread runtime test checks responsiveness, and controlled tests confirm cancellation both while waiting and after a write but before its final check rolls back the mutation. A pinned directory identity is checked before and during the transaction; tests cover replacement before the last check and alias retargeting. Cancellation or a workspace replacement after the final check can still race the commit, so clients must retain the operation ID and review uncertain results. These checks are not sufficient to enable the routes.

Authenticated routes (responses are `private, no-store`):

- `GET /api/workspace/board?path=...` returns `{ "items": [...] }`.
- `POST /api/workspace/board` accepts `{ "path", "operationId", "title", "description"? }` and returns the created item.
- `PATCH /api/workspace/board/{id}` accepts `{ "path", "operationId", "expectedRevision", "title"?, "description"?, "status"?, "blockedReason"? }` and returns the updated item. `blockedReason` can be null to clear it.
- `DELETE /api/workspace/board/{id}` accepts `{ "path", "operationId", "expectedRevision" }` and returns `{ "id", "deleted": true }`.

Items have UUID `id`, `title`, `description`, `status` (`open`, `in_progress`, `blocked`, `review`, or `done`), nullable `blockedReason`, positive `revision`, and `createdAt`/`updatedAt` timestamps. New items start at revision 1 and status `open`; every accepted patch increments revision. The board does not enforce a relationship between status and blocked reason.

Each mutation requires a UUID operation ID. The test-only implementation records successful mutations, their canonical workspace, exact request bytes, method, target, and response atomically with the change. Operation IDs are unique per owner across workspaces: reuse with a different workspace, bytes, method, or target conflicts. Retrying an identical successful request returns its original response; stale revisions return 409. An item outside the owner/workspace scope returns 404. Failed operations are not receipted. Clients must preserve the request bytes when retrying. Schema initialization fails closed if exactly one of the item and receipt tables is missing; it cannot distinguish a fresh installation from loss of both tables or a database rollback. Durable installation identity and commit-time authorization are not yet established.

A board holds at most 1,000 items and 100,000 successful mutation receipts; reaching a limit rejects further applicable mutations with 409 rather than discarding idempotency history. Titles are limited to 512 bytes, descriptions to 16,384 bytes, blocked reasons to 4,096 bytes, and mutation bodies to 40,000 bytes. Unknown fields and invalid values are rejected. The internal `workspace_board::mutate` boundary accepts an already authenticated owner and canonical workspace; callers must establish those authorities before calling it. It performs no task execution.
