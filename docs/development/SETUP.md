# Development Setup

This guide covers local setup for the Terminal v4 project (web terminal + Claude Code UI).

## Prerequisites

- Node.js 18+ (Node 22 recommended for node-pty prebuilt binaries)
- Claude Code CLI installed locally and available on `PATH` (or set `CLAUDE_BIN`)
- pnpm or npm (examples below use npm)

## Install Dependencies

```bash
# From project root
cd backend
npm install

cd ../frontend
npm install
```

## Environment Variables

Backend configuration (set in `backend/.env` or your shell):

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

## Production Service (systemd)

To keep tmux-backed terminals alive across `rebuild.sh` restarts, the service
should avoid killing child processes. The recommended unit file:

```
[Service]
Type=simple
User=conor
WorkingDirectory=/home/conor/terminal-v4/backend
EnvironmentFile=/home/conor/terminal-v4/backend/.env
ExecStart=/usr/bin/node --enable-source-maps /home/conor/terminal-v4/backend/dist/index.js
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

Notes:
- In local browser development, loopback `VITE_API_URL` values are normalized to the current page origin so Vite can proxy `/api/*` and `/preview/*` to the backend even if the configured loopback port is stale.

## Authentication Setup

Login is required. `/api/auth/register` is disabled and returns `403`.

The live TypeScript backend authenticates users against the external Postgres
database referenced by `STORAGE_DATABASE_URL`, then stores refresh tokens and
user settings locally in SQLite/JSON.

If `ALLOWED_USERNAME` is set in the backend environment, login is restricted to
that username after the external user lookup succeeds.

## Running the App

Rust API backend:

```bash
npm run api:dev
```

Frontend (React + Vite):

```bash
cd frontend
npm run dev
```

Defaults:
- Backend: http://localhost:3020
- Frontend: http://localhost:5173 (proxying `/api/*` to backend)

If login fails with a network error or "Failed to fetch", first verify the Rust
API is running on `127.0.0.1:3020`. The Vite dev server proxies auth and API
requests there.

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
- `npm run desktop:build` - create desktop build artifacts (bundle disabled in current phase)

Notes:
- Phase 1 desktop mode forces local-only backend binding (`127.0.0.1:3020`).
- Network share mode is intentionally not enabled yet.
- Desktop shell source lives in `desktop/tauri/src-tauri`.

## Rust Backend Rewrite Workspace

A parallel Rust workspace lives in `rust/`. It is the foundation for the
incremental backend rewrite and now covers the primary desktop/runtime path.

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
  `backend/src/routes/preview-subdomain-routes.ts`; keep that logic in sync
  with any framework-specific module paths (e.g., `@vite`, `@react-refresh`).

## Project Structure

```
backend/     # Fastify server, terminal/Claude services, API routes
frontend/    # React + Vite SPA
docs/        # Architecture + development docs
tests/       # Legacy Playwright tests
frontend/e2e # Newer Playwright tests (see frontend/playwright.config.ts)
```

## Recommended Tooling

- VS Code with ESLint, Prettier, and TypeScript extensions
- Optional: Volta or nvm for Node.js version management
- Optional: Playwright extension for running UI tests

## Next Steps

1. Read `docs/architecture/SYSTEM_ARCHITECTURE.md` for system context.
2. Follow `docs/development/TESTING_GUIDE.md` before pushing changes.
