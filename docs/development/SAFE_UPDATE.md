# Safe update procedure (backend + frontend together)

Observations below were taken read-only on the Mac mini on 2026-10-29. Re-run the
checks in "Verify current state" before trusting them.

## Three different things called "the build"

| Name | What it is | How to identify |
| --- | --- | --- |
| Source | Files in the checkout at the checked-out commit (and uncommitted edits) | `git rev-parse HEAD`, `git status --short` |
| Tested build | Output a verifier built from a specific commit, usually in a scratch `CARGO_TARGET_DIR` or a worktree | Only counts if the commit hash and dirty state were recorded when it was tested |
| Served build | Whatever process is actually listening, plus the `dist/` it reads | `lsof`, process cwd, hashed asset names in the served `index.html` |

Never assume one equals another. Check HEAD, uncommitted changes (`git status`), and the
served asset hashes separately and record all three before and after an update.

## Observed state on this Mac mini (2026-10-29)

- Port 3020 is held by PID 13050, `node --enable-source-maps dist/index.js` (parent
  `npm start`, PID 13034), cwd `/Users/conordart/terminal-v4/backend`, started 13:27.
  This is the legacy Node/Fastify backend, not the Rust `terminal-v4-api`.
- It serves `/Users/conordart/terminal-v4/frontend/dist`. The index.html it serves
  references `index-BipSlKl_.js`, `index-CqXwP4EZ.css`, `vendor-xterm-_gYuLAjD.js`; these
  are identical to the current `frontend/dist/index.html` and files on disk (built 13:26).
  So served == what is in `dist/` now. Whether that `dist/` matches the branch source was
  NOT proven: the working tree is on `fix/macos-app-verification` (HEAD 61f1e21) with
  10 modified tracked files and an untracked `delegation_prune.rs`; a bundle hash does
  not map to a commit. Rebuild in a scratch location and compare hashes to prove it.
- The log shows it bound `0.0.0.0:3020` (also listed as 127.0.0.1, 192.168.1.61,
  192.168.1.195, 100.71.88.107). `curl http://100.71.88.107:3020/api/health` and
  `http://127.0.0.1:3020/api/health` both returned `200 {"status":"ok"}`. The Tailscale
  address is therefore the Node server directly, with no gateway or identity check.
  This conflicts with the documented model (SETUP.md "Private Tailscale access":
  API on loopback, gateway on 127.0.0.1:3040).
- Nothing listens on 3030, 3040 or 8080 (`lsof -iTCP -sTCP:LISTEN`).
- Node data: SQLite at `/Users/conordart/terminal-v4/data/terminal.db` (open by PID 13050).
  A separate, older store exists at `~/Library/Application Support/terminal-v4`
  (`terminal.db`, `users/`, last modified May 9); that is the Rust/desktop default data
  dir. Two data stores exist; do not point a new server at one assuming it is the other.
- `restart.sh` is stale for this machine: it builds Rust and runs `systemctl`
  (Linux). `rebuild.sh` builds frontend + Rust only and does not restart anything.
  There is no `macos/` directory; the macOS app is `desktop/tauri` (Tauri).

## How the macOS app hosts the server (from `desktop/tauri/src-tauri/src/main.rs`)

- Spawns the Rust `terminal-v4-api` binary (checkout `rust/target/...` or the bundled
  resource), with `HOST` from share mode, `PORT=3030`, `TERMINAL_DATA_DIR` set to
  `~/Library/Application Support/terminal-v4` unless overridden, and
  `TERMINAL_V4_LOCAL_TESTING=1` unless share mode is `lan`. It refuses to start if the
  port is taken (`assert_backend_port_available`).
- Frontend: uses `<checkout>/frontend/dist` if present, else the bundled copy.
- Tailscale gateway: runs `scripts/tailscale-local-proxy.mjs` on `127.0.0.1:3040`, only
  if `tailscale status/serve status --json` show Serve forwarding to 3040; it needs a
  bundled/system Node. App quit kills both children.
- Consequence: the app (3030 + 3040) and the Node server on 3020 are independent and
  can run at once, on different data dirs. That is fine; running two servers on the SAME
  data dir is not (see below).

## Rules

1. Never run an old and a new worker/server against the same data directory at once.
   The Rust task worker records `workspace-tasks/worker-protocol.json`
   (`{"protocol":N}`, currently `WORKER_PROTOCOL = 1` in `rust/crates/api/src/workspace_tasks.rs`).
   A newer marker makes an older binary refuse to start; an unreadable marker makes
   startup refuse. Treat that refusal as correct behaviour, never delete the marker to
   get around it.
2. Stop the old process fully before the new one starts. Ports alone do not protect
   the data dir (Node 3020 and Rust 3030 can open the same files).
3. Backend and frontend ship as a pair: build both from the same commit, record it.
4. Do not edit the preview-system files without explicit permission (CLAUDE.md).

## Procedure

Run from the checkout. Replace `$DATA` with the data dir the target server really uses
(Node: `/Users/conordart/terminal-v4/data` for the current process; Rust/app:
`~/Library/Application Support/terminal-v4` or `$TERMINAL_DATA_DIR`).

### 0. Verify current state

```bash
git rev-parse HEAD; git branch --show-current; git status --short
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3020|3030|3040|8080)\b'
lsof -p <PID> -a -d cwd -Fn; ps -o pid,lstart,command -p <PID>
curl -s http://127.0.0.1:3020/ | grep -oE 'assets/[^"]+' | sort > /tmp/served-assets.txt
grep -oE 'assets/[^"]+' frontend/dist/index.html | sort | diff - /tmp/served-assets.txt
curl -s http://127.0.0.1:3020/api/health
```

### 1. Build the new version without touching the served one

Build in a separate worktree/copy so the live `dist/` is untouched until cutover.

```bash
# Node backend: legacy-peer-deps is required (the npm resolver crashes on the canvas peer)
cd backend && npm install --legacy-peer-deps && npm run build
cd ../frontend && npm install --legacy-peer-deps && npm run build   # if the same resolver error appears
# Rust (app / gateway-backed server): needs a recent toolchain; 1.99.1 works,
# roughly >=1.95 is needed (atomic_try_update)
RUSTUP_TOOLCHAIN=1.99.1 cargo build --release -p terminal-v4-api --manifest-path rust/Cargo.toml
```

Record the commit and the new `index-*.js` / `*.css` hashes. Run the tests for the
parts changed (see TESTING_GUIDE.md) before cutover; a build that was not tested is
not a tested build.

### 2. Back up user data (server stopped, or at least quiescent)

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
# Stop first (step 3) for a consistent SQLite copy; otherwise use sqlite3 .backup
cp -Rp "$DATA" "$HOME/terminal-v4-backup-$STAMP"
ls -la "$HOME/terminal-v4-backup-$STAMP"
cat "$DATA/workspace-tasks/worker-protocol.json" 2>/dev/null   # note protocol marker
```

Also keep the old `backend/dist`, `frontend/dist` and (for Rust) the old
`terminal-v4-api` binary: `cp -Rp frontend/dist frontend/dist.prev-$STAMP`, etc.
Back up `vault-encryption.key` (or keep `VAULT_ENCRYPTION_KEY`) with the data, or stored
secrets become unreadable. Keep the same `JWT_SECRET`/env so sessions survive.

### 3. Stop old, then start new

```bash
kill <PID of node dist/index.js>   # SIGTERM, wait until the port is free
lsof -nP -iTCP:3020 -sTCP:LISTEN   # must print nothing
```
Quit the Tauri app too if it shares `$DATA`. Only then swap in the new `dist/`
(or point `TERMINAL_V4_FRONTEND_DIR` at it) and start the new server with the same env
and `$DATA`. Prefer binding loopback only and exposing it through the Tailscale
gateway (3040, SETUP.md) rather than `0.0.0.0`.

### 4. Health check

```bash
curl -fsS http://127.0.0.1:<port>/api/health
curl -s http://127.0.0.1:<port>/ | grep -oE 'assets/[^"]+'     # expect the new hashes
curl -fsS http://100.71.88.107:<port>/api/health               # only if Tailscale exposure is intended
cat "$DATA/workspace-tasks/worker-protocol.json"
```
Then sign in, open an existing session/notes and confirm prior data is present.

### 5. Rollback

1. Stop the new server (confirm port free).
2. If the protocol marker was raised by the new version, the old binary will refuse
   to start. Restore the whole backup: `mv "$DATA" "$DATA.failed-$STAMP" && cp -Rp
   "$HOME/terminal-v4-backup-$STAMP" "$DATA"` (this loses writes made since the backup).
3. Restore the previous `dist/` directories and binary, start the old server, repeat step 4.

## Not verifiable from this machine / by this check

- Whether the served `frontend/dist` and `backend/dist` correspond to master, the branch
  HEAD, or the dirty working tree (no build provenance recorded; only hashes compared
  with on-disk `dist/`).
- `tailscale` CLI is not on PATH here: Serve/Funnel config, tailnet ACLs, who else can
  reach 100.71.88.107:3020, and whether `https://<device>.ts.net` is configured were not
  checked. The health curl only proves the Node server answers on that address locally.
- Whether the 3020 server enforces auth on all non-health routes over Tailscale
  (not exercised; only `/api/health` was requested).
- Which data dir clients rely on in practice (`repo/data` vs `~/Library/Application
  Support/terminal-v4`), and whether the app's stores should be migrated.
- Behaviour of the Tauri app, gateway and Rust worker under the new build (not launched).
- Rust and frontend test results for the dirty tree; the macOS app bundle was not built.
- How the Node process is supervised/restarted on reboot (no launchd job inspected).
