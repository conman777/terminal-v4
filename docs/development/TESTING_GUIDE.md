# Testing Guide

This document describes how to run and extend the project’s automated tests.

## Test Matrix Overview

| Scope | Location | Command | Notes |
| --- | --- | --- | --- |
| Legacy Fastify unit/integration | `backend/` | `npm test` | Vitest + Supertest |
| Legacy Fastify type checks/build | `backend/` | `npm run build` | `tsup` compile (type errors fail) |
| Active Rust API unit/integration | `rust/` | `cargo test` | Axum route/store tests |
| Rust API formatting | `rust/` | `cargo fmt --all --check` | Required before commits |
| Frontend unit tests | `frontend/` | `npm test` | Vitest + React Testing Library |
| E2E (root wrapper) | project root | `npm run test:e2e` | Delegates to `frontend/`; runs `frontend/e2e/` with `frontend/playwright.config.ts` |
| E2E (frontend) | `frontend/` | `npx playwright test` | Uses `frontend/playwright.config.ts` |
| Local app smoke | project root | `npm run app:verify` | Checks requirements, API health, production UI, and optional Vite dev UI |
| Local development wiring | project root | `npm run test:local-dev` | Real Vite HTTP proxy requests and root Playwright discovery; no browser tests executed |

## Legacy Fastify Backend Testing

These commands exercise the compatibility/reference implementation in `backend/`.
The active app runtime is the Rust API; root `npm test` runs Rust and frontend
tests, not this legacy suite.

```bash
cd backend
npm test
npm run build
```

Guidelines:
- Use `createServer({ logger: false })` for Fastify tests.
- Prefer Supertest for HTTP assertions.
- Mock external processes (Claude CLI, browser automation) in unit tests.

## Rust API Testing

```bash
cd rust
cargo fmt --all --check
cargo test
```

If subprocess-based tests time out during unusually slow macOS process startup,
rerun the affected tests individually and the API library suite serially:

```bash
cargo test -p terminal-v4-api --lib -- --test-threads=1
```

This can reduce concurrent process launches; it does not diagnose or fix a
macOS service stall. Investigate any failures that reproduce on the serial run.

Guidelines:
- Keep route coverage in `rust/crates/api/src/lib.rs` tests unless a helper is reusable enough to justify a colocated module test.
- Prefer spawning the Axum router and exercising authenticated HTTP/WebSocket flows over mocking internals.
- On Windows, install Strawberry Perl and ensure `C:\Strawberry\perl\bin` is on `PATH` before running Cargo commands that build the passkey/OpenSSL stack.

## E2E Testing

### Root wrapper (frontend suite)
```bash
npm run test:e2e
```
- Runs the frontend package's Playwright command with `frontend/` as its working directory and uses `frontend/playwright.config.ts`.
- The older `tests/` directory is retained as reference and is not selected by this command.

### Frontend suite (frontend/e2e)
```bash
cd frontend
npx playwright test
```
- Uses `frontend/playwright.config.ts`.
- Default `baseURL` is `http://localhost:3020` (backend serving built frontend).
- Set `BASE_URL=http://localhost:5173` to point at Vite dev server.

### Whole-workspace UI fixture

`e2e/ui-unification.spec.ts` is an opt-in built-web check. Start an isolated API
with `TERMINAL_V4_LOCAL_TESTING=1`, an empty temporary HOME/data directory, and a
fresh frontend build. Then run from `frontend/`:

```bash
E2E_UI_UNIFICATION=1 BASE_URL=http://127.0.0.1:3041 npx playwright test e2e/ui-unification.spec.ts --workers=1
```

The fixture uses app-owned Chromium and disposable accounts. It exercises desktop,
intermediate, coarse-pointer tablet and phone layouts, both themes, synthetic
structured conversations/approvals, image-error states, and real PTY output and
resizing. Settings, tools, Files, Preview and account surfaces use synthetic API
responses. Its request guard rejects unsupported writes, provider execution and
private-data access; the real PTY runs only the fixture's harmless commands.
Screenshots and geometry/freshness records support visual review. A skipped run
without the opt-in flag is not verification. Use a freshly rebuilt dist for the
final run, and keep actual backend/provider integration checks separate.

The short-pane DevTools checks are opt-in Vitest browser tests. Set
`E2E_WEBSOCKET_LAYOUT=1` and `E2E_PERFORMANCE_LAYOUT=1`, with
`E2E_LOCAL_BROWSER` pointing to the managed Chromium executable, to include them
in the frontend suite. They render synthetic metrics/messages with application
CSS in a 280px-high pane and verify scrolling, themes and touch targets. The
Performance tab remains build-gated by `VITE_ENABLE_PERFORMANCE_TAB=true`;
rendering tests do not establish availability of live metric endpoints.

## Troubleshooting

- **Playwright base URL**: Ensure the backend or Vite dev server is running.
- **Auth required**: Seed a user or enable registration locally before E2E runs.
- **Claude CLI availability**: Integration tests should avoid invoking the real CLI unless explicitly configured.
- **Rust OpenSSL build on Windows**: `webauthn-rs` pulls OpenSSL; install Strawberry Perl if Cargo fails with `Command 'perl' not found`.

## Agent workspace integration

Workspace tests are colocated with their Rust/React source modules. Native
provider adapters and history import use local source fixtures and harmless
child processes; these tests do not need model credentials or paid requests.

Focused checks from the project root:

```powershell
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib workspace
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib native
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib agent
npm --prefix frontend test
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api v4_agent
```

Run the normal full Rust/frontend/build checks after integration. Windows task
tests exercise a real descendant process tree and temporary persistence locks.
Unix containment tests use harmless Python child/grandchild fixtures that create
separate sessions/process groups and ignore graceful termination. They verify
cancellation, server shutdown, cleanup-handler execution, observed orphan cleanup,
PID birth-identity checks and survival of an unrelated sibling. Approved-command
fixtures also cover canceled futures, detached tools retaining output pipes, timeout
cleanup and finite commands with output beyond each 512 KB retention limit.
HTTP lifecycle fixtures verify that interrupted initialization or stale-connection
cleanup remains owned, and failed DELETE requests are retained for awaited retry.
PTY integration
checks cover close, suspend and the real shutdown-services hook, including retained
and buffered transcript output. These tests inspect process identity/ancestry,
not process command lines or environment values. Windows Job Object and Linux
`/proc` behavior still need their own host runs; passing macOS tests does not prove
other platforms. Browser checks
should use an isolated data directory, fake local identity, and localhost ports;
do not click actions that send model requests during a no-cost smoke pass.


## Paired-host and native rewind verification

Use temporary data roots and synthetic provider histories. Pairing integration
tests should start two local API instances with independent JWT secrets and
accounts, consume a one-use code, exercise actual runtime HTTP/WebSocket proxying,
and verify owner isolation, code reuse/expiry, revocation and blocked paths.
Preview coverage should request rewritten assets through the selected environment
and verify home tokens are not forwarded to the destination.

Frontend tests cover environment routing, request cancellation, per-host storage,
pairing consent, credential-management limits and the explicit rewind review,
suspend/resume and recovery controls. Browser smoke should check both desktop
and phone viewports, switch to the second server, operate a harmless terminal,
return home and verify the old socket/session is not reused.

Native rewind fixtures exercise durable turn IDs and unchanged original histories.
Claude/Codex adapter protocol tests use controlled local fixtures. V4 tests use
local HTTP servers, private temporary histories, file tools and independent forks. Coordinator checks cover source drift, owner isolation,
live-process/task gates, recovery-before-mutation ordering, failure receipts and
idempotent resumed app sessions. Do not use a real provider history or send a paid
model request as an incidental regression check.

Local Codex conversation tests live beside the adapter in
`rust/crates/api/src/structured/codex/tests.rs`. Run
`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api structured::codex --lib`.
They use a synthetic stdio app-server to check framing, native resume, exact
approval decisions, concurrent approvals, durable sends, sign-out and Stop.
An ignored installed-binary check uses an empty Codex home and makes no model
request: set `CODEX_PROTOCOL_BINARY` to the installed executable and run that
filter with `-- --ignored`.

The opt-in browser check is `frontend/e2e/codex-local.spec.ts`. Use an isolated
API/data directory with its own JWT secret, a synthetic `codex-smoke-owner` user,
`CODEX_BIN` pointing to `structured/codex/fixture.py`, and an empty `CODEX_HOME`.
Set `E2E_CODEX_FIXTURE=1`, `E2E_CODEX_JWT_SECRET` to that isolated secret, and
`BASE_URL` to its URL when running Playwright from `frontend/`. Override
`E2E_CODEX_WORKSPACE` if needed; the default is
`/tmp/terminal-v4-codex-smoke/workspace`. `E2E_CODEX_BROWSER` optionally selects
an installed Chrome executable. This exercises the production conversation UI
on desktop and a fresh phone context, without using real account credentials.

```powershell
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib paired
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib rewind
node --test scripts/provider-rewind-claude.test.mjs
python scripts/provider-rewind-codex.test.py
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api v4_agent
npm --prefix frontend test -- --run src/utils/remoteEnvironments.test.js src/components/RemoteEnvironmentsPanel.test.jsx src/components/WorkspaceRewindPanel.test.jsx
```

## Local testing account verification

`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api local_testing --lib`
checks persistent username reuse, normalization, separate identities, same-name
testing/password isolation, display names after refresh, legacy testing IDs,
local origin restrictions and mode-off token rejection.
Core config tests also reject non-loopback or external-storage testing mode.
Frontend `LoginPage.localTesting.test.jsx` and auth lifecycle tests cover the
username-only UI, normal password fallback and token commitment.

Run `e2e/local-testing.spec.ts` from `frontend/` against an isolated loopback API
with `TERMINAL_V4_LOCAL_TESTING=1`, `BASE_URL` set to that instance, and
`E2E_LOCAL_TESTING=1`. `E2E_LOCAL_BROWSER` optionally selects an installed Chrome
executable. It uses generated usernames and exercises sign-in, reload, logout,
same-name return and a different account. Avoid pointing it at ordinary user data.

`e2e/background-delegation-live.spec.ts` exercises an actual V4 parent and child
on desktop and phone viewports. Start `node frontend/e2e/fixtures/background-delegation-provider.cjs PORT`
on loopback, then start a freshly built, isolated loopback API with a disposable
`TERMINAL_DATA_DIR`, `TERMINAL_V4_LOCAL_TESTING=1`, a synthetic `VAULT_ENCRYPTION_KEY`,
and `DEEPSEEK_BASE_URL=http://127.0.0.1:PORT/v1`. Serve the current frontend from
that API or a Vite server pointed at it. From `frontend/`, run:

```bash
E2E_BACKGROUND_DELEGATION=1 E2E_DELEGATION_PROVIDER_URL=http://127.0.0.1:PORT BASE_URL=http://127.0.0.1:APP_PORT npx playwright test e2e/background-delegation-live.spec.ts
```

Use numeric port values and the optional `E2E_LOCAL_BROWSER` if needed. The test
creates disposable accounts, keys and project directories and requires the local
fixture health check. It verifies approval, a denied child write, the child's
read result, and delivery to the parent's follow-up queue, where the default build
holds it for review without waking the parent. Set `E2E_QUEUED_AUTHORITY_PREVIEW=1`
only against a server built with the experimental `queued-authority-preview` feature
to expect the parent to wake instead. Stop the fixture servers and remove their
disposable data after testing; do not use this fixture against normal user data.

`e2e/terminal-responsive.spec.ts` uses the same isolated-server flags to exercise
real CLI terminals at 320px, 390px and 1440px. It checks environment-bar clearance
for the drawer and keyboard shortcuts, 44px composer controls, 16px phone input,
secondary-action menu bounds and Escape focus, light appearance, reduced-height
viewports and actual shell command output. Each synthetic account's terminal is
closed after the test. `E2E_TERMINAL_WORKSPACE` optionally overrides its folder.

`e2e/mobile-conversation-layout.spec.ts` covers the Codex conversation surface
with synthetic messages over the real frontend WebSocket boundary. It checks
phone-sized reading space, compact chrome, full-height layout, expanding drafts,
reduced-height menus, approval targets and Stop. It makes no model requests and
uses the same local-testing server and browser flags as the terminal layout test.
It also exercises mobile model/reasoning/speed updates without losing drafts,
busy-state model locks, and desktop conversation composition in both themes.

`e2e/workspace-start.spec.ts` uses the same isolated-server flags to check the
centered start screen at 1221 px, 1024 px and 390 px, including overflow, workspace picker,
agent/terminal entry points, the header-free canvas, labelled sidebar tools,
Settings/account footer, collapse/restore
and light/dark themes. It uses generated testing profiles, stubs the
folder listing and never launches a terminal or sends a model request.
Composer checks stub the agent catalog and project profile, add a project through
the folder-only picker, change model/reasoning inline, and verify that typing and
selection preserve the draft without launching a session. Folder checks reproduce
filtering for Developer, entering it, clearing unmatched searches, and going up;
the filter must reset on navigation. The Codex fixture check
starts tasks directly from both desktop and phone composers, verifies delivery of
the first prompt, and asserts that no terminal creation request occurred.

Resource samples and limitations are recorded in
[Resource efficiency audit](RESOURCE_EFFICIENCY_AUDIT.md); the measured values are
in `RESOURCE_AUDIT_MEASUREMENTS.json`.

The first resource optimization batch is documented in
[Resource efficiency implementation](RESOURCE_EFFICIENCY_IMPLEMENTATION.md).
`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib structured`
covers append-only writes, canonical ordering, metadata checkpoints, compaction,
partial-tail recovery, missing/replaced files, approval Stop retry, native resume,
legacy recall, and cold context/knowledge reads. Full workspace tests also exercise
search, recordings, rewind, queue, image publication and cancellation boundaries.
Frontend inventory tests and the real-App selection fixture use metadata-only
responses with explicit sequence watermarks; hook tests retain full stream history.
Run both opt-in local-testing and Codex browser specs above against isolated data
to check desktop/phone approvals, continuation, reload, Stop and username access.

## Remote workspace regression checks

Run the Rust workspace suite and frontend suite/build. Targeted Rust filters are
remote_permissions, paired_environments, file_transfers, collaboration,
session_recordings, remote_tunnels, device_relay, remote_desktop and preview_grant.
Tests create independent loopback hosts and temporary databases; they do not need
provider credentials. Relay coverage includes a real 1 MiB download, PTY input/output
and a 256 KiB TCP stream through three hosts, followed by revocation.

Windows script checks:

```powershell
$env:TERMINAL_V4_HOST_SMOKE='1'
./scripts/manage-remote-host.Tests.ps1
./scripts/remote-desktop-helper.Tests.ps1
```

The startup smoke uses a harmless fixture process. Install is exercised only with
WhatIf. Desktop helper tests compile the native interop layout, validate actions
in DryRun and generate a synthetic JPEG; they never capture the user's desktop or
send input. Real interactive capture/input and public HTTPS/reverse-proxy deployment
require manual deployment verification. The existing paused rewind regressions
cover relative paths, ancestor-directory locks, recovered-session refusal and
idempotent interrupted file recovery.

Browser checks use isolated accounts/ports and must cover owner-scoped device
restore after reload, read-only input rejection, a network interruption during
ongoing PTY output, real upload/download, guest revocation and narrow-screen
navigation. Never submit a paid model prompt during these smoke checks.

## macOS desktop regression checks

Use an isolated `TERMINAL_DATA_DIR` and existing empty provider-home directories
for runtime checks. The desktop tests cover user CLI discovery and graceful Unix
shutdown, including a backend cleanup lasting six seconds and a noncooperating
child stopped by the bounded fallback. The desktop grants fifteen seconds before
forced termination so the task worker's ten-second shutdown window and final
history flush can complete. The API WebSocket regression verifies that `history=0` suppresses replay
when the browser already loaded HTTP history, and that requested replay carries
sequence cursors. The browser must display each saved output event once after reload.

The DevTools browser suite uses current sign-in labels and explicit preview show
controls. Performance is disabled by default: build with
`VITE_ENABLE_PERFORMANCE_TAB=true` and test with `E2E_PERFORMANCE_TAB_ENABLED=true`
when checking that optional tab. Run native provider tests with empty configuration
homes and synthetic transcripts, without model prompts or real account history.

The sandboxed-preview regression starts a harmless local HTTP fixture and verifies
that denied native browser storage produces a capability message without an
uncaught inspection-script exception. Storage edits are disabled in that mode;
cached snapshots are retained. The mobile keyboard test reserves the environment
bar and checks the remaining visible shell bounds during simulated keyboard changes.

Structured conversation presentation checks cover a single pane header, shared composer configuration, project-selection next-step feedback, and accessible tool-card expansion. `codex-local.spec.ts` verifies the desktop composer through approvals, reload, follow-up input, and cancellation against the synthetic Codex server; cancellation in this test must never target a user's live session.

Activity presentation tests cover shell-wrapped reads, search flags, test commands, explicit descriptions, neutral labels for mixed/write-redirection commands, lazy group expansion, and preservation of full original input/output. Verify expanded command details in the live conversation without sending input or triggering cancellation.

Shell regressions cover delayed project inventory, manual collapse persistence, active-thread discovery, utility navigation ordering, and keyboard activation of project actions. The local Codex browser fixture also checks that the active chat is visible in the project tree and a normal project name fits the sidebar. Responsive checks include 1221px, 1024px and 390px start views plus desktop/phone conversation flows; use the isolated fixture server for any send or cancellation checks.

### Existing Codex composer selection

The isolated `e2e/codex-local.spec.ts` flow also checks deliberate model/effort
and service-tier changes, selection persistence across reload, native resume and
turn parameters, rejection
of changes during a response, and switching projects without creating a session
or losing the original draft. It uses a synthetic app-server and deterministic
catalog; it does not send prompts to a real account. Backend selection tests cover
ownership, validation, busy states, persistence failures and manager reload.

The composer regression checks cover live idle state taking precedence over stale
running inventory, speed preservation during model/effort changes, explicit native
default reset, disabled controls during active work and menu bounds at desktop widths.

## Feature contract regressions

`feature_delivery_contract_tests` starts two disposable loopback APIs and pairs
them through the real code/exchange/proxy flow. It verifies Operator and explicit
agent-execution reads of durable request receipts, saved context, queue snapshots
and queue-operation receipts. A synthetic interrupted acceptance recovers once
without provider execution; observer/file-only grants, foreign owners, credential
routes and revoked grants remain denied. Run with at most two test threads:

```sh
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib feature_delivery_contract_tests -- --test-threads=2
```

The same tests assert HTTP 501 for server-only preview storage/evaluation
operations that have no delivery channel. Client-operation preflight validates
and authorizes only; its response explicitly says execution has not occurred.
PreviewPanel tests separately verify permission-before-dispatch through the
loaded iframe, retained document guards and real server cookie-jar handling.
Evaluation preflight retains the `PREVIEW_EVAL_ENABLED=true` opt-in. These checks
use synthetic fixtures; they do not establish current built-interface or real
provider behavior.

The frontend and active Rust API have paired regression checks for vault field
names, system-resource envelopes/history, transcription health/multipart/provider
selection, passkey options/deletion, structured recording IDs, paired preview
ports and server-side cookie storage. Notes/bookmark checks exercise failed saves,
navigation during saves and stale completions so newer drafts remain editable.

The Rust regression suites also cover ZIP directory cycles/containment, UTF-8
masking/log limits, omitted versus explicitly cleared skill files, saved-provider
defaults, native model transport changes, inherited image-lock descriptors and
Claude continuation/tool correlation/durable user history. Stop fixtures include
normal Unix process groups whose parent exits before Stop; they retain a
birth-checked ownership witness. Unix descendants that deliberately daemonize
outside the owned group before they can be observed are not guaranteed contained.
Run platform-specific Windows/Linux checks before claiming those OS paths pass.

Run `node --test scripts/rebuild.test.cjs` to check rebuild commands using temporary
mock tools; it never builds or restarts a real service. The scripts now build the
frontend and Rust release API and require an explicit owner-controlled restart.

The opt-in local-testing browser spec opens the account menu before Logout. The
workspace-start regression also keeps the draft/model when the already selected
project is chosen again. Use synthetic Codex/local-testing environments for real
desktop and phone approval, cancellation, reload and draft checks.

`frontend/e2e/feature-regressions.spec.ts` exercises notes, bookmarks, vault and
resource navigation in the built interface. `preview-feature-regressions.spec.ts`
checks opaque sandbox module/CSS dependencies, inspector selection and style
revert, cookie mutation, element capture, static file dependencies and paired
preview assets. Both require an isolated `E2E_LOCAL_TESTING=1` runtime; the preview
suite uses `E2E_PREVIEW_WORKSPACE` inside the runtime's allowed file roots.
Resource-auth API tests separately reject out-of-scope ports/directories,
mutations, sockets, expired credentials and revoked paired grants.
Initial-navigation checks also reject delegated credential issuance and stale
target/auth/environment completions. New-tab and picture-in-picture checks must
prove sandbox storage denial; matching URL strings alone cannot establish it.

### Relay structured-consumer recovery

Focused hook checks cover code 1009, a single owned HTTP-history request, canonical replay replacement, grant denial, known/chunked byte limits, timeout, scope cancellation and absence of reconnect loops:

```bash
npm --prefix frontend test -- --run src/hooks/useStructuredSession.relay-recovery.test.jsx src/hooks/useStructuredSession.hook.test.jsx src/hooks/useStructuredSession.codex.test.jsx src/components/RelayRecovery.controller.test.jsx
```

After the owner of the central Cargo build window produces a current API binary, run the opt-in real-browser fixture from `frontend/`:

```bash
E2E_RELAY_RECOVERY=1 E2E_RELAY_API_BIN=/absolute/path/to/terminal-v4-api \
  npx playwright test e2e/relay-recovery.spec.ts --project=chromium --reporter=line
```

`E2E_LOCAL_BROWSER` optionally selects an installed Chrome executable. On macOS the default is the installed Google Chrome; other hosts use Playwright's Chromium. `E2E_RELAY_EVIDENCE=/tmp/relay-recovery.json` optionally records result hashes and synthetic ephemeral ports. The fixture starts three independent loopback APIs per case with private temporary data roots, empty configuration homes and synthetic owners. It never uses existing ports/accounts, live devices or providers. A registration-header stripping shim tests the legacy 64 KiB limit; updated endpoints deliver a 130,000-byte UTF-8 event, while a 9 MiB event receives the forwarded 1009 reason and recovers exactly once over the actual paired HTTP route. It asserts canonical IDs/seqs, exact content hashes, visible history-only status, no mutations/page errors and no reconnect after online/focus events. Controller cases also load the actual TerminalPane and MobileShell callers, structured hook and DesktopStatusBar with application styles; an inert session-metadata context replaces the global session provider. They verify editable retained drafts, disabled submit and no Enter mutation after recovery, with a phone viewport for MobileShell. A browser request guard blocks every non-read API request before it reaches any server. E2E_RELAY_MODES can select comma-separated cases for a focused rerun (legacy, upgraded, oversized, revoked, controller-desktop, controller-mobile). This is not a whole-App, production TLS or old-release deployment check.

History recovery is limited to 20 MiB of decoded HTTP bytes, 32,768 events and 15 seconds. The browser stays in history-only mode until remount/reload; failures preserve existing text and show a recovery message. The existing API owner/grant rules apply to the fallback. The Rust filter `relay_delivers_large_structured_history_event_without_changing_application_message` covers the three-host proxy close forwarding and legacy/negotiated/oversized cases; run it through the shared compile owner.

## Isolated WebContainer runner checks

Focused frontend coverage (no WASM, package registry or model calls):

```sh
npm --prefix frontend test -- --run src/utils/webcontainerWindow.test.js src/utils/webcontainer.test.js src/components/WebContainerWindow.test.jsx src/components/WebContainerPreview.test.jsx src/components/preview/PreviewUrlBar.test.jsx vite.config.test.js
```

The tests cover exact document headers, Vite's final HTML cache policy, bounded
one-use launch metadata and its create/claim interleaving, decoded-body limits
before JSON parsing, private-file review, direct stored-owner checks, Stop/Retry,
late boot retirement, binary mounts and canceled raw-spawn/exit barriers. Run
`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api webcontainer --lib`
through the shared compile owner when builds are coordinated; its projection
fixtures contain only synthetic files and verify omissions and size budgets.

A real runtime release check needs an isolated disposable Chrome profile, a
synthetic local-testing account on an owned scratch API, and an owned project.
Use the actual PreviewPanel launcher and `/webcontainer` entry. Verify the
normal parent remains non-isolated and its opaque proxy remains interactive
before/during/after the runner; verify the child is isolated and openerless.
Use only explicitly authorized public SDK/WASM/npm dependencies and harmless
project scripts. Confirm real Node/npm/package output, byte-exact assets,
interactive project HTML in the vendor-origin sandbox, denied app-storage
access, Stop/Retry and cross-window logout retirement. Do not count a disabled
menu, mocked runtime, HTTP 200 or scratch direct-SDK boot as product success.

The audit fixture under `/tmp/terminal-v4-audit-20261023/fix-webcontainer-isolated-runner`
uses the actual source through an owned Vite server and the scratch API. Its
browser request guard permits only synthetic auth, the exact synthetic export
path and owned normal-preview resource grants; unrelated application metadata
requests are intercepted. Browser security flags and real accounts/projects,
private histories, hardware and providers are excluded. Parent-owned production
builds and the full app suite remain separate integration gates.

### Bundled shared browser

Provision with `npm run browser:install`. Run `node --test scripts/workspace-browser.test.cjs`
for actual managed-Chromium navigation, network restrictions, human/agent targets,
modal recovery and RPC correlation. Pure broker/lease/approval regressions use
`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api workspace_browser --lib`.

After `npm run frontend:build`, explicitly run the complete synthetic MCP and
visible Browser-pane fixture:

```sh
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api managed_shared_browser_mcp_and_real_workspace_ui --lib -- --ignored --nocapture
```

This uses temporary accounts/data, real bundled Chromium and the MCP SDK. It checks
Allow once/Deny, same-page typing/clicks, human takeover/handoff, prompt draft
retention after failed agent work, owner isolation, pane reopen and desktop/mobile rendering;
screenshots go to the task's `output/`
evidence directory. It does not access an existing browser profile or paid model.

For a release `.app`, copy it outside the checkout, ensure port 3020 is unused,
and run `scripts/workspace-browser-package-check.cjs <absolute-relocated-app-path>`
with that app's `Contents/Resources/browser-runtime/node/bin/node`. This launches
the actual desktop executable with an empty executable search path and temporary
home/data, then tests its embedded API/frontend and browser. The runner shuts down
its own desktop process and synthetic browser sessions. It does not validate
Windows/Linux installers or distribution notarization.

Set `TERMINAL_V4_PACKAGE_API_ONLY=1` to exercise the relocated package's embedded
API, frontend and browser without opening its desktop window. This mode checks
the web interface and resource resolution; it does not test native window startup.
