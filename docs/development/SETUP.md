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
| `HOST` | Host binding | `0.0.0.0` |
| `LOG_LEVEL` | Fastify logger level | `info` |
| `TERMINAL_DATA_DIR` | SQLite data directory | `backend/data` |
| `DATA_DIR` | Preview cookie store dir | `backend/data` |
| `CLAUDE_BIN` | Path/alias for Claude CLI | `claude` (or `claude.cmd` on Windows) |
| `CLAUDE_ALLOWED_TOOLS` | Comma-separated list for `--allowedTools` | *(unset)* |
| `CLAUDE_ASSUME_YES` | If `true`, uses `--dangerously-skip-permissions` | `false` |
| `CLAUDE_DEBUG` | If `true`, logs Claude CLI I/O | `false` |
| `ANTHROPIC_API_KEY` | Passed to Claude CLI as env | *(unset)* |
| `OPENAI_API_KEY` | Fallback API key for OpenAI routes | *(unset)* |
| `GROQ_API_KEY` | Fallback API key for voice transcription | *(unset)* |
| `JWT_SECRET` | JWT signing secret | *(dev default if unset)* |
| `REFRESH_SECRET` | Refresh token signing secret | *(dev default if unset)* |
| `ALLOWED_USERNAME` | Restrict logins to a single username | *(unset)* |
| `STORAGE_DATABASE_URL` | External Postgres users database for login | *(required for live login)* |

Notes:
- `TERMINAL_DATA_DIR` (or `DATA_DIR`) sets the base data directory for SQLite,
  terminal/Claude Code sessions, bookmarks, notes, and preview cookies.
  Default is `backend/data` (repo-relative) in dev; set it explicitly in prod.
- For systemd/production, set `TERMINAL_DATA_DIR` explicitly so rebuilds keep
  using the same data directory (otherwise a bundled build may resolve `data`
  at the repo root).

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

Backend (Fastify + TypeScript):

```bash
cd backend
npm run dev
```

Frontend (React + Vite):

```bash
cd frontend
npm run dev
```

Defaults:
- Backend: http://localhost:3020
- Frontend: http://localhost:5173 (proxying `/api/*` to backend)

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
- `npm run desktop:predev` - build frontend/backend bundles consumed by desktop shell
- `npm run desktop:dev` - launch native desktop app in development mode
- `npm run desktop:build` - create desktop build artifacts (bundle disabled in current phase)

Notes:
- Phase 1 desktop mode forces local-only backend binding (`127.0.0.1:3020`).
- Network share mode is intentionally not enabled yet.
- Desktop shell source lives in `desktop/tauri/src-tauri`.

## Rust Backend Rewrite Workspace

A parallel Rust workspace lives in `rust/`. It is the foundation for the
incremental backend rewrite and currently does not replace the Node backend used
by the desktop or web app.

Commands:

```bash
cd rust
cargo check
cargo test
cargo run -p terminal-v4-api
```

Current scope:
- shared config/domain crate (`terminal-v4-core`)
- Axum API crate (`terminal-v4-api`)
- initial `/api/health` parity endpoint
- local SQLite and external Postgres `/api/auth/login` and `/api/auth/refresh`
- JWT-authenticated `/api/auth/me` and `/api/auth/logout`
- live and persisted `/api/terminal` listing, create, restore, rename, and delete
- `/api/terminal/:id/input`, `/api/terminal/:id/resize`, and `/api/terminal/:id/ws`
- `/api/terminal/:id/history`, `/api/terminal/:id/turns`, `/api/terminal/:id/git-branches`, and `/api/terminal/:id/generate-topic`
- `/api/terminal/:id/thread` and `/api/terminal/:id/detect-project`
- `/api/structured/sessions`, `/api/structured/sessions/:id`, `/api/structured/sessions/:id/thread`, and the message/approve/interrupt/delete routes
- `/api/structured/sessions/:id/ws` with access-token query auth for browser clients
- `/api/state`
- `/api/projects/scan`, `/api/projects/scan-dirs`, `/api/system/preview-config`, `/api/preview/active-ports`, and `/api/fs/list`
- SQLite-backed `/api/settings`
- JSON-backed `/api/bookmarks` and `/api/notes`

Current limitation:
- The Rust workspace can now back a manually testable login plus terminal flow in the existing Vite frontend, including folder browsing, terminal creation, and structured `ss-*` session creation/discovery plus backend-backed rename/thread metadata through the shared session inventory. It still does not replace Node for preview/proxy services, richer file/process APIs, passkeys, vault, voice, or the desktop runtime.
- The current Rust terminal manager is PTY-backed and now handles the Windows `cmd.exe` startup cursor-status query in-process so default-shell input works in direct API flows as well as browser-driven sessions, but it still does not provide tmux parity or the full Node terminal feature set.
- When testing the structured-session UI against Rust, restart the API from `rust/` with `cargo run -p terminal-v4-api` so the running binary includes the latest `/api/structured/sessions` routes before pointing Vite at `http://127.0.0.1:3020`.
- The current browser verification path is `BASE_URL=http://127.0.0.1:5175 npx playwright test e2e/structured-sessions.spec.ts --project=chromium` from `frontend/`. It covers structured create, rename, pin, and reload persistence against the live Rust backend.

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
