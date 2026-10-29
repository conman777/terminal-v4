# Saved connection inference in V4

This backend candidate adds V4's own saved-connection runtime to structured
conversations and manual or automatic context compaction. It has not been
integrated into the installed app. Its frontend successor adds saved connections
to the conversation picker. The isolated UIv2 served-app fixture exercised
streaming, Stop, reload, compaction, a file tool cycle and responsive layout.
Native WebView, real vendor compatibility, revision continuation, and direct CLI
or task execution remain dependent work.

## Selection and account scope

The catalog exposes only the authenticated account's profiles. A selected
provider identifier binds a canonical profile ID, exact revision, and protocol.
It contains no account, endpoint, or credential. A model ID is required.
Reasoning, image input, CLI, and task support are not inferred from a model name.

The structured manager reuses the app's single provider manager. The server's
authenticated account is captured before admission. The provider service checks
the current owner, revision, transport, model, credential binding, and configured
endpoint before starting HTTP. A saved connection never falls back to the
static API-key vault.

## Conversation picker candidate

The folder picker loads saved connections from the authenticated agent catalog.
Each choice must have a unique canonical provider ID and matching profile,
revision, protocol, and structured-runtime metadata. Unavailable connections remain
visible but cannot launch. A model ID is required; saved connections do not use
terminal launch commands.

Loading the catalog preserves manual agent/model choices, the folder search,
and tab name. Closed picker requests cannot populate a later opening. A catalog
failure offers a retry. Refreshing model metadata marks a saved connection
unavailable until its exact revision is confirmed; missing, duplicate, or
mismatched revisions stay unavailable while preserving the entered model ID.

A canonical saved project default remains that exact selection when its catalog
entry is pending or missing. It cannot silently become a base agent. Recent-folder
launches check the same exact revision against a fresh catalog before opening.
Choosing a different agent explicitly remains possible.

These controls have component, utility and isolated served-browser evidence.
That evidence does not establish native WebView or installed-bundle behavior.

## Published discovery in the picker

The catalog reads previously published discovery metadata for the exact current
ready profile and complete saved snapshot, including revision, protocol,
credential binding and endpoint. It flushes pending history first and reads the
current profile under the configuration fence. The same fence authenticates the
durable checkpoint generation and fingerprint against this service's retained
history, even when its dirty flag is clear or its payload is unchanged. A stale
service fails closed without reloading live owners from history. Only a succeeded or empty,
quiescent publication is eligible. Persisted append order chooses the latest
compatible publication; wall-clock changes do not reorder it. A newer empty
publication clears an older model list. Failed or unfinished discovery does not
replace an eligible earlier publication.

Authenticated history can restore this metadata after restart. It does not
reconstruct a live HTTP owner, stop evidence or inference permission. Inventory
and catalog refresh never dispatch discovery; the user runs discovery in Settings.
Existing Settings profile responses retain their original shape.

Model selection uses the exact discovery selection ID. Padded IDs and selectors
are rejected by discovery and by projection of older history; they are never
silently converted into another model identity. Internal spaces and valid Unicode
remain exact within the existing 200-byte bound. The picker requires an
explicit choice, preserves an existing choice even when absent from a refreshed
list, and preserves a choice arriving while its catalog request is outstanding.
Discovery's nullable observations are carried in `discoveryMetadata`; native
reasoning options and reported image support do not enable unimplemented runtime
capabilities. Saved-profile catalog models currently disable image input and
reasoning controls, and advertise no CLI, durable-task or inference-verification
capability.

Discovery, historical selection projection, and inference share the same ID
validator, including browser-trimmed Unicode edge characters.

The frontend candidate uses V4's exact provider identity when naming a
conversation; agent names in its title cannot replace that identity. New V4
sidebar entries use the server's canonical workspace path, keeping a requested
path alias from creating a second project row. Legacy terminal folder selection
continues to use its explicit chosen path.

Streamed assistant text is labeled partial until its own validated completion
event arrives. A cancelled, interrupted, or failed turn leaves unfinished output
visibly marked; a turn-ending event by itself cannot promote that text to a
completed message. Already validated messages keep their completed state even
when later activity in the same turn stops. The original visible transcript is
retained, separately from the canonical model history.

## Requests and cleanup

Each turn owns a sealed request group. Registration synchronously installs the
original task handle. Request UUIDs derive from a versioned, length-delimited
account/session/turn/consumer/ordinal identity. Replaying the same scope, consumer, and ordinal reuses the request identity.
Each Group::start advances the ordinal and represents a new attempt; this is
not general-purpose retry deduplication.

Admission explicitly distinguishes pending resolution, no dispatch by this
attempt, an original owned client, and an unconfirmed result. No-dispatch says
nothing about historical journal cleanup. Cancellation preserves admission
resolution. An owned failure retains the same original cleanup client.

Dropping an output receiver requests cancellation. Closing a group seals further
registration, signals every worker, joins the original task handles, and checks
each original signed release receipt against current durable storage. Canceled,
timed-out, or failed closes keep their handles and clients for retry. A task join
or cached local stop cannot substitute for current durable confirmation.

Profile text deltas remain tentative until model completion validates. The
existing canonical protocol path adopts the validated body into history and
strips host-only evidence markers. Cleanup confirmation does not establish model
completion. A committed compaction preserves its receipt even when later cleanup
verification fails; the controller separately retains the cleanup failure.

Shutdown first drains provider work while leaving its original-ticket verifier
available. It stops that verifier after structured cleanup succeeds. New work is
rejected during drain.

## Bounds and current limits

- Serialized input: 24,000,000 bytes per request and 48,000,000 bytes of prepared
  or queued input per shared manager. The reservation moves with the body and
  survives caller cancellation. These are not total heap limits.
- Forwarding: four queued text events, each at most 16,384 UTF-8 bytes; bounded
  decoder staging of 8,000,000 bytes and 8,192 deltas per feed.
- Response limits: 8 MB JSON or 16 MB streamed bytes, with the existing transport
  deadline and bounded native HTTP queue.
- Per service: eight active and 128 retained requests. A turn tracks at most 128
  workers. Durable actor history currently stops admission at 4,096 rows; an
  authenticated archive/reset workflow is still required.
- Cleanup has a five-second total deadline, including concurrent closer lock
  wait. Failure preserves authority rather than claiming completion.
- Saved profiles currently require the Unix private-storage adapter. Other
  platforms retain their explicit unavailable response.

The verification fixtures use synthetic credentials, loopback HTTP, and private
temporary storage. Backend and isolated HTTP/WS browser evidence is recorded
separately. Native UI behavior, real vendor compatibility, and an updated
installed bundle require separate verification. Discovery in the picker is
under verification in the UIv3 candidate.
