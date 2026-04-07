# Rust Rewrite Bootstrap

## Goal

Start the Rust rewrite without breaking the current desktop or web app.

## Current Baseline

- The live product still runs on the TypeScript/Fastify backend.
- The Rust rewrite starts in a parallel workspace under `rust/`.
- The current migrated slice covers:
  - `/api/health`
  - `/api/auth/login`
  - `/api/auth/refresh`
  - `/api/auth/me`
  - `/api/auth/logout`
  - `/api/terminal`
  - `POST /api/terminal`
  - `PATCH /api/terminal/:id`
  - `DELETE /api/terminal/:id`
  - `POST /api/terminal/:id/restore`
  - `POST /api/terminal/:id/input`
  - `POST /api/terminal/:id/resize`
  - `GET /api/terminal/:id/ws`
  - `/api/terminal/:id/history`
  - `/api/terminal/:id/turns`
  - `/api/terminal/:id/git-branches`
  - `/api/terminal/:id/generate-topic`
  - `/api/terminal/:id/thread`
  - `/api/terminal/:id/detect-project`
  - `/api/structured/sessions`
  - `/api/structured/sessions/:id`
  - `/api/structured/sessions/:id/message`
  - `/api/structured/sessions/:id/approve`
  - `/api/structured/sessions/:id/interrupt`
  - `/api/structured/sessions/:id/ws`
  - `/api/state`
  - `/api/projects/scan`
  - `/api/projects/scan-dirs`
  - `/api/system/preview-config`
  - `/api/preview/active-ports`
  - `/api/fs/list`
  - `/api/settings`
  - `/api/bookmarks`
  - `/api/notes`
  - external Postgres user lookup for login and refresh fallback

## Workspace Layout

```text
rust/
|-- Cargo.toml
`-- crates/
    |-- api/
    `-- core/
```

## Completed Milestones

1. Create a standalone Cargo workspace.
2. Introduce shared config/domain types in `terminal-v4-core`.
3. Stand up an Axum API in `terminal-v4-api`.
4. Match the existing health endpoint contract.
5. Add Rust tests and keep the current Node app untouched.
6. Add JWT auth middleware and an authenticated user context.
7. Port settings persistence on SQLite.
8. Port bookmark and note persistence on per-user JSON files.
9. Port local SQLite-backed login and refresh-token rotation.
10. Port the external Neon/Postgres auth bridge for username/email login and refresh-token fallback.
11. Port the first terminal read model: persisted-session listing via `GET /api/terminal`.
12. Port persisted-session history snapshots via `GET /api/terminal/:id/history`, including sequence assignment and history window filters.
13. Port a PTY-backed live terminal manager that supports create, restore, input, resize bookkeeping, delete, WebSocket output streaming, and Windows `cmd.exe` startup query handling.
14. Port enough boot-time compatibility routes for the existing frontend to load against Rust for a basic terminal flow (`/api/state`, thread metadata, project scan, preview config, session rename, folder browsing, and terminal detail helpers).
15. Verify the existing Vite frontend can log in against Rust, open the folder browser, create a terminal, and reach the terminal surface without backend console errors.
16. Port the first structured-session backend slice: file-backed session persistence plus `create/list/get/delete/message/approve/interrupt/ws` parity, and update the frontend structured WebSocket hook to pass the bearer token as a query param.
17. Surface Rust structured sessions through the existing app shell by merging them into the shared session inventory, routing AI new-tab creation to `/api/structured/sessions`, and skipping terminal-only git-branch lookups for `ss-*` tabs.
18. Persist structured `ss-*` titles and sidebar thread metadata through the Rust rename/thread routes so create, rename, topic, pin, archive, and project-path state round-trip through the backend instead of frontend-local fallback only.
19. Normalize loopback browser API routing through the current page origin so the Vite frontend can proxy Rust API traffic reliably during local verification even if `VITE_API_URL` still points at an older loopback port.
20. Add browser-level Playwright coverage for the Rust structured-session flow, including create, rename, pin, and reload persistence against the live Rust backend.

## Next Milestones

1. Extend the PTY-backed terminal manager toward full Node parity, including tmux/session survival semantics, richer resize ownership rules, and broader platform-specific shell behavior.
2. Keep hardening sidebar/thread behavior and structured-session desktop polish for `ss-*` tabs, especially around connection recovery and browser-console warning cleanup.
3. Port preview/proxy, file, process, vault, passkey, and voice services.
4. Switch Tauri from spawning Node to using the Rust backend.

## Guardrails

- Keep the frontend contract stable while the backend migrates.
- Prefer parity over redesign in early phases.
- Do not couple the rewrite to a frontend rewrite.
- Keep production startup on Node until a full feature slice is proven.
- Prefer using the existing `backend/data` directory as the Rust default so local testing exercises the same persisted data as the current app.
