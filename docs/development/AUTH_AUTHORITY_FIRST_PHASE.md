# Auth authority integration boundary

## Status summary

| Piece | State |
| --- | --- |
| Rust server: session-bound credential pair (pair sequence, transactional login, refresh and logout) | Implemented, **off by default** behind `TERMINAL_V4_AUTH_SESSION_CUTOVER=1`; see "Server session-pair protocol" below |
| Rust server: no-forced-sign-out migration of legacy accounts and refresh tokens | Implemented behind the same switch; covered by unit and HTTP tests |
| Rust server: refresh replay detection (`refresh_token_spent`), mixed-pair rejection, logout/refresh ordering | Implemented and tested (including a threaded logout/refresh race) |
| Browser: use of the protocol (`pairBinding`, `accessToken` on refresh, atomic pair publication) | **Not implemented.** The active frontend still writes two localStorage keys and cannot use the guarantees |
| Server: older server binaries sharing the data directory, paired grants, every effect boundary rechecking the session | Not implemented; see "What is not done" |
| Verification | 17 colocated tests (`state/auth_pairs_tests.rs`) and 3 HTTP tests (`tests/auth_session_pairs.rs`) pass. The full `terminal-v4-api` library run on a loaded machine showed load-dependent failures in unrelated queue and ownership tests that pass when rerun alone; no real browser, older-binary or multi-process test of the new protocol exists |
| Production activation | Not done. Do not set the switch until the deployment plan below is followed |

The text after this section is the earlier design history and prototype status;
where it says the server cutover or an upgraded issuance path is "not implemented"
or that legacy sign-in "returns a server error", the new section supersedes it for
the Rust server (the cutover exists but is disabled unless the switch is set).

The standalone IndexedDB authority is experimental groundwork, not the active auth
runtime. The active runtime still stores tokens separately in localStorage. It is
therefore not protected by the authority's atomic pair and tombstone operations.
The isolated integration adds a narrower fail-closed check for cooperating tabs:
when a refresh token changes, a waiting tab reuses an access token only if both
token fingerprints match the recorded rotation. A lagging view that never catches
up requires sign-in again. Its catch-up budget starts after coordination makes
progress, so a slow pending refresh does not by itself consume that budget.
This does not order logout with token publication or
fence older clients, and it is not a substitute for the full authority migration.
An isolated Chromium regression pauses a refreshing tab immediately before its
first localStorage credential write, changes the session in a second tab, then
resumes the write. Both the Web Locks and IndexedDB fallback paths republish the
old credentials after sign-out, same-account sign-in, or different-account
sign-in. In the different-account case, the new identity is paired with the old
credentials, and a synthetic API request uses the old access token. These six
regressions currently fail; they do not exercise real accounts or a live server.
Legacy `apiFetch` now checks the originating browser session before dispatch,
after receiving a response, and while decoding or streaming its body. A session
change after a mutation was dispatched is reported as an unconfirmed outcome,
and the convenience helpers preserve that indication when decoding an error.
Two-tab Chromium tests exercise delayed responses, body decoding and stream
chunks against a synthetic loopback server. This is a browser-side guard: a
stale localStorage view, an already-dispatched server effect, callers that bypass
`apiFetch`, and changes between a check and the next effect remain outside its
guarantee. It does not resolve the seven refresh-publication failures above.
The active refresh code rejects malformed consumed-token history and rejects
an absent aggregate key when a pending token-specific record remains. A missing
aggregate key with no remaining token-specific evidence is still treated as a
fresh installation, so complete history loss is not detected by these checks.
When a current session encounters malformed history during refresh, the app
keeps its workspace mounted and shows a dismissible notice so the user can save
unsaved drafts before seeking recovery. Direct session reconnects use the same
path. A stale result cannot affect a newer login. Signing in does not repair
the stored history; the notice directs the user to an administrator for recovery.
Network failures and non-authentication HTTP errors after a refresh request also
show a warning without unmounting the workspace. Their token reservation is
retained because a response does not prove the token was not consumed; browser
tests verify that 429 and 503 outcomes are not replayed. Signing in may recover
only if the new credentials do not reuse an uncertain token.
Structured conversation reconnects stop automatically for damaged history and
uncertain or temporarily unavailable refresh outcomes. Desktop and mobile offer
an explicit reconnect after recovery; other transient failures still retry. While
unavailable, the draft remains editable but submission is disabled. Isolated
Chromium tests cover this phone UI at 320px and 390px with a simulated session.
This does not change raw-terminal reconnection, and is not an authority migration.

The authority's incarnation-scoped `beginLogout` moves a session into a durable
closing state even if its revision changed during refresh, while rejecting a
logout from an older login. Closing blocks login and refresh, and ordinary reads
do not expose the retained credentials. `finishLogout` requires a separately
configured verifier to confirm a terminal receipt, then rechecks the exact
operation before replacing the record with a tombstone and erasing credentials.
An absent, failed or nonterminal verifier leaves logout pending. No production
verifier or safe automatic recovery after a crash exists yet; retained tokens
remain in the database until completion. The verifier is trusted application
code and must independently bind proof to the server, session and operation;
it must be read-only because multiple tabs may verify concurrently, and it must
not dispatch or retry logout. The local API cannot enforce that a caller supplies
an honest verifier.
Refresh completion uses the reservation and revision as a compare-and-set. A
reservation persists across authority instances, and fingerprint history retains
uncertain and rotated-token reservations across logout and later login. When a
matching reservation completes successfully with the same refresh token, the
authority releases that reservation in the same transaction as the updated pair;
this permits a later refresh against a nonrotating server. A stale completion
cannot release an uncertain reservation.
The prototype rejects sparse history arrays and checks that an active reservation
is paired with the fingerprint of its refresh token. It cannot detect a silently
changed or lost fingerprint after the corresponding active reservation has gone.
The prototype binds each credential pair to an account ID, canonical home URL and
login epoch. Credential updates and refresh completion cannot change any of those
values; a new login creates a new authority incarnation. The logout verifier
receives the same account and home bindings. Active records from the earlier
prototype without these fields fail closed. Credential inputs are copied once
and the copy is validated before any transaction; throwing or changing input
getters cannot commit an invalid pair. A new, still-unwired strict browser
authority uses a separate IndexedDB database, stores a bounded user profile with
the pair, and requires its user ID to equal the pair's owner. A persisted login
intent selects which concurrent sign-in may commit, while logout cancels a pending
intent. Refreshes require a reservation, and known uncertain or consumed refresh
tokens cannot be installed through login or refresh completion. The strict API
does not expose the prototype's profile-free login or unrestricted pair update.
Tests cover the new contract in independent Chromium tabs with synthetic data.
The caller is still responsible for deriving the account, home and authentication
response from trusted context and proving that tokens belong to that account;
matching profile IDs alone is not proof. No production logout-receipt verifier
or browser integration exists yet.

The strict browser authority now requires a separate 64-character hexadecimal
logout capability in a freshly issued pair. It keeps that capability out of
ordinary session and refresh reads, preserves it across token rotation, and
returns it with the same owner, server session, browser incarnation and logout
operation when a pending logout is resumed. The strict receipt verifier receives
that exact scope, and a changed capability prevents final local erasure. This is
a proposed client/server contract: a private protocol-1 server prototype issues
the capability and implements a session-scoped receipt, but neither is available
through a production route. The synthetic verifier used in
tests is not a production verification mechanism. No automatic logout dispatcher
is wired; a caller must retain and independently verify a server receipt before
finishing a logout. Losing the database or rolling back both its profile marker
and associated records cannot be distinguished from an untouched installation.
If a new login replaces an active strict session, the browser authority retains
the old session's exact logout operation and capability as a pending retirement.
It withholds the replacement credentials until the caller verifies a terminal
receipt for that retirement. The current record also retains the corresponding
retirement operation, so losing just the history entry or just the record marker
fails closed. A control revision changes when a new login intent is recorded;
strict logout requires that revision, so an older logout cannot cancel the newer
intent. These controls are currently exercised only with synthetic verification,
not a real server. Claimed login intents retain their operation key and late
responses can be quarantined; a response lost entirely still requires a
server-side login operation and recovery protocol. A trusted verifier must
establish a terminal no-session result before a failed attempt is released.
The active server still uses owner-wide logout. Its private protocol-1 prototype
adds a stable session identity to signed access and refresh credentials and a
durable, operation-bound logout receipt. That receipt revokes only local session
credentials, not shared owner resources. It is not exposed through an API, and
it is not yet bound to the client's verifier. A count stored on the session
detects an isolated receipt-row deletion or a recreated empty receipt table,
but does not detect same-count corruption, coordinated rollback, or loss of
both the session and receipt history. Receipt absence is not proof that an
operation did not occur. Existing prototype sessions with receipts and no count
fail closed during migration. Installation integrity and recovery remain
unresolved. The old owner-wide cleanup must not be used as proof of session-only
cleanup.
Each session retains at most 64 logout operation receipts. At the limit, a new
operation fails closed while an exact retry of an existing receipt still succeeds.
The private receipt path can confirm a session already revoked by HTTP logout or
an account generation change, but it records only local credential revocation.
Input admission and local approval checks also use the session identity; other
effect boundaries still require migration. Tests use two state instances in one
process for receipt concurrency, not a crash or cross-process receipt recovery.
Authorized follow-up queue proofs can now record the originating authentication
session separately from the conversation incarnation. Legacy local and paired
proof formats remain readable. A two-process fixture verifies the session-bound
proof survives restart with the queue held. With the native queue preview
feature, synthetic Codex and Claude tests verify that a signed-out origin is
held while a newer login stays valid. These do not establish a real-provider
lifecycle. The default Unix build now records session-bound
proofs for protocol-1 local enqueue and edit operations and checks proof-bearing
work at dispatch. Proofless legacy work may still run for protocol-0 accounts,
but its canonical publication is fenced against protocol-1 cutover. A synthetic
default-build HTTP test covers this hold and rejects paired enqueue and edit
after cutover; paired queue support for the upgraded protocol is not implemented.
Work already accepted before cutover still needs an effect-boundary and
cancellation design, so these checks are not sufficient for activation. The
delegation outbox now records the exact protocol-1 authentication session and
authenticates the reviewed binding with the queue-authority installation key.
That proof requires intact installation storage. Focused synthetic tests cover
tampering, a revoked original login with a newer login present, and reopening the
outbox; they do not establish a complete provider-to-child lifecycle. A failure
known before delivery leaves the result retained without marking an attempt,
while revocation racing a
delivery after preflight can still leave an uncertain outcome. No result is
automatically transferred to a newer login. Background actor short operations
now recheck the originating session at their effect boundaries; focused tests
cover revocation, expiry and cancellation. Protocol-1 background actor creation
and launch remain disabled. The owner gate can still wait on its database mutex
or SQLite, and durable input I/O can stall while holding the global auth fence;
this can delay unrelated authentication and cancellation. Actor admission can
also return busy under contention, including for protocol-0 sessions. Older and
newer server processes must not share a data directory during cutover; an old
writer can replace a newer queue proof.
Relevant effect-boundary checks and cleanup must honor that session identity;
owner-wide cleanup cannot be treated as safe for a later login. A separate
login-operation recovery mechanism must account for responses lost after the
server has issued a session. Until those pieces exist, the strict browser
authority must not be wired into the live sign-in flow.
Logout methods and IndexedDB remain accessible to same-origin application code;
the capability is omitted from ordinary snapshots, not isolated from that code.

The experimental lifecycle adapter now coordinates claimed logins, reserved
refreshes and receipt-based logout against the strict authority. `apiFetch` can
accept that lifecycle explicitly, reject unavailable or mismatched sessions,
and avoid automatic replay of writes. Decoding a strict response or its clone
rechecks the session after the body is read; the `apiGet` helper also rechecks
before returning JSON. Raw response streams are not yet available on this path;
headers and other potentially sensitive response metadata require a checked
async accessor. Consumers must still recheck their scope before applying data
to state. A
browser-side check cannot atomically fence a later logout against a network
effect; server-side session admission remains necessary. Neither the adapter
nor this request path is wired to normal sign-in.

A provisional, unmounted server router provides POST `/api/auth/session-logout`
and POST `/api/auth/session-logout/receipt`; both take the owner, session,
operation, browser incarnation and logout capability in JSON. The response is
`no-store`. A missing or unconfirmed receipt is never treated as a completed
logout: a production verifier must independently query the trusted home server
and bind the same scope. Invalid capability requests are checked before creating
per-owner lock files and checked again under the lock. Focused synthetic HTTP
tests exercise this contract. An unwired browser transport independently queries
the pinned server for a matching receipt; its tests include a lost response and
retry. It requires HTTPS except for loopback, so remote Tailscale access needs a
trusted HTTPS endpoint or a separately designed transport policy. The router has
not been mounted or tested for real cross-process crash recovery. A future public
mount also needs request-contention and body-logging controls before exposure.

This remains an unwired prototype. A fresh or erased database cannot establish
history from an earlier installation, and it cannot stop a caller that bypasses
the authority. Integration must handle installation identity, storage failures
and migration, and route all credential reads and identity changes through it. It must
verify login, logout, passkeys, refresh, and consumers in real browser tests.
Ordinary authority operations now refuse to create an absent database; the
separate `provision()` operation creates the initial tombstone and history or
reports an existing store without resetting it. A caller must first establish
an independently authorized fresh installation and obtain fresh credentials.
Calling `provision()` alone does not prove that a deleted database was new.

A first phase can protect cooperating upgraded tabs only when all participating
credential operations use the authority. Old clients can still write legacy
storage and issue requests; fencing them requires separate backend support.

Integration must discard legacy credentials and require fresh sign-in; importing
legacy token pairs cannot establish whether a refresh token was already used.
The earlier experimental authority also released some history entries, so its
existing database cannot prove strict no-replay history and must not be trusted
for activation; activation needs a fresh authority state and fresh credentials.
Production activation remains disabled until all auth consumers are migrated and
verified. This does not fence old tabs at the server.

The server's owner generation can invalidate previously issued local access and
preview tokens, but a generation bump alone is not a mixed-version cutover:
an older server can issue a legacy token using the new generation. The eventual
cutover must classify both new access credentials and refresh records, enforce
the account's protocol requirement on issuance and use, and prevent older server
processes from serving that data. Paired grants and pairing codes are separate
from local auth generations and currently survive ordinary logout; changing their
lifecycle requires explicit handling. Some live streams revalidate periodically,
so an immediate-stop guarantee would need additional stream checks.

The working-copy Rust runtime now carries a signed protocol version through
local access, refresh, preview and preview-resource credentials. Its internal
protocol-1 issuance path commits the account marker, generation increment,
legacy refresh revocation and replacement refresh credential in one transaction;
subsequent protocol-1 issuance keeps existing upgraded sessions. Older rows and
tokens default to protocol 0. A count-backed integrity record detects some lost
account markers, but not coordinated loss or rollback of all protocol state.
No production route or browser flow invokes the upgraded issuance path yet. If
the account marker is set outside that path, a generation bump is not guaranteed,
and legacy sign-in currently returns a server error rather than an upgrade flow.
Do not enable the transition until verified sign-in intent, logout recovery,
browser consumer migration, admission fencing and mixed-version shutdown are
implemented and tested together. Paired grants are not revoked by this path.
Middleware checks a credential before entering a handler, and many handlers do
not yet recheck at the effect boundary. A request admitted before cutover can
therefore act afterward. Settings and the vault HTTP routes now recheck local
authority inside the transaction that reads or changes data, ordering those
operations against logout and cutover. An operation already admitted inside that
fence can finish before revocation; disconnecting the requester does not cancel
an admitted blocking operation. The provider-credential routes use the same
local fence; paired provider reads retain a separately checked grant. These
changes do not fence other handlers or revoke paired grants on local logout.
The catalog's saved-provider lookup is asynchronous and may finish an internal
read after revocation; it rechecks authority before returning that metadata.
The non-Unix implementations have not been validated on Windows. The transition
must remain unavailable until all relevant effects are ordered against it.
Tests exercised two API state instances sharing a database, a synthetic legacy
credential at the current generation, migration of a legacy schema, and an
issuance failure that rolls the transition back. They do not establish safe
activation or behavior of an actual older server process. The Rust library run
after the settings, vault and provider changes passed 2,671 tests, with 50
ignored. Windows and the active browser migration remain unverified.

The test-only Rust protocol prototype applies a cutover marker to the whole
account, including sessionless legacy credentials, and records an installation
count. It rejects duplicate account markers and null marker versions, and allows
legacy credentials for accounts that have not transitioned. A missing row,
installation record, or count trigger fails closed when that inconsistency is
detectable. It cannot detect all same-count corruption, coordinated database
rollback, reinstallation after total loss, or arbitrary database tampering.
Its credential tuple is trusted input, not authenticated proof; live use also
needs signed credential classification, issuance and refresh checks, an admission
boundary, and a migration that does not reset existing history. The prototype is
not registered in the server and is not an active protocol fence.

The Rust HTTP logout path now rechecks the local credential's owner, expiration
and generation inside the revocation transaction. A request admitted before a
different logout cannot subsequently revoke a login in the newer generation; a
rejected request does not start owner cleanup or expire the preview cookie.
Active protocol-0 logout remains owner-wide within the same generation. The
private protocol-1 path revokes one session, but the rest of the application
has not been migrated to enforce that session at every effect boundary. Browser and MCP cleanup
after a successful logout is also owner-wide and may race resources created by a
later login; that lifecycle boundary still needs to be established and verified.

The experimental strict terminal now retires callbacks from a previous
authentication binding when the mode or authority changes. It also closes on
oversized pending output rather than retaining an unbounded backlog while an
authority check or history reload waits. These are client-side protections;
they do not make the strict flow ready for production. In particular, the
normal legacy flow still permits an old refresh response to overwrite a newer
login's split localStorage credentials. Synthetic independent-tab Chromium
tests reproduce both sign-out and account-switch cases. All credential writers,
readers, and server effect boundaries must share a verified lifecycle before
the new flow can replace that path safely.

The opt-in provider uses a tab-local session-storage marker to prevent its
legacy request helpers from resuming after a reload or remount. Unavailable or
damaged session storage puts even a fresh legacy bootstrap into an explicit
sign-in hold; it does not erase credentials. The marker is not a durable
installation-wide cutover: complete storage loss before reload is indistinguishable
from a fresh tab, and old code or direct storage/network calls can bypass it.
Strict Notes now use the session-scoped request adapter, pin their original
login and retain drafts when that login changes. The note API rechecks local
authority around file access and before replacing a note file; it returns an
unconfirmed outcome when a completed operation cannot be confirmed. On Unix,
note preparation occurs outside the authentication fence under a per-storage
process lock; the final rename and database confirmation still hold the fence,
so a stalled rename or commit can delay logout. Concurrent older servers do
not participate in this lock, and non-Unix behavior is unverified. Existing
user-directory naming strips characters from account IDs, so distinct IDs can
map to the same directory. The Notes and Bookmarks APIs check the account table
before and after preparation and refuse registered aliases or an unknown account;
they do not establish ownership of data from a deleted or otherwise unrecorded
account. Terminal paths need their own protections. Durable ownership binding and
migration of existing data remain unresolved. A note or bookmark save with an
unconfirmed outcome needs user review before retrying. Strict Bookmarks now use
the session-scoped request adapter for reads and edits, pin the original login,
and retain drafts while a different account is shown. When the strict session
is unavailable, drafts remain editable but saving is disabled. Running bookmark commands
remains unavailable in strict sessions because terminal input has not yet been
fenced at its server-side effect. The strict provider itself remains unmounted;
do not activate it until the remaining consumers, storage ownership and
server-side admission are implemented and independently verified.

The existing uniqueness guard used by legacy structured-history migration and
V4 recall rejects IDs that sanitize to an empty directory name and compares
sanitized account IDs without ASCII case differences. This
blocks current account aliases on case-insensitive filesystems, but the current
database is not evidence of a deleted or unrecorded historical owner. The guard
does not establish durable ownership of a legacy directory, and direct terminal
session paths are not covered by it.


## Server session-pair protocol

Source: `rust/crates/api/src/state/auth_pairs.rs` (issuance, rotation, migration),
`state.rs` (schema, logout, claim validation), `auth.rs` (the `pair` access claim),
`lib.rs` (the `/api/auth/login` and `/api/auth/refresh` handlers). Tests:
`state/auth_pairs_tests.rs` (colocated) and `rust/crates/api/tests/auth_session_pairs.rs`
(HTTP).

### Model

A protocol-1 session owns exactly one live pair at a time. Each pair has a
per-session sequence number, `pairSeq` (1, 2, 3, ...). The access token carries it
as the signed `pair` claim and the refresh token row stores it. Login, refresh and
logout each run in one immediate SQLite transaction under the authentication
admission fence and the per-owner lock, so they are totally ordered:

* login creates the session and pair 1 together;
* refresh consumes the refresh token, advances `pair_seq`, records the spent token
  and inserts the successor in one transaction;
* logout revokes the session and deletes its refresh token in one transaction.

A refresh that loses to a logout finds the session revoked and publishes nothing; a
refresh that wins is revoked by the logout that follows, so no usable pair survives
a logout (the threaded test checks this over 24 rounds). Two refreshes of the same
token redeem it exactly once. The server never revokes a session because of a
replay: a benign second tab would otherwise sign the user out.

Pair-bound sessions (`pairBinding: true`) additionally require, on refresh, the
access token of the same pair. A session becomes bound at login or refresh when the
client sets `pairBinding`; this is one way. Non-bound sessions (including everything
created by older clients) behave as before apart from the new bookkeeping.

### Wire protocol

All responses to these routes are `Cache-Control: no-store`. Unknown JSON fields
are ignored, so older clients are unaffected.

`POST /api/auth/login`, body `{"username"|"email", "password", "pairBinding"?: bool}`.
Response `AuthResult`: `{user, tokens:{accessToken, refreshToken}, session?}`, where a
protocol-1 `session` is `{id, logoutCapability?, pairSeq, pairBinding}`.
`logoutCapability` appears only at login. Status `426` (`error` text contains
"upgraded client") means the account was cut over, the switch is currently off, and
a pair cannot be issued; this is the one explicit forced re-login (see below).

`POST /api/auth/refresh`, body `{"refreshToken", "accessToken"?, "pairBinding"?: bool}`.
Response `AuthResult` as above, with `session.pairSeq` equal to the previous value
plus one (or 1 when a legacy token migrates). Rejections carry `{error, code}`:

| Status | `code` | Meaning and client action |
| --- | --- | --- |
| 401 | `invalid_refresh_token` | Unknown, expired or revoked (including after logout). Sign in again. |
| 401 | `refresh_token_spent` | The token was already rotated, typically by another tab. Do not sign out: re-read the authority's current pair and retry with it. |
| 409 | `pair_mismatch` | `accessToken` belongs to another pair, session or account. Token not consumed. Re-read the current pair; never publish a mixed pair. |
| 428 | `pair_required` | The session is bound and `accessToken` was omitted. Token not consumed. Resend with the matching access token. |

An expired access token is accepted as proof of its pair at refresh (signature,
account, session and `pair` are checked, expiry is not). `POST /api/auth/logout`
with the access token is unchanged on the wire and revokes only that session.

Access validation: for a bound session, an access token is accepted when its `pair`
is the current sequence or the one immediately before it (a one-rotation grace so
in-flight requests and open streams survive a rotation); older pairs and bound
tokens without `pair` are rejected. Non-bound sessions ignore `pair`. Refresh is
exact: only the current pair's refresh token is live. Preview tokens do not carry
`pair` and are unaffected.

### Migration of legacy accounts (no forced sign-out)

With the switch on (`TERMINAL_V4_AUTH_SESSION_CUTOVER=1`, read at start-up;
`ApiState::set_auth_session_cutover` in tests):

1. An unmodified client (no `pairBinding`) on an account that has not been cut over
   gets exactly the legacy behavior. Nothing is activated by legacy clients.
2. The first opted-in request, either a login with `pairBinding:true` or a refresh
   of a legacy refresh token with `pairBinding:true`, cuts the account over in the
   same transaction that issues that client's session pair. The cutover sets the
   account's protocol marker. It does **not** bump the generation and does **not**
   delete any refresh token.
3. After the cutover, legacy (protocol-0) access tokens are rejected with 401. The
   legacy refresh token each older tab holds stays redeemable once: the next
   successful refresh from that tab, with or without `pairBinding`, returns a
   protocol-1 pair (a new non-bound session unless it opts in) in the existing
   `{tokens:{accessToken,refreshToken}}` shape, which an unmodified client already
   stores. The only visible effect is one 401 followed by the refresh the client
   already performs. Each legacy refresh token yields its own session.
4. Further logins on a cut-over account always issue sessions (bound only if
   requested), so an unmodified client keeps signing in.

Legacy accounts therefore transition on the next successful refresh. Legacy pairs
cannot be verified for mixing (a legacy access token has no link to a refresh token);
verification starts with the first protocol-1 pair.

### Where a forced re-login is unavoidable

* **Rolling the switch back after any account was cut over.** Protocol-0 credentials
  of that account stay rejected, and legacy logins return `426` instead of a pair
  until the switch is turned back on. Existing sessions keep refreshing. Tests:
  `cut_over_account_refuses_legacy_login_explicitly_only_while_cutover_is_disabled`
  and `disabling_cutover_after_activation_makes_the_forced_relogin_explicit`.
* **Restoring a pre-cutover database backup.** Pair, session and spent-token state
  roll back with it; clients holding newer pairs must sign in again.
* **A legacy refresh token that was already consumed or has expired** (30 days).
  This is unchanged from before.
* **Running an older server binary against the same data directory** after cutover
  is unsupported; see the plan.

### Deployment plan

1. Back up the data directory. Stop every old server and worker on it (see
   `SAFE_UPDATE.md`, rule 1 and 2); an older binary can issue protocol-0 tokens for a
   cut-over account and does not understand pair state.
2. Deploy the new binary with the switch **off**. Schema changes are additive
   (`auth_sessions.pair_seq`, `auth_sessions.pair_binding`, `refresh_tokens.pair_seq`,
   `auth_spent_refresh_tokens`); an old binary tolerates the new columns but must not be
   restarted afterwards on a cut-over account. Confirm `/api/build-info`.
3. Ship the frontend that sends `pairBinding`/`accessToken` and publishes the pair
   atomically (not yet written). Until it ships, leave the switch off.
4. Set `TERMINAL_V4_AUTH_SESSION_CUTOVER=1` and restart. The first opted-in client
   cuts its account over; other tabs recover on their next refresh as described above.
5. Rollback is a forced re-login for legacy logins only if some account was cut
   over (see above). Prefer fixing forward.

### What is not done

* Frontend adoption is partial. `auth.js` and the login path now send
  `pairBinding:true`, store `pairSeq`, and handle `pair_mismatch`, `pair_required`,
  `refresh_token_spent` and 426 without clearing credentials. The two-key
  localStorage problem is narrowed (rollback after a changed scope, a consumed-token
  ledger) but not removed: pairs are still written as two keys, not atomically, and
  tabs from before this client do not send the binding. No mixed-version or
  deployed-environment result exists.
* The cutover is not fenced against an older binary sharing the data directory, and
  an old writer can still mint protocol-0 credentials for a cut-over account.
* Paired grants and pairing codes are not part of the session lifecycle.
* Effect boundaries other than those listed earlier still check the session only at
  admission; a request admitted before a logout may complete after it. Streams
  revalidate every two seconds, so a bound session's stream on a pair older than the
  one-rotation grace stops at the next check.
* A refresh response lost in transit leaves the client with a spent token (the
  server reports `refresh_token_spent`); there is no server-side replay of the
  last response, so that client must sign in again. The browser authority's
  uncertain-attempt handling is the only mitigation.
* Non-Unix builds cannot create sessions or cut accounts over.
* `session-logout` receipts (the unmounted router) are unchanged; they do not yet
  verify `pairSeq`.

Logout wiring note: the server-side logout for protocol-0 accounts already holds the
background owner and reports cleanup `pending` until the cleanup worker verifies
quiescence; session-scoped (protocol 1) logout does not start owner cleanup. The server
has no account-deletion path, so deleting an account (and purging board data with
`workspace_board::purge_owner`) is not wired anywhere yet.
