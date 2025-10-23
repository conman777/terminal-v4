# Testing Guide

This document describes how to run and extend the project’s automated tests. All contributors must ensure tests pass before submitting changes.

## Test Matrix Overview

| Scope | Location | Command | Notes |
| --- | --- | --- | --- |
| Backend unit/integration | `backend/` | `npm test` | Vitest + Supertest with Fastify instance |
| Backend watch mode | `backend/` | `npm run test:watch` | Continuous feedback during development |
| Backend type checks | `backend/` | `npm run build` | `tsup` compiles TypeScript; fails on type errors |
| Frontend tests (TBD) | `frontend/` | _Not yet implemented_ | Use Vitest/React Testing Library (planned) |
| E2E (legacy) | project root | `npm test` | Playwright suite targeting previous UI flow |

## Backend Testing Details

### Vitest

The Fastify server and supporting modules are covered by Vitest. Tests live under `backend/test/`. Common patterns:

- Use `createServer({ logger: false })` for a lightweight Fastify instance.
- Inject a stubbed session store or Claude service when necessary.
- Supertest is available for HTTP assertions without binding to a real port.

Example:

```ts
import { createServer } from '../src/index';
import supertest from 'supertest';

it('responds to health checks', async () => {
  const app = await createServer({ logger: false });
  await supertest(app.server).get('/api/health').expect(200);
});
```

### CLI Adapter Tests

`backend/src/claude/cli.ts` accepts a `spawnImpl` override to make unit testing deterministic. In Vitest use:

```ts
const spawnMock = vi.fn().mockReturnValue(fakeProcess);
spawnClaudeProcess({ message: 'ping', spawnImpl: spawnMock });
```

### Session Store Tests

The in-memory store mirrors expected persistence semantics. Expand coverage as new behaviours arrive (e.g., deletion, pagination).

## Adding Tests

1. Co-locate tests with the unit under the same package when practical (`backend/test/<module>.test.ts`).
2. Prefer descriptive test names explaining observable behaviour.
3. Use strong assertions (`toEqual`) over weak ones (`toBeDefined`).
4. Mock external processes or network calls; avoid touching the real filesystem unless required.

## Test Data & Fixtures

Create helper utilities under `backend/test/helpers/` when multiple suites share setup logic (not yet needed).

## Continuous Integration

CI should, at minimum, run:

```bash
cd backend
npm install
npm run build
npm test
```

Add frontend lint/unit tasks once implemented.

## Playwright (Legacy)

The root `npm test` command runs the existing Playwright suite. It targets the previous Express/React implementation and may need updates once the new frontend is ready. Treat Playwright output as informative until the refreshed UI lands.

## Troubleshooting

- **ESM import errors**: Ensure tests import `.ts` modules without extensions (Vitest resolves them).
- **Lingering Fastify listeners**: Always close the server in `afterAll` hooks.
- **CLAUDE CLI availability**: Unit tests should not spawn the real CLI; integration tests that require it must guard with environment checks.
