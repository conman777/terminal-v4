# V4 agent knowledge, recall and skill packages

The V4 runtime implements these tools in its own Rust code. It does not launch
Hermes or T3, import their implementation, or read another application's private
memory. Project `SKILL.md` files are an interoperable input format; their text is
untrusted guidance, and their supporting scripts are never executed by discovery.

## Agent tools

| Tool | Behavior |
| --- | --- |
| `recall_sessions` | List or search this account's saved V4, PTY, structured and imported app transcripts. Defaults to the current canonical workspace; explicit `scope: "account"` searches its other workspaces too. Optional source, provider, model and message-role filters narrow the results. All query terms must match a title or one message; exact phrases rank ahead of unordered matches. Returns 1–25 matches with source attribution, workspace, anchors, fingerprints and bounded redacted excerpts. By default, `offset`/`nextOffset` page through candidates and ranking is local to the returned page. Set `rankWindow: true` to rank the complete bounded scan window before paging its matches; follow `nextResultOffset` using the same `windowRevision`, candidate offset, query, filters and limit before advancing to `nextOffset` or `nextCandidatePage`. A changed window rejects continuation so the caller can restart. Ranking is not global across discovery windows. |
| `read_session` | Read around a 1-based message anchor in an owned app session. Use the `source` and `workspacePath` from recall for another transcript kind or workspace. Optional `fingerprint` rejects changed history. Each message returns up to 8000 characters, the window up to 24000; `charOffset` and `nextCharOffset` continue a long anchor message. `previousAnchor`/`nextAnchor` navigate other messages. |
| `read_context_archive` | Read an owned compaction receipt/record in24000-character redacted windows with immutable revision and continuation offset. Preserves recoverable tool evidence while excluding private reasoning, signatures and binary images. |
| `inspect_knowledge` | Read workspace, account or both scopes. Returns saved memory, bounded skill metadata, and review receipts. Full instruction/support files are read lazily. |
| `discover_skills` | List owned workspace/account packages and `SKILL.md` packages under fixed project `.v4/skills`, `.agents/skills` and `.claude/skills` roots. Does not scan home directories or provider memory. |
| `list_skill_files` | Re-resolve a discovered reference in the current scope and list instruction/support paths. Installed packages have a 200-entry/100-file scan limit and five nested levels. |
| `read_skill_file` | Read `SKILL.md` or a validated UTF-8 support file, in numbered windows of 1–200 lines. Returns a content revision and reference. Files are capped at 64000 bytes, windows at 24000 characters and individual displayed lines at 4000 characters; truncation is explicit. `charOffset`/`nextCharOffset` continue a long starting line. |
| `propose_knowledge` | Stage an account or workspace memory/package change. The runtime cannot accept its own proposal. The user reviews the exact proposal in the app before it changes saved knowledge. |

Session references look like `v4://history/structured/ss-UUID?workspace=HASH#message=4`. Skill references use
`workspace:UUID`, `account:UUID` or `installed:HASH`; file results include a
`v4://skill/...#line=N` reference. These are evidence identifiers returned by the
agent tools, not unauthenticated HTTP access links.

Recall reads only the current account's app-owned persisted records: V4 histories,
PTY snapshots, accepted user/completed assistant/tool structured evidence, and already imported native
transcripts. It never discovers or reads unimported private CLI histories. PTY
stream fragments are reassembled before redaction and exposed as attributed
terminal output blocks; they are not invented user/assistant turns. Structured raw provider envelopes, private reasoning and incomplete message deltas are excluded. Canonical structured journals use their explicit owner-bound envelope; tool completion text is redacted before returning it. A worktree is a separate
workspace; account skills and memory can be reused across its
workspaces without exposing another account's records.

Each recall page inspects at most50 candidate files and80000000 bytes including referenced visible transcript parts; each
source contributes up to2000 selected entries per discovery window. PTY files are capped at
8000000 bytes, canonical structured journals at16 MiB, imports at800000, and V4 heads at2000000. V4 visible transcripts can retain64000000 bytes through integrity-checked private parts; recall does not load opaque archived provider continuation. Oversized, invalid
or symlinked records are omitted with scan diagnostics; `candidateScanTruncated`
identifies another discovery window. Continue `nextOffset` within a window,
then advance to `nextCandidatePage` with offset zero; there is no permanent
2000-record ceiling. The engine returns continuation fields even when a page has
no matches. Metadata discovery skips preceding entries to reach a later window;
file-body reads retain the same per-call budgets. A candidate larger than the
entire budget is counted as unreadable and skipped; a candidate that only
exceeds the remaining budget is retried on the next page. Ranked-window continuations
rescan the same window and reject changes to its candidate set, source records,
scope or query; they do not provide a global snapshot across later windows.
History changes between default-mode calls can reorder discovery/offset pages;
fingerprints protect selected result reads.

Optional `updatedAfter` and `updatedBefore` filter the saved last-update time,
not the session creation time. Bounds accept RFC3339 timestamps with offsets or
`YYYY-MM-DD` at midnight UTC; the lower bound is inclusive and the upper bound
is exclusive. Invalid or missing record timestamps are excluded and counted in
`undated` when either filter is used. Some transcript formats use file
modification time when no update timestamp is saved. Relative dates are not
accepted. Keep both bounds unchanged across continuation calls; ranked-window
revisions include the filters and observed update timestamps. This is not
Hermes's session-start-time filter or a globally indexed search.

The legacy `users/<id>` PTY/structured stores use lossy ID sanitization. Agent
recall reads those stores only for exact ASCII alphanumeric/hyphen account IDs
with a unique matching account ID in the local app database. That comparison
is case-insensitive even on case-sensitive filesystems, so a database that could
collide when moved to another filesystem fails closed. Missing or ambiguous
ownership also fails closed. Current-account uniqueness does not prove that a
deleted or unrecorded account never owned the legacy directory; durable ownership
binding and reviewed migration remain necessary. Other owner IDs retain hashed
canonical structured, V4 and imported recall. No account ID is inferred from
private provider state.

## Owned skill package format

A saved skill is a real package of instruction text plus named support files:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Review changes",
  "instructions": "Read references/checklist.md, then inspect the changes.",
  "supportFiles": {
    "references/checklist.md": "Check error handling and cancellation.\n",
    "scripts/check.py": "print('example fixture')\n"
  }
}
```

Packages live inside the same atomic account/workspace JSON record as their
review receipt. Support files are addressed through the skill tools; creating a
package does not scatter executable files into the user's project or overwrite
an installed provider skill. The agent may read supporting scripts and propose
an appropriate separately approved command using the normal command permission
flow. Discovery and knowledge tools do not grant shell approval.

`activation` is optional and defaults to `alwaysOn`, preserving full instruction
injection for existing skills. An explicit `onDemand` setting instead places only
the bounded name and `account:<UUID>` or `workspace:<UUID>` reference in V4's
system context. When relevant or requested, the model is instructed to read
`SKILL.md` with `read_skill_file` and follow `nextCharOffset` and `nextLine` to
completion. References are re-resolved in the current account and workspace,
even when names or UUIDs match across scopes. Instructions and support files are
not included in on-demand metadata; explicitly adding a skill to a prompt still
includes the selected contents. Successful retrieval depends on the provider and
model supporting and choosing tool calls; custom model capabilities are not
assumed.

`supportFiles` is optional and defaults to an empty map, so older text-only skills
remain valid. The human-editable profile still contains `memory`, `skills`,
`defaultAgent` and optional `selection`.

Limits are decimal UTF-8 bytes where specified:

- 20 support files per skill; 64000 bytes per file, 128000 support bytes per
  skill, 256000 support bytes per profile.
- Relative POSIX paths up to 512 bytes. Empty, `.`, `..`, backslash, colon,
  case-only duplicate paths and file/directory collisions are rejected.
- Hidden/dot paths, `SKILL.md` support overrides, credential/key files and email
  export/message extensions are rejected.
- Existing profile limits remain: 6000 memory characters, 20 skills, 80-character
  skill names, 6000 instruction characters and 50000 combined text characters.
- Proposal input is limited to 640000 encoded JSON bytes; the complete saved
  profile and review metadata is limited to 2000000 encoded JSON bytes.

## Review and stale changes

`propose_knowledge` accepts `{scope, proposal}`; scope is `workspace` or `account`.
The proposal has `{id, title, reason, operations}` and uses the existing operations:

- `memoryAppend {content}` or `memoryReplace {before, content}`.
- `skillCreate {skill}` creates instructions and their full support map.
- `skillUpdate {id, beforeName, beforeInstructions, beforeSupportFiles, name,
  instructions, supportFiles}` replaces a package. Adding/editing/removing map
  entries creates/edits/deletes support files together.
- `skillRemove {id, beforeName, beforeInstructions, beforeSupportFiles}` deletes
  a package together.

Agent proposals also accept revision shorthands, expanded by V4 into the exact
standard operations above before staging:

- `skillFileCreate {id, path, content}` requires a new support path.
- `skillFileReplace {id, path, beforeRevision, content}` and
  `skillFileDelete {id, path, beforeRevision}` require the current file revision
  returned by the listing/read tool.
- `skillUpdate {id, beforeRevision, name?, instructions?, supportFiles?}` and
  `skillRemove {id, beforeRevision}` use the `packageRevision` returned by owned
  skill metadata. Omitted update fields preserve existing values.

Up to 10 file changes can be grouped into one package update; duplicate paths
are rejected. V4 fills the previous values from the current owner-scoped package
and preserves every untouched support file, including content hidden by model
redaction. Hash checks and the resulting exact before maps both guard stale
changes. The human sees full canonical before/after operations in the existing
review UI. New proposed credential text is still rejected, and the tool response
returns only the proposal receipt summary.

The two support maps default to empty for older proposals. A skill with support
files requires the exact old map on update/removal, preventing older text-only
clients from silently dropping its supporting files. Duplicate entry operations
are rejected. Stage validates the proposed final profile; acceptance checks the
current previous values again. A conflict leaves both the profile and receipt
unchanged. Repeated acceptance is idempotent. Manual profile edits preserve the
proposal receipts. Review history keeps up to 30 receipts and prunes the oldest
accepted/rejected entries when the complete record would exceed 2000000 encoded
bytes, reserving room for the proposed resulting profile. Pending proposals are
never pruned; a full pending queue returns an error. A shared OS writer lock
serializes API and agent CLI processes, with a five-second
bounded wait and a retryable conflict if another writer remains busy. A local
mutex also serializes threads. OS handles release the lock on process exit;
atomic record replacement keeps unlocked readers on a complete old/new snapshot.

The runtime rejects proposal text containing recognized credentials or terminal
control sequences. Tool reads redact recognized credential assignments/tokens,
URL user-info, complete/unterminated private-key blocks and terminal escape
sequences. Redaction is a defense for model
context, not a substitute for keeping secrets in the encrypted credential vault.

## Authenticated API

Workspace routes retain their existing `?path=ABSOLUTE_WORKSPACE` query:

- `GET/PUT /api/workspace/profile`
- `GET/POST /api/workspace/proposals`
- `POST /api/workspace/proposals/{id}/accept` or `/reject`

Account routes do not take a workspace query:

- `GET/PUT /api/account/knowledge`
- `GET/POST /api/account/knowledge/proposals`
- `POST /api/account/knowledge/proposals/{id}/accept` or `/reject`

Both scopes use authenticated user identity, hashed storage keys and private,
no-store responses. Account records live below `account-knowledge`; workspace
records retain `workspace-profiles`. Agent tools reject symlinked storage paths,
project skill roots and support files. Paths, scopes and references are validated
again for each tool call.

## Verification

Synthetic, temporary fixtures cover all four owned app history sources, account-wide
recall pagination/byte budgets, history ownership/workspace isolation,
redacted excerpts, message continuation, stale fingerprints, package support
listing/reads, traversal/symlink/email path refusal, proposals without application,
reviewed create/edit/delete, stale support map rejection and authenticated account
route isolation. A real local HTTP provider fixture stages/inspects a proposal
through the actual agent tool loop. Three independent writer processes verify no
profile or receipt updates are lost. They do not read actual provider history,
email or credentials,
and do not call a paid model.

```sh
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib v4_agent::knowledge
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib workspace
```
