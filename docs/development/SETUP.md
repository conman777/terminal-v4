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
| `DEV_BOOTSTRAP_USER_ENABLED` | Auto-create first user in non-production when DB is empty | `true` |
| `DEV_BOOTSTRAP_USERNAME` | Username for auto-created dev user | `dev` (or `ALLOWED_USERNAME`) |
| `DEV_BOOTSTRAP_PASSWORD` | Password for auto-created dev user | `dev-password` |

Notes:
- `JWT_REFRESH_SECRET` is accepted as a legacy alias, but `REFRESH_SECRET` is preferred.
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
| `VITE_DEV_API_TARGET` | Vite dev proxy target for `/api` and `/preview` | `http://localhost:3020` |

## Authentication Setup

Login is required.

On a clean database in local/dev mode, backend startup now auto-creates a bootstrap
user and logs the credentials. Defaults:
- Username: `dev` (or `ALLOWED_USERNAME` if set)
- Password: `dev-password`

You can override with `DEV_BOOTSTRAP_USERNAME` / `DEV_BOOTSTRAP_PASSWORD`, or
disable auto-bootstrap entirely by setting `DEV_BOOTSTRAP_USER_ENABLED=false`.

## Running the App

Recommended (starts both apps, auto-selects free ports, wires frontend proxy to backend):

```bash
npm run dev
```

If your shell cannot run `npm` because `node` is missing from `PATH`, run:

```bash
./scripts/dev.sh
```

You can still run each app manually:

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
- If either default port is occupied, root `npm run dev` automatically chooses the next free port.
- Root `npm run dev` starts backend from port `4020` upward and frontend from `5173` upward.

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
