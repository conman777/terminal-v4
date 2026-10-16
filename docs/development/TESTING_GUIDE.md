# Testing Guide

This document describes how to run and extend the project’s automated tests.

## Test Matrix Overview

| Scope | Location | Command | Notes |
| --- | --- | --- | --- |
| Backend unit/integration | `backend/` | `npm test` | Vitest + Supertest |
| Backend type checks/build | `backend/` | `npm run build` | `tsup` compile (type errors fail) |
| Rust API unit/integration | `rust/` | `cargo test` | Axum route/store tests |
| Rust API formatting | `rust/` | `cargo fmt --all --check` | Required before commits |
| Frontend unit tests | `frontend/` | `npm test` | Vitest + React Testing Library |
| E2E (legacy) | project root | `npm run test:e2e` | Runs Playwright tests in `tests/` |
| E2E (frontend) | `frontend/` | `npx playwright test` | Uses `frontend/playwright.config.ts` |
| Local app smoke | project root | `npm run app:verify` | Checks requirements, API health, production UI, and optional Vite dev UI |

## Backend Testing

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

Guidelines:
- Keep route coverage in `rust/crates/api/src/lib.rs` tests unless a helper is reusable enough to justify a colocated module test.
- Prefer spawning the Axum router and exercising authenticated HTTP/WebSocket flows over mocking internals.
- On Windows, install Strawberry Perl and ensure `C:\Strawberry\perl\bin` is on `PATH` before running Cargo commands that build the passkey/OpenSSL stack.

## E2E Testing

### Legacy suite (root)
```bash
npm run test:e2e
```
- Runs Playwright tests in `tests/`.
- Targets the older UI flow (treat as legacy coverage).

### Frontend suite (frontend/e2e)
```bash
cd frontend
npx playwright test
```
- Uses `frontend/playwright.config.ts`.
- Default `baseURL` is `http://localhost:3020` (backend serving built frontend).
- Set `BASE_URL=http://localhost:5173` to point at Vite dev server.

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
./scripts/setup-hermes.Tests.ps1
```

Run the normal full Rust/frontend/build checks after integration. Windows task
tests exercise a real descendant process tree and temporary persistence locks.
The Unix process-group branch needs verification on a Unix host. Browser checks
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
Claude/Codex adapter protocol tests use controlled local fixtures; Hermes tests
use a temporary SessionDB. Coordinator checks cover source drift, owner isolation,
live-process/task gates, recovery-before-mutation ordering, failure receipts and
idempotent resumed app sessions. Do not use a real provider history or send a paid
model request as an incidental regression check.

```powershell
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib paired
cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api --lib rewind
node --test scripts/provider-rewind-claude.test.mjs
python scripts/provider-rewind-codex.test.py
# Use the Hermes environment Python and set HERMES_TEST_SOURCE to its source root:
python scripts/provider-rewind-hermes.test.py
npm --prefix frontend test -- --run src/utils/remoteEnvironments.test.js src/components/RemoteEnvironmentsPanel.test.jsx src/components/WorkspaceRewindPanel.test.jsx
```

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
