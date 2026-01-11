# Bug Fix Plan - Terminal V4

This document outlines the plan to fix 19 identified bugs across the codebase.

## Overview

| Priority | Count | Estimated Effort |
|----------|-------|------------------|
| Critical | 4 | 2-3 hours |
| High | 5 | 2-3 hours |
| Medium | 6 | 1-2 hours |
| Low | 4 | 1 hour |
| **Total** | **19** | **6-9 hours** |

---

## Phase 1: Critical Fixes (Do First)

### Bug #1: Command Injection via PID
**File:** `backend/src/routes/register-core-routes.ts:695`

**Current Code:**
```typescript
exec(`readlink /proc/${pid}/cwd 2>/dev/null`, ...)
```

**Fix:**
```typescript
import { readlink } from 'fs/promises';

// Replace exec with fs.readlink
try {
  const cwd = await readlink(`/proc/${pid}/cwd`);
  // use cwd...
} catch {
  // Process may have exited
}
```

**Alternative (if exec needed):**
```typescript
// Validate PID is numeric only
if (!/^\d+$/.test(pid)) {
  continue; // Skip invalid PIDs
}
exec(`readlink /proc/${pid}/cwd 2>/dev/null`, ...)
```

---

### Bug #2: WebSocket Resource Leak
**File:** `backend/src/routes/dev-proxy-routes.ts:396-440`

**Current Code:**
```typescript
targetWs.on('open', () => {
  socket.on('message', (data) => { ... }); // Only attached after open
});
```

**Fix:**
```typescript
// Buffer messages until connection opens
const messageBuffer: Buffer[] = [];
let isOpen = false;

socket.on('message', (data) => {
  if (isOpen && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(data);
  } else {
    messageBuffer.push(data as Buffer);
  }
});

targetWs.on('open', () => {
  isOpen = true;
  // Flush buffered messages
  while (messageBuffer.length > 0) {
    targetWs.send(messageBuffer.shift()!);
  }
});

// Add connection timeout
const connectionTimeout = setTimeout(() => {
  if (!isOpen) {
    socket.close(1001, 'Connection timeout');
    targetWs.close();
  }
}, 10000);

targetWs.on('open', () => {
  clearTimeout(connectionTimeout);
  // ... rest of handler
});
```

---

### Bug #3: Race Condition in Port Mapping
**File:** `backend/src/routes/register-core-routes.ts:667-715`

**Current Code:**
```typescript
const cwdPromises = pids.map(pid => new Promise(...));
await Promise.all(cwdPromises);
```

**Fix:**
```typescript
// Process sequentially to avoid race conditions
for (const pid of pids) {
  try {
    const cwd = await readlink(`/proc/${pid}/cwd`);
    const existing = portMap.get(port);
    if (existing) {
      existing.cwd = cwd;
    }
  } catch {
    // Process may have exited
  }
}
```

**Or use a Map for atomic updates:**
```typescript
// Collect results first, then update map once
const results = await Promise.all(
  pids.map(async (pid) => {
    try {
      return { pid, cwd: await readlink(`/proc/${pid}/cwd`) };
    } catch {
      return null;
    }
  })
);

// Single update pass (no race)
for (const result of results) {
  if (result) {
    const existing = portMap.get(port);
    if (existing) existing.cwd = result.cwd;
  }
}
```

---

### Bug #4: Memory Leak - Unclean Event Listeners
**File:** `frontend/src/components/TerminalChat.jsx:924-945`

**Current Code:**
```javascript
// Listeners added on drag start, removed on mouseup
document.addEventListener('mousemove', handleMouseMove);
document.addEventListener('mouseup', handleMouseUp);
```

**Fix:**
```javascript
useEffect(() => {
  if (!isDragging) return;

  const handleMouseMove = (e) => { /* ... */ };
  const handleMouseUp = () => {
    setIsDragging(false);
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  // Cleanup on unmount OR when isDragging changes
  return () => {
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}, [isDragging]);
```

---

## Phase 2: High Priority Fixes

### Bug #5: Missing Stream Error Handlers
**File:** `backend/src/processes/process-service.ts:250-268`

**Fix:** Add error handlers:
```typescript
child.stdout?.on('data', (data) => { /* ... */ });
child.stdout?.on('error', (err) => {
  console.error(`stdout error for process ${child.pid}:`, err);
});

child.stderr?.on('data', (data) => { /* ... */ });
child.stderr?.on('error', (err) => {
  console.error(`stderr error for process ${child.pid}:`, err);
});

child.on('error', (err) => {
  console.error(`Process error:`, err);
});
```

---

### Bug #6: Interval Not Cleared on Shutdown
**File:** `backend/src/preview/preview-logs-service.ts:214`

**Fix:** In `backend/src/index.ts`, add shutdown handler:
```typescript
import { stopCleanupInterval } from './preview/preview-logs-service';

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down...');
  stopCleanupInterval();
  await server.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

---

### Bug #7: Null Pointer Risk in Iterator
**File:** `backend/src/terminal/terminal-manager.ts:595`

**Fix:**
```typescript
if (session.clientDimensions.size > 0) {
  const iterator = session.clientDimensions.values();
  const first = iterator.next();
  if (!first.done && first.value) {
    const firstDims = first.value;
    if (firstDims.cols !== session.currentCols || firstDims.rows !== session.currentRows) {
      // ...
    }
  }
}
```

---

### Bug #8: Stale Iframe Reference
**File:** `frontend/src/components/PreviewPanel.jsx:260-261`

**Fix:** Verify event source:
```javascript
const handleMessage = useCallback((event) => {
  // Verify message is from our iframe
  if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
    // Safe to process
    iframeRef.current.contentWindow.postMessage(...);
  }
}, []);
```

---

### Bug #9: Event Deduplication Set Cleared Entirely
**File:** `frontend/src/components/ClaudeCodePanel.jsx:289-292`

**Fix:** Use LRU-style pruning:
```javascript
// Instead of clearing entirely, remove oldest half
if (seenEventIdsRef.current.size > MAX_EVENTS * 2) {
  const entries = Array.from(seenEventIdsRef.current);
  const toKeep = entries.slice(-MAX_EVENTS); // Keep newest
  seenEventIdsRef.current = new Set(toKeep);
}
```

---

## Phase 3: Medium Priority Fixes

### Bug #10: Silent Cookie Parse Failures
**File:** `backend/src/preview/cookie-store.ts:103`

**Fix:** Add logging:
```typescript
const parsed = parseSetCookie(cookieStr);
if (!parsed) {
  console.warn(`Failed to parse cookie: ${cookieStr.substring(0, 50)}...`);
  continue;
}
```

---

### Bug #11: Unvalidated PID
**File:** `backend/src/processes/process-service.ts:64`

**Fix:**
```typescript
const pidNum = parseInt(pid, 10);
if (isNaN(pidNum) || pidNum <= 0) {
  continue;
}
command = readFileSync(`/proc/${pidNum}/comm`, 'utf-8').trim();
```

---

### Bug #12: Empty Catch Blocks
**Multiple files**

**Fix:** Add minimal logging:
```typescript
// Before
catch {}

// After
catch (err) {
  // Intentionally ignored: [reason]
}
// Or
catch (err) {
  console.debug('Non-critical error:', err);
}
```

---

### Bug #13: JSON.parse Without Try-Catch
**Files:** `cookie-store.ts:36`, `bookmark-store.ts:93`

**Fix:**
```typescript
let data;
try {
  data = JSON.parse(fileContents);
} catch (err) {
  console.error('Failed to parse JSON:', err);
  data = {}; // Default fallback
}
```

---

### Bug #14: Stale Closure in Scroll Callbacks
**File:** `frontend/src/components/TerminalChat.jsx:591-603`

**Fix:** Already using ref pattern (`onScrollDirectionRef`), but ensure cleanup:
```javascript
useEffect(() => {
  return () => {
    // Ensure ref is cleared on unmount
    onScrollDirectionRef.current = null;
  };
}, []);
```

---

### Bug #15: Missing useEffect Dependency
**File:** `frontend/src/hooks/useKeyboardShortcuts.js:38-48`

**Fix:**
```javascript
useEffect(() => {
  handlersRef.current = handlers;
}, [handlers]); // Add dependency
```

---

## Phase 4: Low Priority Fixes

### Bug #16: No Timeout on exec() Calls
**Fix:** Add AbortSignal timeout:
```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// With timeout
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);

try {
  const { stdout } = await execAsync(command, { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

---

### Bug #17: Magic Number for WebSocket State
**File:** `backend/src/routes/dev-proxy-routes.ts:418`

**Fix:**
```typescript
import WebSocket from 'ws';

// Before
if (socket.readyState === 1)

// After
if (socket.readyState === WebSocket.OPEN)
```

---

### Bug #18: Mobile Detection Not Reactive
**File:** `frontend/src/components/ClaudeCodePanel.jsx:9`

**Fix:**
```javascript
// Before (module level, static)
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;

// After (inside component, reactive)
import { useMobileDetect } from '../hooks/useMobileDetect';

function ClaudeCodePanel() {
  const isMobile = useMobileDetect();
  // ...
}
```

---

### Bug #19: Iframe src Manipulation
**File:** `frontend/src/components/PreviewPip.jsx:162`

**Fix:** Add debounce:
```javascript
const handleRefresh = useCallback(() => {
  if (refreshingRef.current) return;
  refreshingRef.current = true;

  const iframe = iframeRef.current;
  if (iframe) {
    iframe.src = iframe.src;
  }

  setTimeout(() => {
    refreshingRef.current = false;
  }, 1000);
}, []);
```

---

## Implementation Order

1. **Day 1:** Critical fixes (#1-4)
2. **Day 2:** High priority fixes (#5-9)
3. **Day 3:** Medium priority fixes (#10-15)
4. **Day 4:** Low priority fixes (#16-19) + Testing

## Testing Checklist

- [ ] Run existing Playwright tests
- [ ] Manual test WebSocket connections
- [ ] Test terminal scroll behavior
- [ ] Test preview panel with inspector
- [ ] Load test to verify no memory leaks
- [ ] Test graceful server shutdown

## Rollback Plan

Each fix should be committed separately so individual changes can be reverted if issues arise.

```bash
git revert <commit-hash>  # Revert specific fix if needed
```
