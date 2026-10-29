# Windows Desktop Development

This guide covers the Phase 1 Windows desktop wrapper for Terminal v4.

## Scope (Phase 1)

- Native Tauri window for Terminal v4
- Backend process lifecycle managed by desktop app
- Local-only binding (`127.0.0.1:3020`)
- No LAN sharing toggle yet (planned for Phase 2)
- Desktop bundles include an app-owned Node and Chromium browser runtime

## Prerequisites

- Node.js 20.19+ or 22.12+ for development/build tooling
- Rust toolchain (`cargo --version`)
- Strawberry Perl on `PATH` for the passkey/OpenSSL Rust build
- WebView2 runtime on Windows

## File Layout

- `desktop/tauri/package.json` - Tauri CLI dependency and scripts
- `desktop/tauri/src-tauri/Cargo.toml` - Rust desktop app crate
- `desktop/tauri/src-tauri/src/main.rs` - Backend process manager + app runtime
- `desktop/tauri/src-tauri/tauri.conf.json` - Desktop window/app and shared resource config
- `desktop/tauri/src-tauri/tauri.windows.conf.json` - Windows API executable resource
- `scripts/prepare-browser-runtime.cjs` - Native browser runtime provisioner
- `.runtime/browser/runtime.json` - Generated, relocatable runtime manifest

## Run Desktop App (Dev)

From repo root:

```bash
npm run desktop:dev
```

This command performs:
1. Install desktop wrapper dependencies and provision the app-owned browser runtime
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

Bundling is enabled. Tauri automatically merges the native platform configuration:
Windows bundles `terminal-v4-api.exe`, while macOS/Linux bundle `terminal-v4-api`.
The shared resource map includes `.runtime/browser/` as `browser-runtime/`, together
with the built frontend and other existing runtime dependencies. The macOS override
currently produces an ad hoc signed `.app`; distribution signing/notarization and
Windows signing remain separate release work.

## App-owned Browser Runtime

`npm run browser:install` provisions `.runtime/browser/`. The application and desktop
build/install hooks run it automatically, including direct Tauri dev/build commands.
The provisioner downloads official Node **22.23.1**, checks its archive against the
official SHA-256 list, and copies or installs **playwright 1.64.1** and
**playwright-core 1.64.1** into this directory. It copies the exact compatible managed
Chromium revision (**1248**, browser **156.0.8078.4**) when available as a build input;
otherwise its staged Node runs `playwright install chromium --no-shell` with the
download path fixed inside the staging directory. See the upstream
[Playwright browser installation guide](https://playwright.dev/docs/browsers) and
[official Node release files](https://nodejs.org/dist/v22.23.1/).

Provisioning validates the new runtime, launches its explicit Chromium executable,
and exercises page input, clicking, and screenshots before publishing the directory.
An existing valid runtime is reused. Run `npm run browser:verify` to repeat the live
smoke check with an empty `PATH` and a temporary home directory. Run
`npm run test:browser-runtime` for the network-free provisioner regression tests.

The Rust browser resolver selects, in order:

1. `TERMINAL_V4_BROWSER_RUNTIME_DIR`, if explicitly set (invalid or empty values fail).
2. `<TERMINAL_V4_RUNTIME_ROOT>/browser-runtime` for packaged resources.
3. `browser-runtime` beside the running API executable.
4. The checkout's `.runtime/browser` during development.

Manifest platform/architecture, exact package versions, engine revision, contained
relative paths, and executable files must match. Runtime resolution never searches
installed Chrome, `PATH`, or the user's shared Playwright cache. Desktop startup sets
the selected browser root and `PLAYWRIGHT_NODE_BIN` and prepends the owned Node
directory to its child process's `PATH`. Installed users do not need host Node or
Chrome for the workspace browser. The Tauri window still uses the operating system
webview (WebView2 on Windows); this is separate from the workspace Chromium engine.

Build on the target OS and architecture. Supported native provisioning pairs are
macOS arm64/x64, Linux arm64/x64, and Windows x64. Windows arm64 and cross-compilation
are unsupported; do not distribute a bundle containing another platform's runtime.
Linux still needs Chromium's OS shared libraries; use Playwright's documented system
dependency setup on the build/test host. Network access is needed to provision Node
and any missing npm/browser packages; installed runtime startup is offline.

The current live smoke verification was performed on macOS arm64. Windows/Linux
installer execution, OS dependency coverage, distribution signing/notarization, and
a clean-machine install remain release verification requirements.

## Troubleshooting

### App-owned browser runtime is missing or incomplete

Run `npm run browser:install`, then `npm run browser:verify`. For an installed app,
reinstall a complete native bundle containing `browser-runtime/`. An invalid
`TERMINAL_V4_BROWSER_RUNTIME_DIR` override fails instead of using another browser.

### Frontend build is missing
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
- Validate Windows installers on a clean machine and add distribution signing
