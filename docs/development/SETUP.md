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
| `GROQ_API_KEY` | Fallback API key for voice transcription | *(unset)* |
| `JWT_SECRET` | JWT signing secret | *(dev default if unset)* |
| `REFRESH_SECRET` | Refresh token signing secret | *(dev default if unset)* |
| `ALLOWED_USERNAME` | Restrict logins to a single username | *(unset)* |

Notes:
- `TERMINAL_DATA_DIR` only affects SQLite. Terminal and Claude Code session JSON
  files still live under `backend/data/users/...`.
- `DATA_DIR` controls preview cookie persistence (`preview-cookies.json`).

Frontend configuration (set in `frontend/.env` or your shell):

| Variable | Description | Default |
| --- | --- | --- |
| `VITE_API_URL` | API base URL for the frontend | *(empty = same origin)* |

## Authentication Setup

Login is required and `/api/auth/register` is disabled.
For local development, you can create a user by either:
- Temporarily enabling registration in `backend/src/auth/auth-routes.ts`, or
- Seeding the SQLite `users` table via a small script that calls
  `createUser` from `backend/src/auth/user-store.ts`.

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
