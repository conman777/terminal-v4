# Testing Guide

This document describes how to run and extend the project’s automated tests.

## Test Matrix Overview

| Scope | Location | Command | Notes |
| --- | --- | --- | --- |
| Backend unit/integration | `backend/` | `npm test` | Vitest + Supertest |
| Backend type checks/build | `backend/` | `npm run build` | `tsup` compile (type errors fail) |
| Rust API unit/integration | `rust/` | `cargo test` | Axum route/store tests |
| Rust API formatting | `rust/` | `cargo fmt --all --check` | Required before commits |
| Frontend unit tests | `frontend/` | `npm test` | Vitest + React Testing Library |
| E2E (legacy) | project root | `npm run test:e2e` | Runs Playwright tests in `tests/` |
| E2E (frontend) | `frontend/` | `npx playwright test` | Uses `frontend/playwright.config.ts` |

## Backend Testing

```bash
cd backend
npm test
npm run build
```

Guidelines:
- Use `createServer({ logger: false })` for Fastify tests.
- Prefer Supertest for HTTP assertions.
- Mock external processes (Claude CLI, browser automation) in unit tests.

## Rust API Testing

```bash
cd rust
cargo fmt --all --check
cargo test
```

Guidelines:
- Keep route coverage in `rust/crates/api/src/lib.rs` tests unless a helper is reusable enough to justify a colocated module test.
- Prefer spawning the Axum router and exercising authenticated HTTP/WebSocket flows over mocking internals.
- On Windows, install Strawberry Perl and ensure `C:\Strawberry\perl\bin` is on `PATH` before running Cargo commands that build the passkey/OpenSSL stack.

## E2E Testing

### Legacy suite (root)
```bash
npm run test:e2e
```
- Runs Playwright tests in `tests/`.
- Targets the older UI flow (treat as legacy coverage).

### Frontend suite (frontend/e2e)
```bash
cd frontend
npx playwright test
```
- Uses `frontend/playwright.config.ts`.
- Default `baseURL` is `http://localhost:3020` (backend serving built frontend).
- Set `BASE_URL=http://localhost:5173` to point at Vite dev server.

## Troubleshooting

- **Playwright base URL**: Ensure the backend or Vite dev server is running.
- **Auth required**: Seed a user or enable registration locally before E2E runs.
- **Claude CLI availability**: Integration tests should avoid invoking the real CLI unless explicitly configured.
- **Rust OpenSSL build on Windows**: `webauthn-rs` pulls OpenSSL; install Strawberry Perl if Cargo fails with `Command 'perl' not found`.
