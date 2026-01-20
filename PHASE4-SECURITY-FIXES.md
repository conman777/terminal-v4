# Phase 4 Security Fixes - Implementation Summary

## Overview

This document summarizes the critical security fixes implemented in Phase 4 to address path traversal vulnerabilities, file validation issues, and broken code patterns.

## Fixes Implemented

### 1. Path Traversal Prevention in `baseline-storage.ts`

**File:** `/home/conor/terminal-v4/backend/src/storage/baseline-storage.ts:195-212`

**Problem:** Path traversal validation happened AFTER sanitization, allowing potential bypass.

**Fix:** Moved validation checks BEFORE sanitization:

```typescript
function sanitizeBaselineName(name: string): string {
  // Validate BEFORE sanitizing to catch path traversal attempts
  if (!name || name.length === 0) {
    throw new Error('Baseline name cannot be empty');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid characters in baseline name: path traversal attempt');
  }
  if (name.length > 255) {
    throw new Error('Baseline name too long (max 255 chars)');
  }

  // Now sanitize
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}
```

**Security Impact:**
- Blocks path traversal attempts like `../etc/passwd` before any processing
- Prevents directory traversal on both Unix (`/`, `..`) and Windows (`\\`) paths
- Validates input before transformation, ensuring checks cannot be bypassed

---

### 2. File Size Validation in `saveBaseline()`

**File:** `/home/conor/terminal-v4/backend/src/storage/baseline-storage.ts:44-63`

**Problem:** No file size limits, allowing potential DoS attacks with massive files.

**Fix:** Added 10MB size limit at the start of `saveBaseline()`:

```typescript
export async function saveBaseline(
  name: string,
  imageBuffer: Buffer,
  metadata: Partial<BaselineMetadata>
): Promise<BaselineInfo> {
  await initBaselineStorage();

  // Validate file size FIRST (max 10MB)
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  if (imageBuffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB (max 10MB)`);
  }

  // Validate PNG signature before anything else
  const dimensions = getImageDimensions(imageBuffer);

  // Sanitize name for filesystem (includes path traversal checks)
  const sanitizedName = sanitizeBaselineName(name);
  // ... rest of function
}
```

**Security Impact:**
- Rejects files >10MB immediately, preventing resource exhaustion
- Size check happens before expensive PNG parsing
- Clear error message with actual file size

**Execution Order (Critical):**
1. File size validation (reject >10MB)
2. PNG signature validation (via `getImageDimensions`)
3. Name sanitization (includes path traversal checks)
4. Write to filesystem

This order ensures expensive operations only run on valid, safe inputs.

---

### 3. PNG Buffer Validation in `visual-regression-service.ts`

**File:** `/home/conor/terminal-v4/backend/src/browser/visual-regression-service.ts:34-60`

**Problem:** No validation of PNG buffers before parsing, allowing potential crashes or hangs.

**Fix:** Added buffer validation and timeout protection:

```typescript
export async function compareImages(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  options: DiffOptions = {}
): Promise<DiffResult> {
  // Validate buffers
  if (!baselineBuffer || baselineBuffer.length < 24) {
    throw new Error('Invalid baseline image buffer');
  }
  if (!currentBuffer || currentBuffer.length < 24) {
    throw new Error('Invalid current image buffer');
  }

  // Parse images with timeout protection
  const parseTimeout = 10000; // 10 seconds
  const baseline = await Promise.race([
    parseImage(baselineBuffer),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Baseline image parsing timeout')), parseTimeout)
    )
  ]);
  const current = await Promise.race([
    parseImage(currentBuffer),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Current image parsing timeout')), parseTimeout)
    )
  ]);
  // ... rest of function
}
```

**Security Impact:**
- Validates minimum PNG buffer size (24 bytes for header)
- Prevents parsing completely invalid/corrupt data
- 10-second timeout prevents hanging on malformed PNGs
- Protects against DoS via specially-crafted PNG files

---

### 4. User Agent Override Removal in `PreviewPanel.jsx`

**File:** `/home/conor/terminal-v4/frontend/src/components/PreviewPanel.jsx:828-833`

**Problem:** Code attempted to override read-only `navigator.userAgent` property, which fails silently and provides no value.

**Fix:** Removed broken code, added documentation:

```javascript
// Note: User agent override not possible in iframe due to browser security.
// The navigator.userAgent property is read-only and cannot be overridden
// from the parent frame. User agent can only be changed server-side via
// Playwright's browser context. Consider implementing this in the backend
// if user agent simulation is needed for testing.
// See: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgent
```

**Impact:**
- Removes misleading code that appeared to work but didn't
- Documents the limitation and correct approach
- Prevents future confusion about why UA override doesn't work

---

## Verification

All fixes have been verified through:

1. **TypeScript compilation** - Both backend and frontend build successfully
2. **Source code audit** - Automated tests verify all security checks are present
3. **Execution order validation** - Confirms operations happen in secure order

### Test Results

```
=== Source Code Security Audit ===

Test 1: Path traversal validation order...
  ✓ PASSED: Path traversal validation happens before sanitization

Test 2: File size validation in saveBaseline...
  ✓ PASSED: File size validation present

Test 3: 10MB file size limit...
  ✓ PASSED: 10MB limit defined

Test 4: Buffer validation in compareImages...
  ✓ PASSED: Buffer validation present

Test 5: Timeout protection for PNG parsing...
  ✓ PASSED: Timeout protection present

Test 6: User agent override documentation...
  ✓ PASSED: Broken user agent code removed, documentation added

Test 7: Security error messages...
  ✓ PASSED: Informative error messages present

Test 8: Correct execution order in saveBaseline...
  ✓ PASSED: Correct execution order (size → dimensions → sanitize → write)

=== Audit Summary ===
Total: 8
Passed: 8
Failed: 0

✓ All security fixes verified in source code!
```

---

## Security Improvements Summary

1. **Path Traversal Protection**
   - Validation happens before sanitization
   - Blocks `/`, `\`, and `..` characters
   - Works on both Unix and Windows paths

2. **Resource Limits**
   - 10MB file size limit
   - Early rejection of oversized files
   - Prevents DoS attacks

3. **Input Validation**
   - PNG signature validation
   - Minimum buffer size checks
   - Empty/invalid name rejection

4. **Timeout Protection**
   - 10-second timeout on image parsing
   - Prevents hanging on corrupt PNGs
   - Clean error messages on timeout

5. **Code Quality**
   - Removed broken user agent override
   - Added documentation for limitations
   - Clear, informative error messages

---

## Files Modified

1. `/home/conor/terminal-v4/backend/src/storage/baseline-storage.ts`
   - Enhanced `sanitizeBaselineName()` with validation
   - Added file size check to `saveBaseline()`

2. `/home/conor/terminal-v4/backend/src/browser/visual-regression-service.ts`
   - Added buffer validation to `compareImages()`
   - Added timeout protection for PNG parsing

3. `/home/conor/terminal-v4/frontend/src/components/PreviewPanel.jsx`
   - Removed broken user agent override code
   - Added documentation comment

---

## Deployment

To deploy these fixes:

```bash
# Build backend
cd ~/terminal-v4/backend && npm run build

# Build frontend
cd ~/terminal-v4/frontend && npm run build

# Restart server
~/terminal-v4/restart.sh
```

Or use the all-in-one command:
```bash
cd ~/terminal-v4/backend && npm run build && cd ~/terminal-v4/frontend && npm run build && ~/terminal-v4/restart.sh
```

---

## Testing Recommendations

Before deployment to production:

1. **Test path traversal attempts** - Verify they are blocked with clear error messages
2. **Test large file uploads** - Confirm >10MB files are rejected
3. **Test invalid PNGs** - Ensure corrupt files don't crash the system
4. **Test normal baseline operations** - Verify legitimate use cases still work

---

## Future Considerations

1. **Rate limiting** - Consider adding rate limits to baseline upload endpoints
2. **File type validation** - Could add magic number validation beyond just PNG signature
3. **Server-side UA override** - If user agent simulation is needed, implement in Playwright context
4. **Audit logging** - Log path traversal attempts and file size violations for security monitoring

---

## References

- Original issue: Phase 4 critical path traversal and file security issues
- Related files: baseline-storage.ts, visual-regression-service.ts, PreviewPanel.jsx
- Testing: test-security-manual.mjs (automated source code audit)
