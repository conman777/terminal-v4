# Claude Code Web UI

Browser-based interface that wraps the Claude Code CLI. The project mirrors the plan from `plan.md`: an Express backend streams JSON from the CLI, while a React client renders a chat-style UI with live tool activity.

## Requirements

- Node.js 18+
- Claude Code CLI installed locally and available on `PATH` (or supply `CLAUDE_BIN`)

## Project Structure

- `backend/` — Express server that spawns the Claude CLI, manages in-memory sessions, and exposes `/api/chat` (Server-Sent Events) plus REST helpers.
- `frontend/` — React + Vite single-page app that connects to the backend, shows a session list, renders streamed Markdown responses, and surfaces live tool activity.

## Getting Started

1. Install dependencies for both apps:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
2. Start the backend:
   ```bash
   npm run dev
   ```
   (Runs on `http://localhost:3020` by default.)
3. In another terminal start the frontend:
   ```bash
   npm run dev
   ```
   (Runs on `http://localhost:5173` and proxies API calls to the backend.)

The frontend streams updates from `/api/chat`, showing Claude's text as it arrives, tracking recent tool activity, and storing each exchange inside the session sidebar.

## Configuration

Set the following environment variables before starting the backend if you need custom behaviour:

- `CLAUDE_BIN` — Override the CLI executable name/path (defaults to `claude`).
- `CLAUDE_ALLOWED_TOOLS` — Comma-separated list passed to `--allowedTools`.
- `CLAUDE_ASSUME_YES=true` — Automatically append `--dangerously-skip-permissions`.
- `PORT` — Change the Express server port (default `3020`).

## API Overview

- `POST /api/chat` — Start or continue a conversation. Accepts `{ message, sessionId?, allowedTools? }` and streams SSE events back to the caller.
- `GET /api/sessions` — List in-memory sessions (metadata + preview).
- `POST /api/sessions` — Create a blank session (used by the UI's “New” button).
- `GET /api/sessions/:id` — Fetch a session's full message history.
- `DELETE /api/sessions/:id` — Drop a session from the in-memory store.

## Current Limitations

- The backend assumes the CLI emits well-formed `stream-json` lines; unrecognised payloads fall back to raw JSON in the UI.
- Session continuation depends on the CLI returning a `sessionId`; the UI tracks whatever the backend reports in the `started` event.
- Tool activity signals rely on either structured chunk payloads or stderr logs; expect to adjust parsers as you learn the real CLI shapes.
- Session persistence is in-memory only; restarting the backend clears state.

## Next Steps

- Refine chunk and activity parsing once the exact CLI JSON schema is known.
- Persist session history and expose `/api/sessions`.
- Add authentication and production-ready deployment hardening.
