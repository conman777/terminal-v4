# V4 model compaction and durable history

V4 implements this feature in its own Rust runtime. It uses the selected account's configured provider through the same original transport adapter. It does not launch Hermes or T3 and does not read either application's private state.

## Commands and context guards

The CLI accepts `/compact` and `/compact additional summarization instructions`. Instructions are limited to 4,000 Unicode code points. LF, CR and tab are allowed; other control characters are rejected before command acceptance. `/context` reports serialized request bytes and the most recent provider-reported token counters when available. Structured clients invoke a separate authenticated compact command with a request ID and optional expected conversation revision; transcript text and tool output cannot initiate that command.

Before every normal provider request, V4 measures the retained native history,
current system instructions, tool declarations and selected reasoning/thinking
configuration as serialized text and metadata before image hydration. Stored image references, or the existing text-only model placeholders, follow the normal protocol projection; hydrated image binary and unsent drafts are excluded. The default guard is600000 bytes, automatic summarization starts at420000, and ordinary requests stop above520000 to reserve output room. Verified model context-window metadata can reduce these conservative byte limits; bytes are never presented as measured tokens. Binary attachment limits remain separate. Versioned usage attribution binds provider, model, protocol, system instructions, tools and reasoning. Changed or unknown legacy bindings hide old counters. Each unsafe counter is unavailable independently; a reported zero remains zero. Cached-input, cache-creation, output and auxiliary-summary usage stay separate; missing provider counters remain unknown.

An automatic failure is attempted once per turn. The unchanged request can continue only while it fits the safe budget. Further growth stops before the hard limit. A successful summary must free useful room; it cannot repeatedly summarize an unchanged history. The public source projection is limited to 1,024,000 UTF-8 bytes and at most
16 chunks of 64,000 bytes each, with a 24,000-byte structured summary and a
60-second overall budget. Splitting preserves UTF-8 character boundaries. If
that requires a 17th chunk near the projection limit, V4 rejects the operation
before any auxiliary provider request, reports the failure and leaves the source
history unchanged. The default uses the same selected provider/model; no additional provider is silently selected.

## What is summarized

The auxiliary request includes current account/workspace privacy instructions, optional user guidance, the prior structured summary and a bounded public projection of earlier records. It merges goals, constraints, decisions, completed work, work in progress, blockers, relevant files, next steps and critical context. The original user request is also retained verbatim after credential redaction. A model summary is fallible; raw evidence remains recoverable.

Private reasoning, encrypted reasoning, signatures and binary images are excluded from auxiliary requests. The current native turn retains complete tool-call/result groups and image-helper records. Large tool text above64000 bytes can be replaced by a marked24000-byte beginning and8000-byte end, with an immutable source reference. Raw outputs and opaque provider continuation stay in the private archive. User-visible messages are never deleted by compaction.

The agent-callable `read_context_archive` tool reads an owned session/receipt/record reference in24000-character windows with an immutable revision and continuation offset. It returns redacted public/tool evidence, never private reasoning or binary payloads.

## Persistence and recovery

Legacy flat session JSON remains readable. New sessions keep a head at or below2000000 bytes. Visible messages spill into immutable transcript parts when the recent tail exceeds128000 bytes. Oversized native continuation is likewise stored by an integrity-checked reference. The shared runtime, recall and rewind readers reconstruct the same retained visible conversation.

A private session writer lock and revision compare-and-swap protect updates. Compaction first prepares a separate candidate, then writes synchronized immutable raw-history/receipt objects and publishes one atomic head. The live in-memory session changes only after successful publication. Provider, JSON validation, cancellation observed before commit, stale-revision
and pre-publication storage failures leave the original head and snapshot intact. A failed event delivery after a successful commit does not undo that durable commit; clients reload its status/receipt.

Receipts record source revision, prior archive link, provider/model, retained boundary, before/after bytes, structured summary and auxiliary usage. Rewind expands verified compaction lineage and cuts only at a complete native user-turn boundary, preserving tool correlation and private continuation. Copied image references are re-owned by the new fork. Legacy excerpt-only histories that have already lost native correlation are rejected for an unsafe rewind rather than inventing missing tool history.

Scoped directory handles reject symlink/reparse traversal; regular files reject hard-link aliases on Unix. Unix directories use0700 and files0600. Per-session bounds are64000000 bytes of visible transcript,100000 messages,1024 transcript parts,24000000 bytes per immutable object and256000000 bytes of retained archives. Physical archive accounting includes orphan files. Reaching a quota preserves existing history and stops the operation; it never silently deletes user messages or pending work. A new transcript-export UI is a separate requirement; the existing bounded readers and raw retained objects provide recovery.

Recall uses visible-only archived reads, an80000000-byte page budget and the existing anchored message-window API. It does not load opaque archived reasoning to search visible text. Archives are scoped to the original owner, canonical workspace and session UUID.

## Explicit conversation deletion

An authenticated delete uses the same private session lock, durably publishes a deletion tombstone, then removes the active head. Resume, recall and archive tools reject the tombstone even if an old head is restored by a stale process. Independent forks keep their own data. Immutable objects remain retained; this is logical deletion and is not a physical-erasure claim. External native histories are untouched.

## Evidence and limits

Synthetic local HTTP fixtures cover all three V4 provider transports, repeated summary merges, custom instructions, usage without invented tokens, automatic thresholds, model failure, cancellation, stale writes, complete native rewind and archived history beyond the old2 MB limit. No paid or private provider call is needed for those checks. The actual structured API recovery fixture also passed 11 checks against the
recorded immutable binary. Its small synthetic conversation compacted from
21,298 to 6,996 native-context bytes while preserving visible history and exact
raw archive records. It checked idempotent receipt lookup, stale/foreign
rejection, private reasoning exclusion, provider failure, malformed output and
cancellation without head mutation. These are fixture results, not a general
compression ratio or fidelity guarantee. The current task's
`work/parity/structured-runtime-results.json` identifies the result artifacts and
binary; source presence alone is not a parity claim.

A summary cannot prove semantic fidelity for every possible conversation. Original messages, exact tool evidence and receipt lineage provide recovery when the summary omits a detail. Very large current requests or instruction prefixes that cannot fit safely stop with guidance instead of discarding required context. Own V4 Context/manual-compaction controls are implemented in the source. Their source tests, compiled App checks and installed delivery are separate evidence gates; see [structured UI](V4_STRUCTURED_UI.md). The CLI and authenticated command API retain their existing paths. Cross-protocol continuation
conversion and provider-native compaction endpoints are separate capabilities.
