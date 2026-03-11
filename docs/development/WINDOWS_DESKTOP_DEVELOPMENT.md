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
4. Build backend (`backend/dist`)
5. Launch Tauri app
6. Tauri app starts backend with desktop-safe env:
   - `HOST=127.0.0.1`
   - `PORT=3020`
   - `TERMINAL_V4_DESKTOP=true`
   - `TERMINAL_V4_SHARE_MODE=off`

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

### Tauri opens but page is blank
Check:
1. Backend logs for startup errors
2. Port conflicts on `3020`
3. Auth environment variables in `backend/.env`

### `cargo` not found
Install Rust toolchain via [https://rustup.rs](https://rustup.rs)

### `failed to remove ... terminal_v4_desktop.exe` / `Access is denied. (os error 5)`
This means Windows still has the previous desktop executable open. `npm run desktop:dev` now pre-emptively stops stale desktop wrapper processes before rebuilding. If you still hit it, close the desktop window and rerun the command.

## Next Phase

- Add LAN share mode toggle (bind `0.0.0.0` on demand)
- Add sharing status UX (copy URL, warning banner)
- Add Windows bundle/signing pipeline
