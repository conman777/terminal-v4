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
   (`{"protocol":N}`; `WORKER_PROTOCOL` in `rust/crates/api/src/workspace_tasks.rs`,
   currently 2, reported live as `workerProtocol` by `/api/build-info`).
   A newer marker makes an older binary refuse to start; an unreadable marker makes
   startup refuse. Marker rules (identical in WORKER_UPGRADE.md and
   BACKGROUND_PROCESS_LIFECYCLE.md): never delete, rewrite or edit a marker to get
   around a refusal; a downgrade means restoring the data directory backup taken
   before the newer build first started, and nothing else.
2. Stop the old process fully before the new one starts. Ports alone do not protect
   the data dir (Node 3020 and Rust 3030 can open the same files).
3. Backend and frontend ship as a pair: build both from the same commit, record it.
4. Do not edit the preview-system files without explicit permission (CLAUDE.md).

## Build identity and verification tools

- `GET /api/build-info` (Rust API, unauthenticated, no paths or user names) returns
  `commit` (12-char git hash embedded by `rust/crates/api/build.rs`, `unknown` if git
  was unavailable; override with `TERMINAL_V4_BUILD_COMMIT`), `dirty` (tracked files
  were modified at build time), `builtAtUnix`, `apiVersion`, `workerProtocol`, and
  `frontend` = `{available, assets, manifestHash}` computed from the `index.html` the
  server is actually serving (`manifestHash` = SHA-256 of the sorted, newline-joined
  `assets/...` names referenced by `index.html`). The legacy Node backend has no such
  route, so verification against it fails by design.
- `scripts/verify-deployment.mjs --url URL [--expect-commit HASH] [--dist frontend/dist] [--allow-dirty]`
  (also `npm run verify:deployment -- ...`) exits 0 only if: build-info is served and
  has a real commit; the commit matches `--expect-commit` (prefix match); the build is
  not dirty (unless allowed); `/` is HTML referencing hashed assets whose manifest hash
  equals build-info's; every referenced asset is really served (not the SPA HTML
  fallback); and with `--dist`, the asset names and bytes equal the local `dist`.
  A bare `200 {"status":"ok"}` from `/api/health` or any 200 at `/` is never accepted.
- The desktop app logs `[tauri] Serving frontend: <dir> (index.html modified ..., main=..)`
  and warns when the checkout `frontend/dist` differs from the bundled one. It still
  prefers the checkout dist; it does not compare against the backend commit (the dist
  carries no commit). Always run verify-deployment against the app's port (3030).

## Procedure

Run from the checkout. Replace `$DATA` with the data dir the target server really uses
(Rust/app: `~/Library/Application Support/terminal-v4` or `$TERMINAL_DATA_DIR`; the
legacy Node process uses `/Users/conordart/terminal-v4/data`). Choose the target
commit once and use it everywhere: `COMMIT=$(git rev-parse --short=12 HEAD)`, with a
clean `git status --short`.

### 0. Record the current state

```bash
git rev-parse HEAD; git branch --show-current; git status --short
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3020|3030|3040|8080)\b'
ps -o pid,lstart,command -p <PID>
curl -s http://127.0.0.1:<port>/api/build-info     # 404 means an old or Node server
cat "$DATA/workspace-tasks/worker-protocol.json" 2>/dev/null
```

### 1. Build frontend and backend from one commit

Only from a clean tree at `$COMMIT` (a dirty tree makes `dirty:true`, which
verification rejects). Build into scratch outputs first so the live `dist/` and
binary are untouched.

```bash
SCRATCH=$(mktemp -d)
npm --prefix frontend ci --legacy-peer-deps
(cd frontend && npx vite build --outDir "$SCRATCH/dist" --emptyOutDir)
RUSTUP_TOOLCHAIN=1.99.1 CARGO_TARGET_DIR="$SCRATCH/target" \
  cargo build --release -p terminal-v4-api --manifest-path rust/Cargo.toml
```

(`rebuild.sh` builds into the checkout's `frontend/dist` and `rust/target`; use it only
at cutover time, from the same clean commit.) Run the focused tests for what changed
(TESTING_GUIDE.md), plus `npm run test:verify-deployment`.

### 2. Scratch-verify on an unused port and a throwaway data dir

Never point this at `$DATA`. Ports 3041+ are suggested.

```bash
HOST=127.0.0.1 PORT=3041 TERMINAL_DATA_DIR="$SCRATCH/data" TERMINAL_V4_FRONTEND_DIR="$SCRATCH/dist" \
  "$SCRATCH/target/release/terminal-v4-api" & NEW_PID=$!
sleep 3
node scripts/verify-deployment.mjs --url http://127.0.0.1:3041 --expect-commit "$COMMIT" --dist "$SCRATCH/dist"
kill $NEW_PID
```

Do not continue unless it prints `OK`.

### 3. Stop the old server

```bash
kill <old PID>                                  # SIGTERM; quit the Tauri app if it shares $DATA
lsof -nP -iTCP:<port> -sTCP:LISTEN              # must print nothing
```

### 4. Back up the data dir (nothing is writing to it now)

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
cp -Rp "$DATA" "$HOME/terminal-v4-backup-$STAMP"
cat "$DATA/workspace-tasks/worker-protocol.json" 2>/dev/null
cp -Rp frontend/dist "$HOME/terminal-v4-dist-prev-$STAMP"   # and the old binary / backend/dist
```

Keep `vault-encryption.key` (or `VAULT_ENCRYPTION_KEY`) and `JWT_SECRET` the same, or
stored secrets and sessions are lost. This backup is the only valid downgrade path.

### 5. Install and start the new build

Install the verified `dist` and binary (`rsync -a --delete "$SCRATCH/dist/" frontend/dist/`;
copy the binary or run `rebuild.sh` from the same clean commit) and start the new
server with the same env and `$DATA`, bound to loopback with the Tailscale gateway in
front (SETUP.md), not `0.0.0.0`.

### 6. Verify the live server

```bash
node scripts/verify-deployment.mjs --url http://127.0.0.1:<port> --expect-commit "$COMMIT" --dist frontend/dist
node scripts/verify-deployment.mjs --url http://<tailscale-address-or-name>:<port> --expect-commit "$COMMIT" --dist frontend/dist   # only if exposed
```
Then sign in and confirm prior sessions and notes are present. A failure here means
roll back; do not "fix forward" on the live data dir.

### 7. Rollback

1. Stop the new server (confirm the port is free).
2. Restore the data dir: `mv "$DATA" "$DATA.failed-$STAMP" && cp -Rp "$HOME/terminal-v4-backup-$STAMP" "$DATA"`
   (loses writes since the backup). Do this whenever the new build ran against `$DATA`,
   because it may have advanced the protocol marker; never delete the marker instead.
3. Restore the previous `dist/` and binary, start the old server, and verify it
   (`verify-deployment` if the old build has build-info, otherwise the recorded asset
   hashes from step 0).

## What a human must do on the live Tailscale machine

This tooling cannot do these and they were not done:

1. Decide the cutover: the machine currently serves the legacy Node server on 3020 over
   `0.0.0.0`. Moving to the Rust API behind the gateway is a deliberate change.
2. Build from a clean checkout of the chosen commit and run steps 1-2 there.
3. Stop the old server and the Tauri app, take the data backup (step 4), start the new
   server, and run step 6 against both loopback and the Tailscale name/address.
4. Check with `tailscale serve status` / `tailscale status` what is exposed and which
   ACLs apply; confirm non-health routes demand authentication from a tailnet peer.
5. Set `E2E_UI_UNIFICATION=1 BASE_URL=<explicit local-testing URL>` only for the UI
   spec, against a local-testing instance, never a live account.
6. Keep the backup until the new build has run a normal period; delete it only then.

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
