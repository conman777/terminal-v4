# Browser Test Runner - Security Implementation

## Overview

The test runner service executes user-provided test code in a sandboxed environment to prevent malicious code from accessing the host system.

## Security Features Implemented

### 1. VM Sandbox (Phase 6 Critical Fix)

**File:** `test-runner-service.ts:252-332`

The test execution uses Node.js `vm` module to create an isolated context with:

- **Restricted APIs**: Only safe APIs are exposed (page, expect, console, timers)
- **No File System Access**: `fs`, `require`, `Buffer` are not available
- **No Process Access**: `process`, `global`, `__dirname`, `__filename` blocked
- **No Code Generation**: `eval()` and `Function()` constructor disabled
- **No WebAssembly**: WASM disabled to prevent binary exploits

**Blocked APIs:**
```javascript
// ❌ BLOCKED - Not available in sandbox
require()        // Module loading
process          // Process control
fs              // File system
Buffer          // Binary data manipulation
global          // Global object access
__dirname       // Directory paths
__filename      // File paths
eval()          // Code evaluation
Function()      // Function constructor
WebAssembly     // Binary code execution
```

**Allowed APIs:**
```javascript
// ✅ ALLOWED - Safe APIs only
page            // Playwright page object
expect          // Test assertions
console         // Logging (redirected)
setTimeout      // Timers
setInterval     // Timers
Promise         // Async operations
Math            // Math operations
Date            // Date/time
JSON            // JSON parsing
Array, Object, String, Number, Boolean
```

### 2. Execution Timeouts

**Compilation Timeout:** 30 seconds
- Prevents extremely large code from consuming resources
- Catches syntax errors early

**Execution Timeout:** 60 seconds
- Prevents infinite loops
- Terminates runaway code automatically
- Enforced at both VM level and Promise.race level

### 3. Resource Monitoring

**File:** `worker-pool.ts:247-287`

Each worker is monitored every 10 seconds for:

- **Memory Usage**: Max 512MB per worker
  - If exceeded, worker is restarted
  - Prevents memory leaks from affecting other tests

- **CPU Usage**: Max 50% target
  - Future implementation for CPU limiting
  - Can integrate with OS-level resource controls

### 4. Worker Isolation

Each test runs in a separate browser worker with:

- **Isolated Browser Context**: No shared cookies, storage, or cache
- **Clean State**: Workers are reset between tests
- **Crash Recovery**: Failed workers are automatically recreated

### 5. Queue Management

**File:** `worker-pool.ts:37-66, 106-149`

- **Max Queue Size**: 100 concurrent requests
- **Backpressure**: Rejects new requests if queue is full
- **Stale Request Cleanup**: Removes requests older than 1 minute
- **FIFO Scheduling**: First-come, first-served fairness

## Security Test Suite

**File:** `test-runner-service.security.test.ts`

Comprehensive security tests verify:

### Attack Prevention Tests
- ✅ Prevents file system access via `require('fs')`
- ✅ Prevents process manipulation via `process.exit()`
- ✅ Prevents Buffer access for binary manipulation
- ✅ Prevents global object pollution
- ✅ Prevents `__dirname` and `__filename` access
- ✅ Prevents `eval()` usage
- ✅ Prevents Function constructor exploits
- ✅ Prevents prototype pollution
- ✅ Prevents dynamic import attacks

### Resource Limit Tests
- ✅ Enforces execution timeout on infinite loops
- ✅ Enforces compilation timeout on huge code
- ✅ Memory monitoring (via worker-pool tests)

### Safe Operation Tests
- ✅ Allows Playwright page operations
- ✅ Allows console logging
- ✅ Allows setTimeout/setInterval
- ✅ Allows Promise usage
- ✅ Allows Math operations
- ✅ Allows JSON operations

## Quick Verification

Run quick security tests:
```bash
npm test -- src/browser/test-runner-service.security-quick.test.ts
```

Expected output:
```
✓ prevents file system access via require
✓ prevents process access
✓ allows safe Playwright operations
```

## Architecture Diagram

```
User Test Code
      ↓
[VM Sandbox] ← Timeout enforcement
      ↓         ↓
  [Worker] → [Browser]
      ↓
[Resource Monitor] → Restart if exceeded
      ↓
[Worker Pool Queue] ← Backpressure control
```

## Threat Model

### Threats Mitigated

1. **File System Access**: Cannot read/write files outside sandbox
2. **Process Manipulation**: Cannot spawn processes or exit
3. **Memory Exhaustion**: Monitored and limited to 512MB
4. **CPU Exhaustion**: Timeout after 60 seconds
5. **Code Injection**: eval() and Function() disabled
6. **Binary Exploits**: WebAssembly disabled
7. **Prototype Pollution**: Isolated context prevents leakage

### Remaining Considerations

1. **Network Access**: Tests can still make network requests via page
   - Mitigation: Browser-level CSP could be added

2. **DoS via Queue**: Max queue size prevents unbounded queuing
   - Mitigation: Rate limiting at API level recommended

3. **Browser Exploits**: Chromium vulnerabilities could be exploited
   - Mitigation: Keep Playwright updated regularly

## Best Practices

1. **Always use VM sandbox**: Never execute user code directly
2. **Set timeouts**: Prevent runaway code from consuming resources
3. **Monitor resources**: Track memory/CPU usage per worker
4. **Clean between tests**: Reset browser state after each test
5. **Limit queue size**: Implement backpressure to prevent overload
6. **Update dependencies**: Keep Playwright and browsers up to date

## Code References

- Test Runner: `/backend/src/browser/test-runner-service.ts:252-332`
- Worker Pool: `/backend/src/browser/worker-pool.ts`
- Security Tests: `/backend/src/browser/test-runner-service.security.test.ts`
- Quick Tests: `/backend/src/browser/test-runner-service.security-quick.test.ts`

## Version History

- **Phase 6 (2025-01-20)**: Implemented VM sandbox with comprehensive security controls
- **Phase 5**: Added worker pool and resource monitoring
- **Phase 4**: Initial test runner implementation (VULNERABLE - fixed in Phase 6)
