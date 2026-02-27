# Terminal Reliability & Security Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three confirmed reliability/security problems in the terminal: token leakage in WebSocket URLs, server hard-disconnecting slow clients, and excessively long session-restore retry delays.

**Architecture:** The backend is a Fastify server (`backend/src/`) in TypeScript with vitest for tests. The frontend is React+Vite (`frontend/src/`) with vitest+jsdom. The WebSocket auth token is currently passed as a URL query param; we'll move it to the first message after open. The slow-client close will become a skip-and-continue instead of terminate. The restore backoff cap will drop from 5 minutes to 30 seconds.

**Tech Stack:** TypeScript (backend), React/JSX (frontend), Fastify WebSocket, vitest, supertest

---

## Background: What Is Broken and Why

### Bug 1 — Auth token in WebSocket URL (`TerminalChat.jsx:1725`)

```js
// CURRENT (bad):
const url = new URL(`/api/terminal/${sessionId}/ws`, base);
if (token) url.searchParams.set('token', token);
```

WebSocket connections cannot send custom HTTP headers from the browser, so the token is appended as `?token=<jwt>`. This means:
- The JWT appears in server access logs
- It appears in the browser's navigation history if the URL is ever exposed
- It can leak in `Referer` headers to third-party scripts

**Fix:** After the socket opens, send the token as the very first message (`{ type: 'auth', token }`). The backend reads it, validates it, then proceeds normally. If auth fails, close with 4401.

### Bug 2 — Backend terminates slow clients (`terminal-routes.ts:412-413`)

```ts
// CURRENT (bad):
if (socket.bufferedAmount > TERMINAL_WS_MAX_BUFFERED_BYTES) {
  socket.close(1013, 'Client is too slow to receive terminal output');
  return false;
}
```

When `bufferedAmount` (data queued in the OS send buffer for this socket) exceeds 1 MB, the server kills the connection. The client sees an `onclose`, prints "[Connection lost]", waits up to 30s, reconnects, downloads history again — and if it is still slow, gets killed again. This is a reconnect loop for mobile/slow-network users.

**Fix:** When the buffer is full, **skip this send** but **keep the connection open**. Set `parserRecoveryNeeded` on the next successful send (via a flag on the socket object) so the client knows to resync. The client already handles incremental resync (`scheduleIncrementalResync`) — we just need to stop triggering a full disconnect.

### Bug 3 — Session restore retry delay grows to 5 minutes (`TerminalChat.jsx:2152,2160`)

```js
// CURRENT (bad):
restoreRetryDelay = Math.min(restoreRetryDelay * 2, 300000); // caps at 5 minutes!
```

After a session restore fails, the client doubles its wait time on each attempt: 5s → 10s → 20s → 40s → 80s → 160s → 300s. A user staring at a broken terminal for up to 5 minutes is a terrible experience.

**Fix:** Cap the max restore retry delay at 30s (same as normal WS reconnect max).

---

## Task 1: Fix — Auth Token in WebSocket URL

**Files:**
- Modify: `frontend/src/components/TerminalChat.jsx:1721-1730` (buildSocketUrl)
- Modify: `frontend/src/components/TerminalChat.jsx:1841-1882` (socket.onopen handler)
- Modify: `backend/src/routes/terminal-routes.ts:350-585` (WS handler)
- Test: `backend/test/terminal-ws-auth.test.ts` (new file)

### Step 1: Understand the current auth flow on the backend

Read `backend/src/routes/terminal-routes.ts` lines 350–395 to see how `token` is currently read from the query string and validated before the WebSocket upgrade. The auth hook at `backend/src/auth/auth-hook.ts` validates `request.query.token` for WS connections.

Also read `backend/src/auth/auth-hook.ts` to understand the full token validation logic. You need to understand this before changing it.

### Step 2: Write a failing test for post-open auth

Create `backend/test/terminal-ws-auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/index';
import WebSocket from 'ws';

describe('WebSocket post-open auth', () => {
  let server: Awaited<ReturnType<typeof createServer>>;
  let port: number;

  beforeAll(async () => {
    server = await createServer({ logger: false });
    const address = await server.listen({ port: 0 });
    port = (server.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await server.close();
  });

  it('closes with 4401 when no auth message is sent within timeout', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/terminal/test-session/ws`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('No close event received within 3s'));
      }, 3000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        try {
          expect(code).toBe(4401);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});
```

Run it: `cd /home/conor/terminal-v4/backend && npm test -- --reporter=verbose test/terminal-ws-auth.test.ts`

Expected: FAIL — the server currently closes with a different code or accepts without auth.

### Step 3: Add post-open auth to the backend WS handler

In `backend/src/routes/terminal-routes.ts`, find the WebSocket route handler (starts around line 360). Currently it reads `token` from `request.query.token`.

The change: remove token from query-based auth for WS connections and instead expect a first message `{ type: 'auth', token: string }` within 5 seconds.

Here is the pattern to implement (insert after the existing `socket.on('message', ...)` setup):

```ts
// At top of WS handler, before subscribing to terminal output:
const AUTH_TIMEOUT_MS = 5000;
let authenticated = false;

const authTimeout = setTimeout(() => {
  if (!authenticated) {
    socket.close(4401, 'Authentication timeout');
  }
}, AUTH_TIMEOUT_MS);

// Replace the existing message handler with a two-phase one:
socket.on('message', async (raw) => {
  const text = raw instanceof Buffer ? raw.toString() : String(raw);

  // Phase 1: waiting for auth message
  if (!authenticated) {
    try {
      const msg = JSON.parse(text);
      if (msg?.type !== 'auth' || typeof msg.token !== 'string') {
        socket.close(4401, 'Expected auth message');
        return;
      }
      // Validate token using the same logic as auth-hook.ts
      const userId = await validateToken(msg.token); // extract this helper
      if (!userId) {
        socket.close(4401, 'Invalid token');
        return;
      }
      clearTimeout(authTimeout);
      authenticated = true;
      // proceed: subscribe to terminal output, etc.
      setupTerminalSession(userId);
    } catch {
      socket.close(4401, 'Invalid auth message');
    }
    return;
  }

  // Phase 2: normal terminal input processing
  handleTerminalInput(text);
});
```

**Important:** You will need to refactor the existing handler so that "subscribe to terminal, send history, etc." is extracted into a `setupTerminalSession(userId)` function called after auth.

Look at the existing auth-hook to understand `validateToken`. The existing hook reads `request.query.token` or `request.headers.authorization`. Extract the token validation into a reusable function in a new file `backend/src/auth/validate-token.ts`.

### Step 4: Update the frontend to not put token in URL

In `TerminalChat.jsx`, find `buildSocketUrl` (line ~1721):

```js
// BEFORE:
const buildSocketUrl = () => {
  const token = getAccessToken();
  const base = import.meta.env.VITE_API_URL || window.location.origin;
  const url = new URL(`/api/terminal/${sessionId}/ws`, base);
  if (token) url.searchParams.set('token', token);   // REMOVE THIS LINE
  url.searchParams.set('history', '0');
  if (USE_FRAMED_PROTOCOL) url.searchParams.set('framed', '1');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

// AFTER:
const buildSocketUrl = () => {
  const base = import.meta.env.VITE_API_URL || window.location.origin;
  const url = new URL(`/api/terminal/${sessionId}/ws`, base);
  url.searchParams.set('history', '0');
  if (USE_FRAMED_PROTOCOL) url.searchParams.set('framed', '1');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
```

Then in `socket.onopen` (line ~1841), send the auth message as the very first thing, before requesting history or anything else:

```js
socket.onopen = () => {
  if (disposed) return;
  didOpen = true;
  // ... existing setup ...

  // Send auth token as first message — must arrive before any other message
  const token = getAccessToken();
  if (token) {
    socket.send(JSON.stringify({ type: 'auth', token }));
  }

  // ... rest of existing onopen code ...
};
```

### Step 5: Run the test — verify it passes

```
cd /home/conor/terminal-v4/backend && npm test -- --reporter=verbose test/terminal-ws-auth.test.ts
```

Expected: PASS

### Step 6: Run the full backend test suite

```
cd /home/conor/terminal-v4/backend && npm test
```

Expected: all passing

### Step 7: Commit

```bash
cd /home/conor/terminal-v4
git add backend/src/routes/terminal-routes.ts \
        backend/src/auth/validate-token.ts \
        backend/test/terminal-ws-auth.test.ts \
        frontend/src/components/TerminalChat.jsx
git commit -m "fix(auth): move WebSocket token from URL query param to first message"
```

---

## Task 2: Fix — Slow Client Hard Disconnect

**Files:**
- Modify: `backend/src/routes/terminal-routes.ts:408-416` (`canSend` function)

### Step 1: Understand canSend

Read `backend/src/routes/terminal-routes.ts` lines 408–450. The `canSend()` function is called before every `socket.send()`. When `bufferedAmount` exceeds the limit, it currently closes the socket.

The `bufferedAmount` is the number of bytes queued in Node.js/OS for this socket but not yet sent to the client. If it's high, the client is slow but still connected.

### Step 2: Write a test for slow-client behavior

Add a test to `backend/test/server.test.ts` or a new `backend/test/terminal-ws-slowclient.test.ts`:

```ts
it('does not terminate slow clients — canSend returns false but keeps socket open', () => {
  // We can't easily test bufferedAmount in unit tests (it's a live socket property),
  // so we test the logic by creating a mock socket with high bufferedAmount.
  const mockSocket = {
    readyState: 1, // OPEN
    bufferedAmount: 2_000_000, // above 1MB threshold
    closeCode: null as number | null,
    close(code: number) { this.closeCode = code; },
    send() {}
  };

  // Extract canSend logic into a pure testable function:
  // canSend(socket) => boolean (no side effects)
  const canSendPure = (socket: typeof mockSocket): boolean => {
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount > 1_000_000) return false; // skip, don't close
    return true;
  };

  const result = canSendPure(mockSocket);
  expect(result).toBe(false);
  expect(mockSocket.closeCode).toBeNull(); // socket NOT closed
});
```

Run: `cd /home/conor/terminal-v4/backend && npm test -- --reporter=verbose`
Expected: FAIL (because `canSend` currently closes the socket)

### Step 3: Change canSend to skip-not-close

In `backend/src/routes/terminal-routes.ts`, change lines 412-414:

```ts
// BEFORE:
if (socket.bufferedAmount > TERMINAL_WS_MAX_BUFFERED_BYTES) {
  socket.close(1013, 'Client is too slow to receive terminal output');
  return false;
}

// AFTER:
if (socket.bufferedAmount > TERMINAL_WS_MAX_BUFFERED_BYTES) {
  // Client is slow — skip this send but keep the connection alive.
  // The frontend's incremental resync will catch up any missed output.
  slowClientSkipCount++;
  return false;
}
```

Also add `let slowClientSkipCount = 0;` near the top of the WS handler, and log a warning if it exceeds 100 skips:

```ts
if (slowClientSkipCount > 0 && slowClientSkipCount % 100 === 0) {
  console.warn(`WS client slow: skipped ${slowClientSkipCount} sends for session ${request.params.id}`);
}
```

### Step 4: Run tests

```
cd /home/conor/terminal-v4/backend && npm test
```

Expected: all passing

### Step 5: Manual smoke test

Build and start the server, open the terminal in a browser with devtools network throttling set to "Slow 3G". Start a command that produces lots of output (e.g., `cat /dev/urandom | head -c 1M | base64`). Verify the terminal **does not disconnect**. It may show a resync notice but should stay connected.

### Step 6: Commit

```bash
cd /home/conor/terminal-v4
git add backend/src/routes/terminal-routes.ts \
        backend/test/terminal-ws-slowclient.test.ts
git commit -m "fix(terminal): skip sends to slow clients instead of terminating connection"
```

---

## Task 3: Fix — Session Restore Retry Cap

**Files:**
- Modify: `frontend/src/components/TerminalChat.jsx:2152,2160,2169,2215` (all lines with `300000` in retry context)

This is a small, targeted change. There are four occurrences where `restoreRetryDelay` is capped at `300000` (5 minutes). All should change to `30000` (30 seconds).

### Step 1: Find all occurrences

```bash
grep -n "300000" /home/conor/terminal-v4/frontend/src/components/TerminalChat.jsx
```

You should see ~4 lines.

### Step 2: Write a test (logic-level)

There is no existing unit test for reconnect delay logic in the frontend. The reconnect code is deeply embedded in `connectSocket()` which is hard to unit test without extracting it. Since this is a one-line constant change with high confidence, skip the unit test and rely on the manual smoke test.

**Rationale:** The reconnect logic is not extracted into a testable pure function. Writing a test for it would require significant refactoring (see Task 5 below). For now, the change is simple enough to verify manually.

### Step 3: Change the cap

In `TerminalChat.jsx`, change every occurrence of:
```js
restoreRetryDelay = Math.min(restoreRetryDelay * 2, 300000);
```
to:
```js
restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
```

There are approximately 4 occurrences. Change all of them.

### Step 4: Verify no other high caps exist

```bash
grep -n "MAX_WS_RETRY_DELAY\|restoreRetryDelay\|300000\|60000" \
  /home/conor/terminal-v4/frontend/src/components/TerminalChat.jsx
```

Verify that `MAX_WS_RETRY_DELAY` is still 30000 (it is at line 1767 — don't change it) and only the `restoreRetryDelay` cap was changed.

### Step 5: Run frontend tests

```
cd /home/conor/terminal-v4/frontend && npm test
```

Expected: all passing (these tests don't cover reconnect delay)

### Step 6: Manual smoke test

In the browser:
1. Open a terminal session
2. Kill the backend process (or kill the tmux session manually)
3. Watch the reconnect messages: should see "retrying in 5s", "retrying in 10s", "retrying in 20s", "retrying in 30s" — and it should **not** go above 30s

### Step 7: Commit

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/TerminalChat.jsx
git commit -m "fix(terminal): cap session restore retry delay at 30s instead of 5 minutes"
```

---

## Task 4: Fix — Desktop History Page Size Too Large

**Files:**
- Modify: `frontend/src/components/TerminalChat.jsx:99-100` (constants)

### Background

`HISTORY_PAGE_CHARS_DESKTOP = 5_000_000` means the initial history load fetches up to 5 million characters as a single JSON response. Even though writing to xterm is chunked via `requestAnimationFrame` (good), the **JSON.parse** of a 5MB payload still blocks the main thread for ~50-200ms on a typical machine.

For most sessions, recent history fits in 200-500KB. Reducing the initial fetch to 1MB (still generous) cuts both network transfer and parse time while keeping the session state visible.

### Step 1: Find the constants

```bash
grep -n "HISTORY_PAGE_CHARS_DESKTOP\|HISTORY_PAGE_EVENTS_DESKTOP" \
  /home/conor/terminal-v4/frontend/src/components/TerminalChat.jsx | head -5
```

### Step 2: Change the desktop page size

In `TerminalChat.jsx` lines 99-100, change:

```js
// BEFORE:
const HISTORY_PAGE_EVENTS_DESKTOP = 10000;
const HISTORY_PAGE_CHARS_DESKTOP = 5_000_000;

// AFTER:
const HISTORY_PAGE_EVENTS_DESKTOP = 5000;
const HISTORY_PAGE_CHARS_DESKTOP = 1_000_000;
```

The scroll-to-top "load more" is already implemented — older history loads on demand when the user scrolls up. Reducing the initial page doesn't lose any data.

### Step 3: Verify scroll-to-top still loads more

In `TerminalChat.jsx`, search for `loadMoreHistory` to confirm it's called on scroll-to-top. It should call `fetchHistoryPage({ beforeTs: state.oldestTs })`. This is already working and is not changed.

### Step 4: Run frontend tests

```
cd /home/conor/terminal-v4/frontend && npm test
```

Expected: all passing

### Step 5: Manual smoke test

Open a terminal session that has a long history (e.g., run `yes | head -10000` a few times). Reload the page. Verify:
- History loads quickly (< 1 second)
- Scrolling to the top loads more history correctly
- No content gap visible

### Step 6: Commit

```bash
cd /home/conor/terminal-v4
git add frontend/src/components/TerminalChat.jsx
git commit -m "perf(terminal): reduce initial desktop history fetch from 5MB to 1MB"
```

---

## Task 5: Refactor — Extract Reconnect Delay Logic for Testability (Optional)

> **Note:** This is a refactor to make the reconnect delay testable. It's optional — do it only if you want the retry-delay logic covered by automated tests.

**Files:**
- Create: `frontend/src/utils/reconnectDelay.js`
- Test: `frontend/src/utils/reconnectDelay.test.js`
- Modify: `frontend/src/components/TerminalChat.jsx` (use the extracted function)

### Step 1: Write the failing test

Create `frontend/src/utils/reconnectDelay.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { calcReconnectDelay } from './reconnectDelay';

describe('calcReconnectDelay', () => {
  it('starts at 5000ms', () => {
    expect(calcReconnectDelay(5000)).toEqual({ delay: 5000, next: 10000 });
  });

  it('doubles each attempt', () => {
    expect(calcReconnectDelay(10000).delay).toBe(10000);
    expect(calcReconnectDelay(10000).next).toBe(20000);
  });

  it('caps at 30000ms', () => {
    expect(calcReconnectDelay(30000).delay).toBe(30000);
    expect(calcReconnectDelay(30000).next).toBe(30000);
  });

  it('handles values above cap', () => {
    expect(calcReconnectDelay(60000).delay).toBe(30000);
    expect(calcReconnectDelay(60000).next).toBe(30000);
  });
});
```

Run: `cd /home/conor/terminal-v4/frontend && npm test -- reconnectDelay`
Expected: FAIL (file doesn't exist yet)

### Step 2: Create the utility

Create `frontend/src/utils/reconnectDelay.js`:

```js
const MAX_RESTORE_RETRY_DELAY_MS = 30000;

/**
 * Returns the delay to use for the current retry attempt, and the next delay value.
 * Pass the current restoreRetryDelay state to get the next value.
 */
export function calcReconnectDelay(currentDelay) {
  const delay = Math.min(currentDelay, MAX_RESTORE_RETRY_DELAY_MS);
  const next = Math.min(currentDelay * 2, MAX_RESTORE_RETRY_DELAY_MS);
  return { delay, next };
}
```

### Step 3: Run the test

```
cd /home/conor/terminal-v4/frontend && npm test -- reconnectDelay
```

Expected: PASS

### Step 4: Use it in TerminalChat.jsx

Import and replace the inline delay math:

```js
import { calcReconnectDelay } from '../utils/reconnectDelay';
```

Replace patterns like:
```js
const nextDelay = restoreRetryDelay;
restoreRetryDelay = Math.min(restoreRetryDelay * 2, 30000);
setTimeout(() => { if (!disposed) connectSocket(); }, nextDelay);
```
with:
```js
const { delay, next } = calcReconnectDelay(restoreRetryDelay);
restoreRetryDelay = next;
setTimeout(() => { if (!disposed) connectSocket(); }, delay);
```

There are ~4 occurrences to update.

### Step 5: Run all frontend tests

```
cd /home/conor/terminal-v4/frontend && npm test
```

Expected: all passing

### Step 6: Commit

```bash
cd /home/conor/terminal-v4
git add frontend/src/utils/reconnectDelay.js \
        frontend/src/utils/reconnectDelay.test.js \
        frontend/src/components/TerminalChat.jsx
git commit -m "refactor(terminal): extract reconnect delay logic into testable utility"
```

---

## Build & Verify Everything

After all tasks are done:

```bash
# Build backend
cd /home/conor/terminal-v4/backend && npm run build

# Build frontend
cd /home/conor/terminal-v4/frontend && npm run build

# Run all tests
cd /home/conor/terminal-v4/backend && npm test
cd /home/conor/terminal-v4/frontend && npm test

# Restart the server
~/terminal-v4/restart.sh
```

Verify in browser:
1. Open Network tab in devtools → WebSocket connections → confirm no `?token=` in the WS URL
2. Enable "Slow 3G" throttling → run a command that produces lots of output → verify no disconnect
3. Kill the backend → verify the reconnect message shows intervals that don't exceed 30s

---

## Summary

| Task | File(s) | Risk | Effort |
|------|---------|------|--------|
| 1: Token in URL → first message | `terminal-routes.ts`, `TerminalChat.jsx` | Medium (auth change) | ~2 hrs |
| 2: Skip instead of close slow client | `terminal-routes.ts` | Low | ~20 min |
| 3: Reduce restore retry cap to 30s | `TerminalChat.jsx` | Very low | ~5 min |
| 4: Reduce initial history fetch size | `TerminalChat.jsx` | Very low | ~5 min |
| 5: Extract reconnect delay (optional) | new util + tests | Low | ~30 min |
