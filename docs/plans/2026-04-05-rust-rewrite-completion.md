# Rust Rewrite Completion Plan

## Goal

Bring the Rust backend to full Node parity so production can switch from TypeScript/Fastify to Rust/Axum. The bootstrap plan (`2026-04-05-rust-rewrite-bootstrap.md`) established the core — this plan covers everything remaining.

## Current State

**Done (~45 endpoints):** Auth (password+JWT), terminal CRUD/history/WS, structured sessions, settings, bookmarks, notes, project scan, filesystem listing, boot-time routes. 25 Rust tests passing.

**Not done (~55+ endpoints):** Preview/proxy system, file operations, process management, system stats, vault, passkeys, voice, WebContainer, Claude Code sessions, screenshots, desktop Tauri switch, and terminal parity gaps (tmux, git-stats, git-checkout, output batching, turn detection, SSE).

---

## Phase 1 — Terminal Parity (Rust-only, no new crates)

Close the gap between Rust PTY manager and Node terminal-manager.ts so the frontend works identically.

### 1.1 Tmux integration
- **What:** Detect tmux availability, create/attach/detach/kill sessions, recover orphaned sessions on startup, query cwd via `tmux display-message`.
- **Node ref:** `backend/src/terminal/tmux-manager.ts`
- **Rust target:** New `tmux.rs` module in `crates/api/src/`
- **Key details:** Session naming `terminal-app-{id}`, history limit from env, two-step create (detached new-session → PTY attach), kill = detach not destroy.

### 1.2 Git stats + git checkout
- **What:** `GET /api/terminal/:id/git-stats` (diff --stat parsing), `POST /api/terminal/:id/git-checkout`.
- **Node ref:** `backend/src/terminal/git-branches.ts`, `terminal-manager.ts`
- **Rust target:** Add handlers in `lib.rs`, git logic in `terminal.rs`
- **Key details:** 5s timeout for branch list, 15s for checkout. Parse `(\d+) insertions?\(\+\)` regex.

### 1.3 Output batching
- **What:** Coalesce rapid PTY output into fewer WebSocket messages. Size-based flush at 4KB (adaptive to 32KB), time-based flush at 16ms (adaptive 8-24ms), burst detection at 32KB.
- **Node ref:** `backend/src/terminal/terminal-manager.ts` (OutputBatcher class)
- **Rust target:** New `output_batcher.rs` or inline in `terminal.rs`

### 1.4 Turn detection
- **What:** Detect Claude Code conversation turns from PTY output. Filter UI chrome (progress bars, token counts, tool indicators). Emit structured `{role, content, ts}` turns.
- **Node ref:** `backend/src/terminal/turn-detector.ts`, `busy-state.ts`
- **Rust target:** New `turn_detector.rs`

### 1.5 SSE streaming endpoint
- **What:** `GET /api/terminal/:id/stream` as alternative to WebSocket. Event-source with cursor-based pagination, 15s ping keepalive, `end` event on session close.
- **Node ref:** `backend/src/routes/terminal-routes.ts`
- **Rust target:** Axum SSE handler in `lib.rs`

### 1.6 Idle/busy detection
- **What:** Detect prompt patterns (Windows `C:\path>`, Unix `user@host:path$`) to mark sessions idle. Configurable idle timeout (`TERMINAL_IDLE_TIMEOUT_MS`).
- **Node ref:** `backend/src/terminal/busy-state.ts`
- **Rust target:** Logic in `terminal.rs`

**Deliverable:** Frontend terminal view works identically against Rust. Tmux sessions survive server restart.

---

## Phase 2 — Auth Completion (Passkeys)

### 2.1 WebAuthn/Passkey support
- **New dependency:** `webauthn-rs` crate
- **DB migration:** Add `passkey_credentials` table (id, user_id, credential_id UNIQUE, public_key BLOB, counter, device_type, backed_up, transports JSON, name, created_at, last_used_at). Add indexes on user_id and credential_id.
- **In-memory challenge store:** HashMap with 5-minute TTL, consume-on-use, periodic cleanup.
- **6 endpoints:**
  - `POST /api/auth/passkey/register/begin` (authed)
  - `POST /api/auth/passkey/register/complete` (authed)
  - `POST /api/auth/passkey/authenticate/begin` (public)
  - `POST /api/auth/passkey/authenticate/complete` (public)
  - `GET /api/auth/passkey/credentials` (authed)
  - `DELETE /api/auth/passkey/credentials/:id` (authed)
- **Config:** `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` env vars.
- **Node ref:** `backend/src/auth/passkey-service.ts`, `passkey-routes.ts`, `passkey-store.ts`

**Deliverable:** `frontend/src/utils/passkey.js` works against Rust.

---

## Phase 3 — File Operations + Vault

### 3.1 File manager endpoints
- **8 endpoints:**
  - `GET /api/files/list` — readdir with metadata, sort dirs first
  - `POST /api/files/mkdir` — recursive directory creation
  - `POST /api/files/upload` — multipart, 100MB limit, staging dir
  - `GET /api/files/download` — file or directory as ZIP (use `zip` crate)
  - `DELETE /api/files/delete` — recursive rm
  - `POST /api/files/rename` — move/rename
  - `POST /api/files/unzip` — extract with Zip Slip validation
  - `POST /api/files/screenshot` — image upload with magic number MIME detection
- **New dependencies:** `zip` crate, `tokio-multipart` or `axum-extra` multipart
- **Security:** Path traversal prevention, symlink resolution, hidden file exclusion
- **Node ref:** `backend/src/routes/file-routes.ts`

### 3.2 Vault (API key storage)
- **4 endpoints:**
  - `GET /api/vault` — list keys (masked: `****` + last 4 chars)
  - `POST /api/vault` — add key (AES-256-GCM encrypted)
  - `GET /api/vault/:id/reveal` — decrypt and return
  - `DELETE /api/vault/:id` — remove
- **DB migration:** Add `api_key_vault` table (id, user_id, key_name, key_value encrypted, created_at). Unique on (user_id, key_name).
- **New dependency:** `aes-gcm` crate, `rand` for IV generation
- **Encryption format:** `enc:v1:{iv_hex}:{tag_hex}:{ciphertext_hex}`
- **Config:** `VAULT_ENCRYPTION_KEY` env var (SHA256 hashed to derive key)
- **Node ref:** `backend/src/routes/vault-routes.ts`, `utils/secret-crypto.ts`

### 3.3 Filesystem download endpoint
- **What:** `GET /api/fs/download` — ZIP archive of directory
- **Node ref:** `backend/src/routes/filesystem-routes.ts`

**Deliverable:** `FileManager.jsx` and `ApiSettingsModal.jsx` work against Rust.

---

## Phase 4 — Preview & Proxy System

This is the largest chunk (~4,700 lines of TypeScript). Port in sub-phases.

### 4.1 Core subdomain/path proxy engine
- **What:** `onRequest` hook intercepts `preview-{port}.{domain}` or `/preview/{port}/...` requests. Proxy HTTP to `localhost:{port}` with fallback hosts. Strip iframe-blocking headers.
- **Key logic:** Host regex matching, upstream connection with retry (ECONNREFUSED), response streaming (10MB max), 30s timeout.
- **Config:** `PREVIEW_SUBDOMAIN_BASES`, `PREVIEW_PROXY_HOSTS`, `PREVIEW_REWRITE_SCOPE`
- **Auth bypass:** Preview subdomain requests skip Terminal V4 auth.
- **Node ref:** `backend/src/routes/preview-subdomain-routes.ts` (3,032 lines — the biggest single file)

### 4.2 Cookie handling
- **What:** Per-(userId, port, path) cookie jar. Extract from upstream Set-Cookie, merge into outbound requests. Three policies: preserve-upstream, compat-rewrite, force-none.
- **Endpoints:** `GET/DELETE /api/preview/:port/cookies`
- **Node ref:** `preview/cookie-store.ts`, `preview/cookie-rewrite.ts`

### 4.3 WebSocket proxy
- **What:** Proxy WebSocket connections through preview subdomain or path. Bidirectional forwarding, buffered handshake, 10s timeout.
- **Node ref:** `preview-subdomain-routes.ts` (WebSocket handler section)

### 4.4 Script injection & URL rewriting
- **What:** Inject debug script into HTML `<head>` for console capture, error capture, storage sync. Three rewrite modes: minimal (script only), hybrid (script + HTML attrs), legacy (full parse).
- **Node ref:** `preview-subdomain-routes.ts` (PREVIEW_DEBUG_SCRIPT, rewriting functions)

### 4.5 Port scanning & active ports
- **What:** `GET /api/preview/active-ports` — platform-specific port scanning (netstat on Windows, lsof on macOS, ss on Linux). Probe each port for HTML/API. 5s cache TTL.
- **Node ref:** `backend/src/routes/preview-api-routes.ts`

### 4.6 Preview log routes
- **What:** Ingest logs from injected debug script, retrieve by type/level/time, SSE streaming, CORS for preview subdomains.
- **5 endpoints:** OPTIONS/POST/GET/DELETE `/api/preview/:port/logs`, GET `/api/preview/logs`
- **Node ref:** `backend/src/routes/preview-logs-routes.ts`

### 4.7 Dev proxy routes
- **What:** `/api/dev-proxy/:port/*` HTTP proxy with URL rewriting + script injection, `/api/dev-proxy-ws/:port` WebSocket proxy for HMR.
- **Key logic:** Rewrite `localhost:PORT` URLs, inject SPA reload script, buffer WS messages during handshake.
- **Node ref:** `backend/src/routes/dev-proxy-routes.ts`

### 4.8 External proxy
- **What:** `GET /api/proxy-external?url=...` — proxy public URLs with private IP blocking, DNS validation, 10MB limit, 30s timeout. Base tag + debug script injection for HTML.
- **3 log endpoints:** POST/GET/DELETE `/api/preview/external/logs`
- **Node ref:** `backend/src/routes/external-proxy-routes.ts`

### 4.9 Static file serving
- **What:** `GET /api/preview?path=...&file=...` — serve files from project directory with path traversal prevention, MIME detection, no-cache headers.
- **Node ref:** `backend/src/routes/preview-routes.ts`

### 4.10 Preview storage & eval
- **What:** `GET/POST /api/preview/:port/storage` (localStorage/sessionStorage/cookies snapshot), `POST /api/preview/:port/evaluate` (REPL, gated by `PREVIEW_EVAL_ENABLED`).
- **Node ref:** `backend/src/routes/preview-api-routes.ts`

**Deliverable:** `PreviewPanel.jsx` and preview iframe work against Rust.

---

## Phase 5 — Process Management + System Stats

### 5.1 Process management
- **6 endpoints:**
  - `GET /api/processes` — list repos with running status
  - `POST /api/processes/start` — spawn app process, detect port from stdout
  - `POST /api/processes/stop` — SIGTERM → SIGKILL after 5s
  - `GET /api/preview/:port/process-logs` — logs by port
  - `GET /api/process-logs/:pid` — logs by PID
  - `GET /api/process-logs` — list all tracked processes
  - `DELETE /api/process-logs/:pid` — clear logs
- **In-memory store:** Map<PID, ProcessInfo> with 1000-log limit, 50KB max per entry, 30min cleanup after exit.
- **Port detection:** Regex patterns on stdout/stderr for common "listening on port X" messages.
- **Node ref:** `backend/src/routes/process-routes.ts`, `processes/process-service.ts`

### 5.2 System stats
- **4 endpoints:**
  - `GET /api/system/stats` — real-time CPU/memory/disk, top processes
  - `GET /api/system/stats/history` — historical data (1h-30d ranges)
  - `POST /api/system/rebuild` — execute rebuild script (5min timeout)
  - `GET /api/system/preview-config` — (already exists in Rust)
- **New dependency:** `sysinfo` crate for cross-platform stats
- **History:** JSON file at `~/.terminal-v4-stats-history.json`, collected every 5min, pruned to 30 days.
- **Node ref:** `backend/src/routes/system-routes.ts`

**Deliverable:** `ProcessManagerModal.jsx` and `SystemResourcesView.jsx` work against Rust.

---

## Phase 6 — Screenshots, Voice, WebContainer

### 6.1 Screenshot & recording
- **7 endpoints:** screenshot (full page + element), recording start/stop, list/get/delete screenshots.
- **Approach decision needed:** Port Playwright-based approach or use a Rust headless browser library. Playwright via CLI subprocess is simplest.
- **Node ref:** `backend/src/routes/screenshot-routes.ts`, `preview/screenshot-service.ts`

### 6.2 Voice transcription
- **2 endpoints:** `GET /api/transcribe/health`, `POST /api/transcribe`
- **Providers:** Local Whisper server (HTTP POST) or Groq API (whisper-large-v3). API key from vault or env.
- **Node ref:** `backend/src/routes/transcribe-routes.ts`

### 6.3 WebContainer file serving
- **1 endpoint:** `GET /api/webcontainer/files?path=...` — recursive file tree with exclusions, binary skip, 1MB/file limit, 50MB total, requires package.json.
- **Node ref:** `backend/src/routes/webcontainer-routes.ts`

### 6.4 Claude Code sessions
- **8 endpoints:** list, start, get, stream (SSE), input, restore, stop, delete + cwd/model update.
- **Node ref:** `backend/src/routes/` (claude-code routes), `claude-code/claude-code-manager.ts`
- **Note:** These are separate from structured sessions — they manage raw Claude Code CLI processes.

**Deliverable:** All remaining frontend components work against Rust.

---

## Phase 7 — Structured Session Polish

### 7.1 Reconnect & history handling
- **What:** Fix WebSocket reconnection to send full event history on reconnect, handle `ss-*` terminal pane paths correctly.
- **Frontend refs:** `useStructuredSession.js:174`, `TerminalChat.jsx:2739`
- **Rust ref:** `structured.rs`, `lib.rs` (WebSocket handler)

### 7.2 Connection recovery
- **What:** Clean up browser console warnings, handle network drops gracefully, resume event stream from last seen sequence.

**Deliverable:** Structured sessions are production-ready.

---

## Phase 8 — Desktop (Tauri Switch)

### 8.1 Switch Tauri to Rust backend
- **What:** Change `desktop/tauri/src-tauri/src/main.rs` to spawn the Rust binary instead of `node backend/dist/index.js`.
- **Changes:**
  - Replace `Command::new("node")` with path to Rust binary
  - Remove `--enable-source-maps` flag
  - Remove npm PATH manipulation
  - Update prerequisite check (Rust binary exists instead of `backend/dist/index.js`)
  - Keep same env vars: HOST, PORT, TERMINAL_V4_DESKTOP, TERMINAL_V4_SHARE_MODE
  - TCP readiness detection stays the same
- **Build integration:** `cargo build --release -p terminal-v4-api` as desktop prebuild step.
- **Node ref:** `desktop/tauri/src-tauri/src/main.rs:60`

**Deliverable:** Desktop app runs on Rust backend.

---

## Phase 9 — Verification & Cutover

### 9.1 Expand test coverage
- **Unit tests:** Each new module (tmux, vault crypto, output batcher, turn detector, cookie jar, URL rewriter)
- **Integration tests:** Every endpoint group via `reqwest` test client
- **Browser tests:** Extend Playwright specs beyond structured sessions to cover:
  - Terminal create/restore/history
  - File manager upload/download
  - Preview proxy (subdomain + path mode)
  - Passkey registration/authentication
  - Settings + vault
  - Process start/stop

### 9.2 Parity validation
- **What:** Run Node and Rust backends side-by-side, replay production API traffic, diff responses.
- **Frontend smoke:** Every component in `frontend/src/components/` renders and functions.

### 9.3 Production cutover
- **What:** Switch `restart.sh` and deployment to use Rust binary.
- **Rollback plan:** Keep Node backend buildable for quick rollback.

---

## Dependency Summary (New Rust Crates Needed)

| Phase | Crate | Purpose |
|-------|-------|---------|
| 2 | `webauthn-rs` | WebAuthn/passkey support |
| 3 | `zip` | ZIP archive create/extract |
| 3 | `aes-gcm`, `rand` | Vault encryption |
| 3 | `axum-extra` (multipart) | File upload handling |
| 4 | `reqwest` | Upstream HTTP proxy |
| 4 | `tokio-tungstenite` | WebSocket proxy |
| 4 | `hyper` | Low-level HTTP for proxy |
| 5 | `sysinfo` | Cross-platform system stats |
| 6 | (none new) | Playwright via subprocess |

---

## Execution Order Rationale

1. **Terminal parity first** (Phase 1) — highest user-facing impact, no new deps
2. **Passkeys** (Phase 2) — security feature, clean scope
3. **Files + Vault** (Phase 3) — unblocks file manager UI, vault unblocks voice
4. **Preview system** (Phase 4) — largest chunk, isolated from other features
5. **Process + Stats** (Phase 5) — moderate scope, useful for development
6. **Screenshots/Voice/WebContainer/Claude Code** (Phase 6) — smaller features
7. **Structured polish** (Phase 7) — fixes, not new features
8. **Desktop switch** (Phase 8) — depends on everything above
9. **Verification** (Phase 9) — final gate before production

---

## Guardrails (Inherited from Bootstrap Plan)

- Keep frontend contract stable during backend migration
- Prefer parity over redesign in early phases
- Don't couple rewrite to a frontend rewrite
- Keep production on Node until full feature slice is proven
- Use existing `backend/data` directory as Rust default for local testing parity
