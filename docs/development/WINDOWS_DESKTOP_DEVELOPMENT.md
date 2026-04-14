# Windows Desktop Development

This guide covers the Phase 1 Windows desktop wrapper for Terminal v4.

## Scope (Phase 1)

- Native Tauri window for Terminal v4
- Backend process lifecycle managed by desktop app
- Local-only binding (`127.0.0.1:3020`)
- No LAN sharing toggle yet (planned for Phase 2)
- No installer bundle yet (`bundle.active=false` in Tauri config)

## Prerequisites

- Node.js 18+
- Rust toolchain (`cargo --version`)
- Strawberry Perl on `PATH` for the passkey/OpenSSL Rust build
- WebView2 runtime on Windows

## File Layout

- `desktop/tauri/package.json` - Tauri CLI dependency and scripts
- `desktop/tauri/src-tauri/Cargo.toml` - Rust desktop app crate
- `desktop/tauri/src-tauri/src/main.rs` - Backend process manager + app runtime
- `desktop/tauri/src-tauri/tauri.conf.json` - Desktop window/app config

## Run Desktop App (Dev)

From repo root:

```bash
npm run desktop:dev
```

This command performs:
1. Install desktop wrapper dependencies
2. Stop any stale `terminal_v4_desktop.exe` process so Windows does not lock the binary during rebuild
3. Build frontend (`frontend/dist`)
4. Build the Rust API binary (`rust/target/.../terminal-v4-api.exe`)
5. Launch Tauri app
6. Tauri app starts the Rust backend with desktop-safe env:
   - `HOST=127.0.0.1`
   - `PORT=3020`
   - `TERMINAL_V4_DESKTOP=true`
   - `TERMINAL_V4_SHARE_MODE=off`

## Run Desktop App With LAN Access

From repo root:

```bash
$env:TERMINAL_V4_SHARE_MODE='lan'
npm run desktop:dev
```

LAN mode binds the backend to `0.0.0.0:3020` while the desktop app still health-checks it
through `127.0.0.1`. If `JWT_SECRET` is not set, the launcher generates a non-default
secret automatically so the Rust API can start on a non-loopback host. Set `JWT_SECRET`
yourself if you need sessions to survive restarts.

## Build Desktop Artifacts

From repo root:

```bash
npm run desktop:build
```

Current phase note:
- This validates desktop build flow.
- Installer bundling is intentionally deferred to the next phase.

## Troubleshooting

### `backend/dist/index.js is missing`
Run:

```bash
npm run desktop:predev
```

If the Rust backend still does not build, confirm `perl` is available:

```bash
perl -v
```

### Tauri opens but page is blank
Check:
1. Backend logs for startup errors
2. Port conflicts on `3020`
3. Auth environment variables in `backend/.env`
4. The Rust API binary exists under `rust/target/debug` or `rust/target/release`

### Can't access the app from another device
Check:
1. Start the desktop app with `TERMINAL_V4_SHARE_MODE=lan`
2. Confirm the backend is listening on `0.0.0.0:3020`
3. Use the machine's current LAN IP, not an older address
4. Allow inbound TCP `3020` through Windows Firewall if needed

### `cargo` not found
Install Rust toolchain via [https://rustup.rs](https://rustup.rs)

### `failed to remove ... terminal_v4_desktop.exe` / `Access is denied. (os error 5)`
This means Windows still has the previous desktop executable open. `npm run desktop:dev` now pre-emptively stops stale desktop wrapper processes before rebuilding. If you still hit it, close the desktop window and rerun the command.

## Next Phase

- Add LAN share mode toggle (bind `0.0.0.0` on demand)
- Add sharing status UX (copy URL, warning banner)
- Add Windows bundle/signing pipeline
