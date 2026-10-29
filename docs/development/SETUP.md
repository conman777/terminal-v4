# Development Setup

This guide covers local setup for the Terminal v4 project (web terminal + Claude Code UI).

## Prerequisites

- Node.js 20.19+ or 22.12+ (Node.js 22 recommended)
- Claude Code CLI installed locally and available on `PATH` (or set `CLAUDE_BIN`)
- pnpm or npm (examples below use npm)

## Install Dependencies

```bash
# From project root
npm install
npm --prefix frontend install
npm run browser:install
```

`browser:install` prepares the app-owned browser runtime described under
[Workspace browser](#workspace-browser). The development Node prerequisite above
is separate from the pinned Node shipped inside that runtime.

## Environment Variables

Backend configuration (set in your shell, or in the environment used to launch
the Rust API):

Direct `npm run api:dev` and Rust binary startup do not load a `.env` file.
Export the variables in that shell or use your service manager's environment
configuration. Desktop startup separately reads `backend/.env`.

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Backend HTTP port | `3020` |
| `HOST` | Host binding | `127.0.0.1` |
| `LOG_LEVEL` | Backend logger level | `info` |
| `TERMINAL_DATA_DIR` | SQLite/data directory override | platform app data dir + `/terminal-v4` |
| `DATA_DIR` | Preview cookie store dir override | same as `TERMINAL_DATA_DIR` |
| `CLAUDE_BIN` | Path/alias for Claude CLI | `claude` (or `claude.cmd` on Windows) |
| `CLAUDE_ALLOWED_TOOLS` | Comma-separated list for `--allowedTools` | *(unset)* |
| `CLAUDE_ASSUME_YES` | If `true`, uses `--dangerously-skip-permissions` | `false` |
| `CLAUDE_DEBUG` | If `true`, logs Claude CLI I/O | `false` |
| `ANTHROPIC_API_KEY` | Passed to Claude CLI as env | *(unset)* |
| `OPENAI_API_KEY` | Fallback API key for OpenAI routes | *(unset)* |
| `GROQ_API_KEY` | Fallback API key for voice transcription | *(unset)* |
| `JWT_SECRET` | JWT signing secret | *(dev default only allowed on loopback binds)* |
| `VAULT_ENCRYPTION_KEY` | Private stable vault key override; preserve it when moving existing data | protected random key at `<data_dir>/vault-encryption.key` |
| `REFRESH_SECRET` | Refresh token signing secret | *(dev default if unset)* |
| `ALLOWED_USERNAME` | Restrict logins to a single username | *(unset)* |
| `STORAGE_DATABASE_URL` | External Postgres users database for login | *(required for live login)* |

Notes:
- `TERMINAL_DATA_DIR` (or `DATA_DIR`) sets the base data directory for SQLite,
  terminal/Claude Code sessions, bookmarks, notes, and preview cookies.
  Default is the platform app data directory plus `terminal-v4`
  (for example `%LOCALAPPDATA%\terminal-v4` on Windows).
- The Rust API refuses to start with the built-in development `JWT_SECRET`
  unless `HOST` stays on a loopback address. Set `JWT_SECRET` explicitly before
  binding to `0.0.0.0` or any other non-loopback interface.
- Set `TERMINAL_DATA_DIR` explicitly if you want repo-local data during dev or
  a custom persistent location in production.

Vault and provider API keys use AES-GCM `enc:v2` ciphertext. With no explicit
private vault key, the runtime atomically creates a random installation key in
its data directory (0600 on Unix), reuses it across restarts, and refuses malformed
or unprotected key files. Back up `vault-encryption.key` together with the database;
keep any existing explicit `VAULT_ENCRYPTION_KEY` unchanged when migrating.
The former public development key is accepted only to read old `enc:v1` data;
setting that literal now selects the protected installation key for new writes.
Both old Rust hex and Fastify base64 `enc:v1` records remain readable. A successful
vault reveal migrates the row to `enc:v2` using a guarded update after decryption;
failed decrypts preserve the original row. Paired-device credentials retain their
existing separate JWT-derived key contract.

Notes and bookmarks live under `<data_dir>/users/<id>/`. The bookmark seed is
created only when the file is absent, so deletion and repurposing persist. A
read/parse failure is returned to the caller and leaves the original file intact;
saves use a temporary file plus atomic replacement. System stats history is
`<data_dir>/stats-history.json`, collected initially and every five minutes by
`start_services`, and stopped by `shutdown_services` or collector disposal.

## Production Service (Linux, systemd)

This section applies to a Linux host; on macOS run the release binary directly
(see "Restarting the Server" in `CLAUDE.md`). Replace `youruser` and the paths
with your own. The rebuild scripts build the frontend and Rust runtime, then leave the running
service unchanged. Restart the owning service explicitly after a successful build.
To keep tmux-backed terminals alive across those restarts, the service should
avoid killing child processes. The recommended unit file:

```
[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/terminal-v4
EnvironmentFile=/home/youruser/terminal-v4/.env
ExecStart=/home/youruser/terminal-v4/rust/target/release/terminal-v4-api
KillMode=process
Restart=always
RestartSec=10
```

After changes:

```bash
sudo systemctl daemon-reload
sudo systemctl restart terminal-v4
```

Frontend configuration (set in `frontend/.env` or your shell):

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_API_URL` | API base URL for the frontend | *(empty = same origin)* |
| `TERMINAL_V4_API_PROXY_TARGET` | Vite dev-server upstream, set in its launch shell for a custom API port | `http://127.0.0.1:3020` |

Notes:
- In local browser development, loopback `VITE_API_URL` values are normalized to the current page origin so Vite can proxy `/api/*` and `/preview/*` to the backend even if the configured loopback port is stale.
- The Rust API serves HTTP. For an API on port 3030, launch Vite with `TERMINAL_V4_API_PROXY_TARGET=http://127.0.0.1:3030 npm run frontend:dev` on macOS/Linux; set that variable in the launch environment on Windows.

## Authentication Setup

Login is required. `/api/auth/register` is disabled and returns `403`.

The active Rust API authenticates users against the external Postgres database
referenced by `STORAGE_DATABASE_URL`, then stores refresh tokens and user
settings locally in SQLite/JSON.

If `ALLOWED_USERNAME` is set in the backend environment, login is restricted to
that username after the external user lookup succeeds.

## Running the App

Rust API backend:

```bash
npm run api:dev
```

Frontend (React + Vite):

```bash
npm run frontend:dev
```

Defaults:
- Backend: http://localhost:3020
- Frontend: http://localhost:5173 (proxying `/api/*` to backend)

Production-style local run:

```bash
npm run frontend:build
npm run api:dev
npm run app:verify
```

Open `http://localhost:3020` for this path. The Rust API serves
`frontend/dist`, which matches the desktop/native app serving model and avoids
Vite request-time transforms.

For UI work, keep shared visual primitives in `frontend/src/WorkspaceUI.css`,
shell geometry in `WorkspaceShell.css`, and surface-specific rules beside their
components. Verify both themes, keyboard focus, desktop controls and 44px touch
targets in the built web interface. Use the isolated UI fixture described in
`TESTING_GUIDE.md` for realistic conversation, terminal and auxiliary-screen checks;
it does not require paid provider calls or existing user data.

Fast local health check:

```bash
npm run app:verify
```

This checks Node/npm/Cargo, the Rust API health endpoint, the production UI on
`3020`, and the optional Vite UI on `5173` if it is running.

If login fails with a network error or "Failed to fetch", first verify the Rust
API is running on `127.0.0.1:3020`. The Vite dev server proxies auth and API
requests there.

## Running the macOS Desktop App (Tauri)

Install Node.js, a stable Rust toolchain and the Xcode command line tools, then run
`npm run desktop:build` from the repository root. The install step prepares the
root runtime dependencies, frontend build tools and desktop CLI. The macOS
configuration creates `desktop/tauri/src-tauri/target/release/bundle/macos/V4.app`.

The app bundles its Rust API, built frontend, original provider rewind helpers,
and the pinned Claude SDK with its runtime dependencies. Hermes Agent and T3 Code
source/runtime packages are not bundled. Native provider CLIs are discovered on
the host. The desktop adds existing user `.local/bin`, `.cargo/bin`, Homebrew and
`/usr/local/bin` directories to its inherited PATH for Finder launches.

The desktop sets `TERMINAL_V4_FRONTEND_DIR` and `TERMINAL_V4_RUNTIME_ROOT` to its
packaged resources, so startup does not require a source checkout or a particular
working directory. A standalone API can also use these explicit paths. Normal
Quit sends SIGTERM to the owned Unix backend and allows five seconds for task
cleanup before forced termination. Attach mode leaves the external backend running.

Local macOS builds use ad-hoc signing and seal bundle resources. They are not
Developer ID signed or notarized. Authentication still requires an existing local
account or the configured external identity database; packaging does not create
an account or configure provider credentials.

## Running the Windows Desktop App (Tauri)

Prerequisites:
- Rust toolchain (`cargo --version`)
- WebView2 runtime (usually present on modern Windows)

From repo root:

```bash
npm run desktop:dev
```

Desktop scripts:
- `npm run desktop:install` - install desktop wrapper dependencies
- `npm run desktop:predev` - build the frontend bundle consumed by the desktop shell
- `npm run desktop:dev` - launch native desktop app in development mode
- `npm run desktop:build` - create desktop artifacts (including a macOS app bundle)

Notes:
- Desktop mode binds to `127.0.0.1:3020` by default. Set `TERMINAL_V4_SHARE_MODE=lan` to share it on your local network (see the README).
- Desktop shell source lives in `desktop/tauri/src-tauri`.

## Rust Backend Rewrite Workspace

The Rust workspace lives in `rust/`. It covers the primary desktop/runtime path.

Commands:

```bash
cd rust
cargo check
cargo fmt --all --check
cargo test
cargo run -p terminal-v4-api
```

Windows note:
- The passkey-enabled Rust build pulls OpenSSL through `webauthn-rs`.
- Install Strawberry Perl and ensure `C:\Strawberry\perl\bin` is on `PATH` before running `cargo test` or desktop Rust builds on Windows.

Current scope:
- shared config/domain crate (`terminal-v4-core`)
- Axum API crate (`terminal-v4-api`)
- `/api/health`
- local SQLite and external Postgres `/api/auth/login`, `/api/auth/refresh`, `/api/auth/me`, `/api/auth/logout`, and `/api/auth/change-password`
- passkey registration/authentication plus credential management
- live and persisted `/api/terminal` listing, create, restore, rename, and delete
- `/api/terminal/:id/input`, `/api/terminal/:id/resize`, `/api/terminal/:id/ws`, and `/api/terminal/:id/stream`
- `/api/terminal/:id/history`, `/api/terminal/:id/turns`, `/api/terminal/:id/git-branches`, `/api/terminal/:id/git-stats`, `/api/terminal/:id/git-checkout`, `/api/terminal/:id/project-info`, and `/api/terminal/:id/generate-topic`
- `/api/terminal/:id/thread` and `/api/terminal/:id/detect-project`
- `/api/structured/sessions`, `/api/structured/sessions/:id`, `/api/structured/sessions/:id/thread`, and the message/approve/interrupt/delete routes
- `/api/structured/sessions/:id/ws` with access-token query auth for browser clients
- `/api/state`
- `/api/projects/scan`, `/api/projects/scan-dirs`, `/api/system/preview-config`, `/api/preview/active-ports`, `/api/fs/list`, and `/api/fs/download`
- SQLite-backed `/api/settings`
- JSON-backed `/api/bookmarks` and `/api/notes`
- `/api/files/*` CRUD, screenshots upload, unzip, and preview file serving
- preview/proxy routes, preview cookies/storage/eval/logs/performance, and dev-proxy websocket bridging
- process manager routes, preview recording/screenshots, system stats/history/rebuild, vault routes, transcription, and WebContainer file tree routes
- desktop Tauri runtime now builds and launches the Rust backend directly

File-manager access is limited to canonical allowed roots. By default this is
the user's home directory and the server working directory. Set
`TERMINAL_V4_ALLOWED_FILE_ROOTS` to a path-list value to add explicit roots for
local development or packaged deployments.

Current limitation:
- The legacy Node backend still exists in `backend/` as a migration reference, but the desktop runtime no longer falls back to it.
- Rust verification on Windows still depends on the local Perl/OpenSSL toolchain being available in the shell environment that launches Cargo.
- Frontend/browser coverage is still thinner than the Rust route surface. Keep expanding Playwright coverage as preview/devtools and auth flows stabilize.

## Preview Troubleshooting (Local Dev Servers)

If the preview only shows the background or a blank page:

- Check the preview console/network for module scripts returning `text/html` or 404s.
- For Vite apps, keep `base` as `/` in dev (only use `/preview/{port}/` for
  production builds if needed).
- Ensure the dev server runs with `NODE_ENV=development` (global `NODE_ENV=production`
  can break React dev runtime in Vite).
- If using `BrowserRouter`, set `basename` when `window.location.pathname`
  starts with `/preview/{port}` so routing works inside the preview iframe.
- The preview proxy rewrites HTML/CSS/JS and inline module scripts in
  `rust/crates/api/src/preview/` and the Rust preview handlers; keep that logic in sync
  with any framework-specific module paths (e.g., `@vite`, `@react-refresh`).

## Project Structure

```
backend/     # Legacy Fastify migration reference
rust/        # Active Rust Axum API runtime and shared crates
frontend/    # React + Vite SPA
docs/        # Architecture + development docs
tests/       # Legacy Playwright tests
frontend/e2e # Newer Playwright tests (see frontend/playwright.config.ts)
```

## Verification

Run repo-level checks from the root:

```bash
npm test       # Rust workspace tests + frontend unit tests
npm run verify # Rust fmt/check/tests + frontend unit tests/build
```

`npm run verify` is the pre-commit hygiene path for the active runtime. It does
not run the legacy Fastify backend tests by default; use
`npm --prefix backend test` when changing migration-reference code.

## Recommended Tooling

- VS Code with ESLint, Prettier, and TypeScript extensions
- Optional: Volta or nvm for Node.js version management
- Optional: Playwright extension for running UI tests

## Next Steps

1. Read `docs/architecture/SYSTEM_ARCHITECTURE.md` for system context.
2. Follow `docs/development/TESTING_GUIDE.md` before pushing changes.


## V4 provider runtime

API-key agents use V4's own Rust provider loop and workspace tools. Configure a
provider key in Settings and select its model when opening a thread. No Hermes
installation is required. See [V4 runtime](../features/V4_RUNTIME.md) for supported
protocols, command approval, session storage and current feature boundaries.

The task worker supports three distinct workspace paths concurrently. Use managed
worktrees for concurrent changes to one repository. Graceful shutdown stops task
process trees and saves interrupted status. Scheduling requires the server to
remain running. V4 unattended tasks allow bounded workspace file tools and deny
shell commands that would require interactive approval.

## Optional paired hosts and rewind runtimes

Run the same Rust API on both hosts and sign in to each independently. Use the
Environments panel's one-use code to pair the destination; do not copy JWT secrets
between hosts. Use a reachable HTTPS origin and valid certificate. An explicit
HTTP opt-in exists for trusted private networks. Each host keeps its own data
folder, provider installation and credentials. Restarting the app is unnecessary
for switching an already paired environment.

Coordinated rewind needs a managed Git worktree and existing files checkpoint.
Install the native provider and its supported SDK/runtime on the server where the
conversation lives. Run `npm install` at the repository root to install the pinned
Claude Agent SDK. Codex uses its app-server protocol. V4 conversations use owned
local history and independent visible-prefix forks. Existing Hermes history may
be imported read-only from `HERMES_HOME/state.db`; it is not an execution runtime.

A packaged server must include the `scripts/provider-rewind-*` runtime helpers
and the root Node dependencies. Set `TERMINAL_V4_RUNTIME_ROOT` to that application
directory when it differs from the source checkout. Native provider binaries,
credentials and histories must be configured on the owning host.
Provider-specific failures remain visible and do not spend model tokens during
source discovery or planning. See [pairing and rewind workflow](../features/PAIRED_ENVIRONMENTS_AND_REWIND.md).

## Username only local testing accounts

Set `TERMINAL_V4_LOCAL_TESTING=1` on the backend to use only a username while
testing locally. For the production-style development build:

```bash
TERMINAL_V4_LOCAL_TESTING=1 HOST=127.0.0.1 PORT=3030 rust/target/debug/terminal-v4-api
```

Open `http://127.0.0.1:3030`, enter a name, and choose **Open workspace**. The
account is created on first use and reused thereafter, including after a restart.
Names are case-insensitive ASCII letters, numbers, dots, underscores or hyphens,
up to 48 characters. Different names have separate owned settings and histories.
Testing profiles use a separate internal username namespace, so a name such as
`Conor` can be used even if a password account already has that name. The testing
profile has its own identity and data; it cannot open the password account.
Existing testing profiles from the earlier format keep their original identity.

The backend must remain running while testing; an open browser tab alone does
not keep it alive. Connection errors report the actual configured app address,
including a custom port such as 3030.

This opt-in mode requires a loopback bind and local account storage. It refuses
non-loopback hosting and external auth storage. Removing the flag restores
password/passkey access and rejects testing-account access, refresh, preview and
WebSocket credentials. Testing account data remains saved for later testing.

For current resource findings and the proposed optimization sequence, see
[Resource efficiency audit](RESOURCE_EFFICIENCY_AUDIT.md).

## Local Codex conversations

Install Codex on the computer running the Rust backend and run `codex login`
there once. Open a workspace, choose **New terminal**, select **Codex**, then
**Open here**. This opens the conversation UI. The app uses that installation's
sign-in and configuration; no separate API key is required in app Settings.

Codex must be discoverable on the backend's PATH. `CODEX_BIN` can point to a
specific executable; `CODEX_HOME` selects its native configuration/history root.
Restart the backend after changing these environment variables. A signed-out or
incompatible installation produces a visible conversation error. The initial
integration supports text, streamed assistant/tool results, native approvals,
Stop and saved-thread continuation. See [Local Codex](../features/LOCAL_CODEX.md).

## Remote workspace setup

Use Environments to pair and organise devices; Workspace tools exposes transfers,
sharing and replay. New remote-control capabilities are opt-in through the
destination's Custom pairing profile. Preserve each host's signing secret and
data directory across restarts. The Windows background launcher can capture
TERMINAL_V4_DESKTOP_ACCESS, TERMINAL_V4_RELAY_URL, TERMINAL_V4_RELAY_KEY and
TERMINAL_V4_RELAY_SERVER_KEY at initialization, along with native-provider roots.

Desktop viewing/control requires TERMINAL_V4_DESKTOP_ACCESS=view or control on
an interactive Windows host. Other platforms and disabled hosts report unavailable.
A service tunnel's local listener belongs to the home API computer. The optional
broker requires trusted HTTPS hosting; no relay is deployed by these changes.

See [Remote workspace](../features/REMOTE_WORKSPACE.md),
[Background host](../features/BACKGROUND_HOST.md), and
[Device relay](../features/DEVICE_RELAY.md) for setup commands and limits.

## Screenshot and preview runtime requirements

The production runtime includes the pinned Playwright package. Install its Chromium
browser (`npx playwright install chromium`) before screenshot/recording use, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed compatible executable.
Packaged runtimes resolve the module from `TERMINAL_V4_RUNTIME_ROOT`, with the
legacy backend directory retained as a checkout fallback. An unavailable package
or browser reports an actionable error instead of using an unsupported CLI option.

Static file previews preserve authenticated dependent HTML/CSS/module asset URLs.
Applications generating arbitrary relative `fetch()` URLs at runtime should use a
local dev server preview; query-based file previews are not a general website host.
The resources dashboard opens through Settings → Processes → Open System Resources.
Use Back to workspace to return without closing the active conversation.

## Workspace layout

The desktop workspace keeps navigation, conversation, and optional tools in
separate regions. Drag the navigation or browser edge to resize it; focused resize
handles also support arrow keys, Home and End. Double-click an edge to restore its
default width. Width preferences survive closing and reopening panels.

Conversation content and its composer share a centered reading rail. Browser
expand/restore keeps the conversation mounted. At 980px and below the browser
opens as a dismissible sheet; at 768px and below navigation uses the mobile menu,
including on touch devices. Closing the browser returns focus to its opener and
retains its tabs and the current conversation draft.
Browser entry points restore the workspace from fullscreen or System Resources.
Pending browser requests remain visible whenever the browser pane is hidden.

## Workspace browser

Use **Browser** beside the session name, in the desktop sidebar, or in the mobile header menu to open an
interactive Chromium session alongside the terminal. It runs on the home API
server and sends its viewport through authenticated app requests, so it also
works through Tailscale. The address bar accepts websites, local development
server URLs, and searches. Preview remains the separate development inspector.
The address selects its contents on focus; Escape restores the current page
address. Desktop page typing controls expand from **Typing**. Touch layouts keep
those controls available. **Browser actions → Reset** clears tabs and sign-ins.

From the repository root, run:

```bash
npm run browser:install
npm run browser:verify
```

The app owns Node **22.23.1**, Playwright **1.64.1**, and its Chromium revision
**1248**, staged together in `.runtime/browser`. `app:build`, desktop install,
desktop predev and Tauri build/bundle hooks prepare this runtime; desktop resources
include it as `browser-runtime/`. No separately installed Chrome is required.
The installer may copy the matching Chromium revision from a Playwright cache as
a build input, or download it, but the running shared browser never resolves an
installed Chrome, a global Node/Playwright package, or a shared browser cache.
`PLAYWRIGHT_NODE_BIN`, `WORKSPACE_BROWSER_BIN` and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` do not select this shared browser's engine.
The preceding preview screenshot/recording requirements describe a separate path.

Runtime lookup checks an explicit `TERMINAL_V4_BROWSER_RUNTIME_DIR` first, then
`TERMINAL_V4_RUNTIME_ROOT/browser-runtime`, an executable-sibling
`browser-runtime`, and the checkout's `.runtime/browser`. An invalid explicit
directory or first existing candidate fails rather than silently using another
candidate. Manifest, platform/architecture, pinned package versions and contained
executable paths are validated. A missing runtime reports install/repair guidance.

Preparation supports native macOS arm64/x64, Linux arm64/x64 and Windows x64;
cross-compilation is rejected. A newly staged runtime gets a local data-page smoke
check; `browser:verify` also checks an existing runtime by launching bundled
Chromium, filling/clicking and taking a screenshot with an empty `PATH` and fresh
home/cache directories. Reusing an already valid runtime during `browser:install`
does not repeat that smoke check. These checks are evidence for the current host,
not portable proof that every packaged target or clean machine works; Chromium's
OS libraries, sandbox support and packaged resources still need verification.

There is one temporary browser context per authenticated account and data
directory, shared by the human pane, native Codex, native Claude and in-app V4
conversations across workspaces. Personal browser profiles are never attached or
imported. Tabs, cookies and sign-ins remain for this session; Reset, logout, server
shutdown, or 30 minutes without browser requests ends it. Closing the pane keeps
the session available until that timeout. File uploads, downloads and persistent
auth-state import/export are unavailable. Sites that reject automated Chromium
may not work. The headless engine remains visible remotely through app frames.

To allow agents, enable **Settings → Agent browser** and add exact
`allowedOrigins`, including each needed resource origin and port. The shared
engine always uses its bundled executable and headless frame transport; the
saved executable/headless fields apply to standalone V4, not the shared engine.
Human browsing is not restricted by the agent origin list. Native Codex/Claude
receive a scoped, expiring `terminal_v4_browser` MCP capability; each browser
action needs its own decision in the Browser pane (release-control is exempt).
Codex's native tool approval may also appear. V4 uses its own exact-action
conversation approvals and denies unattended browser work. Shared-browser errors
are returned; they never trigger a standalone browser fallback.

**Take control** cancels pending native browser actions and blocks agent mutations;
**Let agents control** permits fresh requests. Approved reads of allowed pages can
still occur while the human controls the browser. Claude's browser-only transport
allow-list does not enable ordinary native tools: print mode retains native
permission restrictions and cannot turn a generic confirmation into an exact
tool grant. Email content and metadata always require explicit consent for the
current task and the exact email address before access; an allowed origin or tool
approval alone does not supply that consent. See
[V4 agent browser tools](../features/V4_AGENT_BROWSER.md) for limits.

The account-owned `/api/workspace-browser/sessions` endpoints provide session
creation, frames, navigation, tabs, keyboard, pointer input, and dialogs. They do
not expose CDP or arbitrary JavaScript evaluation to the human HTTP client;
agents have a separately approved `browser_evaluate` tool. Browser sessions stay
on the home server when a paired environment is selected.

Run `node --test scripts/workspace-browser.test.cjs` for real Chromium checks and
`cargo test --manifest-path rust/Cargo.toml -p terminal-v4-api workspace_browser`
for authenticated API route checks.

## Private Tailscale access for username-only testing

Keep the API on loopback. `scripts/tailscale-local-proxy.mjs` provides an owner-only
gateway for private Tailscale Serve while preserving the API's local-origin login
checks. Set `TAILSCALE_ALLOWED_LOGIN` to the exact Tailscale owner login,
`TAILSCALE_EXTERNAL_HOST` to this device's `.ts.net` name, and
`TAILSCALE_UPSTREAM_PORT` to the API port (default3030). The gateway binds
`127.0.0.1:3040` and checks identity, authority and browser origin before forwarding
HTTP or WebSockets. Direct LAN/tailnet binding and Funnel are unsupported.

The preferred `TAILSCALE_APP_ORIGIN` is `https://<device>.ts.net`, with
`tailscale serve --bg --https=443 http://127.0.0.1:3040`. HTTPS can require one-time
Tailscale account setup. The explicit private fallback origin is
`http://<device>.ts.net:8080`, with
`tailscale serve --bg --http=8080 http://127.0.0.1:3040`. HTTP lacks a browser secure
context; use HTTPS for microphone and other APIs requiring it. Preserve unrelated
Serve routes when changing this configuration.

Login refresh uses Web Locks when available. On HTTP, it serializes refreshes
with a dedicated IndexedDB transaction instead. Keep first-party storage enabled;
unavailable coordination preserves credentials and reports a refresh error rather
than sending competing rotations.

Opaque preview reads have a narrow exception: one scoped resource ticket, known
preview routes and GET/HEAD only. Broad headers and credential query values are
removed; the API verifies the resource signature and scope. Run
`node --test scripts/tailscale-local-proxy.test.mjs scripts/tailscale-local-proxy.adversarial.test.mjs`.
The optional browser check is
`TAILSCALE_GATEWAY_BROWSER_TEST=1 node --test scripts/tailscale-local-proxy.browser.test.mjs`;
it uses an isolated runtime and synthetic data.

## WebContainer window

From a home-environment Node project, open the preview tools menu and choose
**Open WebContainer window**. Chrome/Edge needs a secure UI origin (HTTPS, or
trustworthy localhost). The new tab displays the pinned project and start
command; click Run, review any private-file omissions, then run the exported
files. Run/Retry, Stop, and Return to normal app operate independently of the
normal preview. The ordinary app can remain non-isolated and need not expose
SharedArrayBuffer.

Production hosting must serve the existing app HTML at exactly `/webcontainer`
and `/webcontainer/` with COOP `same-origin`, COEP `require-corp`, and no-store.
The Rust handler provides this scoped policy; reverse proxies must preserve it
without applying it to other documents. Vite mirrors the exact-path policy in
development. Missing isolation headers produce a visible prerequisite error;
there is no guard bypass or trial-token workaround. The SDK and its runtime
origins need normal public network/service-worker access.

Launching uses the current same-origin account and a two-minute, one-use random
fragment ID. No token or project tree goes through the URL or an opener bridge.
A `noopener` open may return null even when successful: use the displayed real
link if a tab did not appear. An expired, consumed, reloaded or wrong-account
launch must be opened again from the normal app. Web Locks/storage must be
available; unsupported locking fails visibly. Paired-host projects are blocked
rather than replaced by a home project.

Known private configuration and key files are omitted, while example files and
public assets remain. Required omitted configuration may make a project
unsuitable for WebContainer; use the ordinary proxy in that case. This is a
conservative filename policy, not a guarantee that arbitrary source contains no
secrets. Binary transport can expand JSON beyond the 64 MiB decoded response
budget even below the 50 MiB raw-content limit; this produces an explicit error.
