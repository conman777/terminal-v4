# Development Setup

This guide covers local setup for the Claude Code Web UI (Terminal v4) project. Follow these steps before contributing code.

## Prerequisites

- Node.js 18 or newer
- Claude Code CLI installed locally and available on `PATH` (or set the `CLAUDE_BIN` env var)
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

Backend configuration (set in a `.env` file under `backend/` or via shell):

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Backend HTTP port | `3020` |
| `HOST` | Host binding | `0.0.0.0` |
| `CLAUDE_BIN` | Path or alias for the Claude CLI | `claude` |
| `CLAUDE_ALLOWED_TOOLS` | Comma separated list passed to `--allowedTools` | *(unset)* |
| `CLAUDE_ASSUME_YES` | If `true`, enables `--dangerously-skip-permissions` | `false` |

Frontend uses Vite’s default env handling. Ensure `VITE_BACKEND_URL` in `frontend/.env` points to the backend if customizing ports.

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

By default:

- Backend: http://localhost:3020
- Frontend: http://localhost:5173 (proxying `/api/*` to the backend)

## Project Structure

```
backend/     # Fastify server, Claude CLI adapter, terminal services
frontend/    # React + Vite SPA
docs/        # Architecture, development, and workflow documentation
tests/       # Playwright end-to-end tests (legacy harness)
```

## Recommended Tooling

- VS Code with ESLint, Prettier, and TypeScript extensions
- Optional: Volta or nvm for Node.js version management
- Optional: Playwright extension for running UI tests

## Next Steps

1. Read `docs/architecture/SYSTEM_ARCHITECTURE.md` for context.
2. Follow `docs/development/TESTING_GUIDE.md` before pushing changes.
3. Use `npm run dev` in both apps during local development for hot reload.
