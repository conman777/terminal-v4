# Testing Guide

This document describes how to run and extend the project’s automated tests.

## Test Matrix Overview

| Scope | Location | Command | Notes |
| --- | --- | --- | --- |
| Backend unit/integration | `backend/` | `npm test` | Vitest + Supertest |
| Backend type checks/build | `backend/` | `npm run build` | `tsup` compile (type errors fail) |
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
