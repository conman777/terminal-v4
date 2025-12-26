# Terminal V4 - Project Guide

## Project Architecture

This is a browser-based terminal emulator that wraps Claude Code CLI. It consists of:

- **Backend** (`/backend`): Fastify server (TypeScript) on port 3020
- **Frontend** (`/frontend`): React + Vite SPA

### Deployment Setup

The Fastify backend serves **both** the API and the static frontend files:

- API routes: `/api/*` (terminal, auth, bookmarks, settings, etc.)
- Static files: Served from `frontend/dist/` via `@fastify/static`
- SPA fallback: Non-API 404s return `index.html` for client-side routing

**Cloudflare Tunnel** routes all traffic to `localhost:3020`. There is no separate frontend server in production.

### Build & Deploy Commands

```bash
# Build frontend
cd frontend && npm run build

# Build backend
cd backend && npm run build

# Start production server (serves both API + frontend)
cd backend && npm start

# Development (separate servers with hot reload)
cd frontend && npm run dev   # Port 5173, proxies /api to 3020
cd backend && npm run dev    # Port 3020
```

### Restarting the Server

```bash
# Kill existing process
pkill -9 -f "node.*dist/index.js"

# Rebuild and restart
cd ~/terminal-v4/backend && npm run build && npm start
```

### Key Files

- `backend/src/index.ts` - Server entry, registers all routes + static serving
- `backend/src/routes/register-core-routes.ts` - Terminal & filesystem API routes
- `frontend/src/` - React components
- `frontend/dist/` - Built frontend (served by backend)

---

# Universal Software Engineering Best Practices

## Purpose

This guide provides language-agnostic best practices for writing maintainable, testable, and secure code. Use this as a reference across any project or technology stack.

**MUST** rules are critical for code quality; **SHOULD** rules are strongly recommended.

---

## 0 — Project-Specific Documentation

This guide contains **universal** best practices. For **project-specific** information, always check project documentation.

### Expected Documentation Structure

Projects should organize documentation as follows:

```
project-root/
├── README.md                    # Project overview (GitHub standard location)
├── CHANGELOG.md                 # Version history (GitHub standard location)
├── SECURITY.md                  # Security policy (GitHub standard location)
│
└── /docs/                       # All detailed documentation
    ├── architecture/
    │   ├── SYSTEM_ARCHITECTURE.md    # High-level system design
    │   ├── API_ARCHITECTURE.md       # API design and patterns
    │   ├── DATABASE_SCHEMA.md        # Database structure
    │   └── [PLATFORM]_ARCHITECTURE.md # Platform-specific (iOS, Android, Web, etc.)
    ├── development/
    │   ├── SETUP.md                  # Local development setup
    │   ├── [PLATFORM]_DEVELOPMENT.md # Platform-specific dev guides
    │   ├── TESTING_GUIDE.md          # How to run/write tests
    │   └── BUILD_AND_DEPLOY.md       # Build and deployment process
    ├── workflows/
    │   ├── ISSUE_WORKFLOW.md         # How to handle issues/tickets
    │   ├── VERSION_MANAGEMENT.md     # Versioning strategy
    │   └── PR_PROCESS.md             # Pull request workflow
    ├── troubleshooting/
    │   ├── COMMON_ISSUES.md          # FAQ and common problems
    │   ├── BUILD_ERRORS.md           # Build-related errors
    │   └── [AREA]_ERRORS.md          # Area-specific errors (API, DB, etc.)
    └── features/
        ├── [FEATURE_NAME].md         # Feature-specific documentation
        └── ...
```

### Critical Documentation

AI will check for and warn about missing critical documentation:

**Always Critical (check these first):**
1. `README.md` (root) - Project overview and quick start
2. `docs/architecture/SYSTEM_ARCHITECTURE.md` - High-level system design
3. `docs/development/SETUP.md` - Local development setup instructions
4. `docs/development/TESTING_GUIDE.md` - How to run and write tests

**Context-Dependent Critical (check if applicable):**
5. `docs/architecture/DATABASE_SCHEMA.md` - Required if project uses a database
6. `docs/architecture/API_ARCHITECTURE.md` - Required if project has an API

**Important (nice to have):**
- `CHANGELOG.md`, `SECURITY.md` (root)
- `docs/workflows/PR_PROCESS.md` - For team projects
- `docs/troubleshooting/COMMON_ISSUES.md` - For established projects
- Platform-specific and feature-specific docs

### AI Assistant Responsibilities

When working on a project:

1. **Check for critical documentation** - Verify critical docs exist, warn if missing
2. **Read relevant sections** - Don't guess, read the actual docs before proceeding
3. **Follow project patterns** - Use architecture/patterns defined in docs
4. **Smart doc updates** - When making architectural/significant changes:
   - Update relevant documentation
   - Always inform user: "📝 Updated [filename] to reflect [change]"
5. **Don't block work** - Warn about missing docs but proceed if user wants to continue

### Warning Format

When critical docs are missing, AI will warn with:

```
⚠️ Critical documentation missing:
- docs/architecture/SYSTEM_ARCHITECTURE.md
- docs/development/SETUP.md
- docs/development/TESTING_GUIDE.md

Consider creating these to document your project's patterns.
```

Then proceed with work using general best practices.

### Example: Adding a Feature

**User asks:** "Add payment processing feature"

**AI behavior:**
1. Check for critical docs (README.md, SYSTEM_ARCHITECTURE.md, SETUP.md, TESTING_GUIDE.md)
2. If missing → Show warning, proceed with general best practices
3. If exist → Read SYSTEM_ARCHITECTURE.md to understand patterns
4. Check for API_ARCHITECTURE.md and DATABASE_SCHEMA.md (payment likely needs both)
5. Implement feature following documented patterns
6. Update SYSTEM_ARCHITECTURE.md with payment architecture
7. Inform user: "📝 Updated SYSTEM_ARCHITECTURE.md to document payment processing flow"

---

## 1 — Before Coding

- **BP-0 (SHOULD)** Check for critical project documentation before starting work:
  - Verify `README.md` exists
  - Verify `docs/architecture/SYSTEM_ARCHITECTURE.md` exists
  - Verify `docs/development/SETUP.md` exists
  - Verify `docs/development/TESTING_GUIDE.md` exists
  - If missing, warn user but proceed with general best practices
- **BP-1 (MUST)** Ask clarifying questions about requirements before starting work
- **BP-2 (SHOULD)** Draft and confirm approach for complex work
- **BP-3 (SHOULD)** If ≥ 2 approaches exist, list clear pros and cons for each

---

## 2 — While Coding

- **C-1 (MUST)** Follow TDD: scaffold stub → write failing test → implement
- **C-2 (MUST)** Name functions using existing domain vocabulary for consistency
- **C-3 (SHOULD NOT)** Introduce classes when small testable functions suffice
- **C-4 (SHOULD)** Prefer simple, composable, testable functions
- **C-5 (MUST)** Use strong typing for IDs to prevent mixing different entity types
- **C-6 (SHOULD NOT)** Add comments except for critical caveats; write self-explanatory code
- **C-7 (SHOULD NOT)** Extract a function unless:
  - It will be reused in 2+ places, OR
  - It's the only way to unit-test otherwise untestable logic, OR
  - It drastically improves readability of an opaque block (>20 lines)

---

## 3 — Testing

- **T-1 (MUST)** Colocate unit tests next to source files
- **T-2 (MUST)** Add integration tests for all API/interface changes
- **T-3 (MUST)** ALWAYS separate pure-logic unit tests from I/O integration tests
- **T-4 (SHOULD)** Prefer integration tests over heavy mocking
- **T-5 (SHOULD)** Unit-test complex algorithms thoroughly
- **T-6 (SHOULD)** Test the entire structure in one assertion when possible

Example:
```
// Good: Single strong assertion
expect(result).toEqual([expectedValue])

// Avoid: Multiple weak assertions
expect(result).toHaveLength(1)
expect(result[0]).toEqual(expectedValue)
```

---

## 4 — Database

- **D-1 (MUST)** Ensure database helpers work with both direct connections and transactions
- **D-2 (SHOULD)** Override incorrect ORM-generated types when necessary
- **D-3 (MUST)** Use parameterized queries to prevent SQL injection
- **D-4 (SHOULD)** Keep database helper functions simple and testable

---

## 5 — Code Organization

- **O-1 (MUST)** Place shared code in common modules only when used by ≥ 2 components
- **O-2 (SHOULD)** Organize by feature/domain, not by technical layer
- **O-3 (SHOULD)** Keep related code physically close (high cohesion, low coupling)

---

## 6 — Tooling Gates

- **G-1 (MUST)** Run project's code formatter before committing
- **G-2 (MUST)** Run project's linter with zero warnings
- **G-3 (MUST)** Run project's type checker (if applicable to language)
- **G-4 (MUST)** Run tests before committing
- **G-5 (SHOULD)** Set up pre-commit hooks to enforce gates automatically

---

## 7 — Git Workflow

- **GH-1 (MUST)** Use Conventional Commits format: https://www.conventionalcommits.org/en/v1.0.0
- **GH-2 (SHOULD NOT)** Reference AI tools in commit messages
- **GH-3 (MUST)** Review git status before staging; keep unrelated files out
- **GH-4 (SHOULD NOT)** Use destructive git commands unless explicitly necessary

**Commit Format:**
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`

---

## Bug Finding Methodology

### Systematic Inspection - Check These Areas in Order:

**1. Error Boundaries**
- Uncaught exceptions/promise rejections
- Missing try-catch blocks around I/O operations
- Unhandled error events
- Error callbacks that don't propagate errors

**2. Async Boundaries**
- Race conditions between parallel operations
- Missing await/async handling
- Concurrent access to shared state
- Event handlers that modify state

**3. Input Validation**
- Missing null/undefined checks
- Type coercion bugs
- Path traversal vulnerabilities
- Injection attack vectors
- Missing input sanitization

**4. State Management**
- Stale closures capturing old state
- Mutations of shared objects
- State updates that don't trigger UI updates
- Cached values that don't invalidate

**5. Edge Cases**
- Empty arrays/strings
- Off-by-one errors
- Integer overflow/underflow
- Timezone and date handling
- Unicode and special characters

---

## Debugging Process (5 Steps)

### Step 1: Reproduce Reliably
- Create minimal reproduction case
- Document exact steps to trigger bug
- Note environmental factors (OS, versions, timing)
- Write a failing test that demonstrates the bug

### Step 2: Isolate the Problem
- Use binary search: Comment out half the code
- Add logging at module boundaries
- Check inputs and outputs at each function boundary
- Isolate to specific function or module

### Step 3: Analyze Root Cause
- Trace data flow backward from failure point
- Check assumptions (is variable really what you think?)
- Review recent changes (git blame, git log)
- Look for similar patterns elsewhere in codebase

### Step 4: Implement Fix
- Make the smallest change that fixes root cause
- Add defensive checks if appropriate
- Update related code with same bug pattern
- Document why the bug happened

### Step 5: Verify and Test
- Confirm original bug is fixed
- Run full test suite to prevent regressions
- Test related scenarios that might break
- Check performance impact of fix

---

## Security Checklist

Before shipping code, verify:

**Input Validation**
- [ ] All user input is validated (type, range, format)
- [ ] Path parameters are sanitized (no `../`)
- [ ] File uploads have size limits and type checks
- [ ] Query parameters have length limits

**Authentication & Authorization**
- [ ] All sensitive endpoints require authentication
- [ ] Users can only access their own resources
- [ ] Session tokens expire appropriately
- [ ] Password requirements enforced

**Injection Prevention**
- [ ] Database queries use parameterized statements
- [ ] Shell commands escape user input or use safe APIs
- [ ] HTML output is escaped to prevent XSS
- [ ] File paths are validated before operations

**Data Protection**
- [ ] Passwords are hashed, never stored in plain text
- [ ] Sensitive data is not logged
- [ ] HTTPS/TLS is used in production
- [ ] CORS is configured correctly

---

## Function Design Checklist

When evaluating a function you wrote:

1. Can you read it and honestly easily follow what it's doing? If yes, stop here.
2. Does it have reasonable cyclomatic complexity (<5 branches)?
3. Are there better data structures (parser, tree, queue) that would simplify it?
4. Are all parameters used? Any unnecessary type conversions?
5. Is it testable without mocking core features?
6. Does it have hidden dependencies that could be parameters?
7. Is the name the best choice, consistent with codebase vocabulary?
8. Does it follow single responsibility principle?

---

## Test Design Checklist

When evaluating a test you wrote:

1. **Parameterize inputs** - Never embed unexplained literals (42, "foo") directly
2. **Can fail for real defects** - Trivial asserts like `expect(2).toBe(2)` are forbidden
3. **Description matches assertion** - Test name states exactly what final expect verifies
4. **Independent expectations** - Compare to pre-computed values, not function output reused
5. **Strong assertions** - Use `toEqual` over `toBeGreaterThan` when possible
6. **Test edge cases** - Empty input, null, max values, unexpected input, boundaries
7. **Group by function** - Tests for a function grouped under `describe(functionName, ...)`
8. **Test invariants** - When possible, test properties/axioms rather than single cases

---

## Clean Code Principles

### Function Design Rules

**1. Single Responsibility** - Function does one thing well

```
// BAD: Function does too much
function handleUser(userId) {
  user = getUser(userId)
  posts = getPosts(userId)
  formatted = formatPosts(posts)
  sendEmail(user.email, formatted)
}

// GOOD: Separate concerns
function getUserPosts(userId) {
  return getPosts(userId)
}

function notifyUserOfPosts(user, posts) {
  formatted = formatPosts(posts)
  sendEmail(user.email, formatted)
}
```

**2. No Hidden Dependencies** - All dependencies passed as parameters

```
// BAD: Hidden dependency on global
function processData() {
  return globalDatabase.query("SELECT ...")
}

// GOOD: Explicit dependency
function processData(database) {
  return database.query("SELECT ...")
}
```

**3. Pure When Possible** - Same input → same output, no side effects

```
// BAD: Side effect (mutation)
function addToCart(cart, item) {
  cart.items.append(item)
  return cart
}

// GOOD: Pure function
function addToCart(cart, item) {
  return {
    ...cart,
    items: [...cart.items, item]
  }
}
```

---

## Shortcuts

Remember the following shortcuts which you may invoke at any time.

### QDOCS
Explore project documentation:

When starting work on a project or unfamiliar area:
1. Check if `/docs` folder exists
2. **Check for critical documentation:**
   - `README.md` (root)
   - `docs/architecture/SYSTEM_ARCHITECTURE.md`
   - `docs/development/SETUP.md`
   - `docs/development/TESTING_GUIDE.md`
3. **If critical docs missing** → Warn using standard format:
   ```
   ⚠️ Critical documentation missing:
   - [list missing docs]

   Consider creating these to document your project's patterns.
   ```
4. **List all documentation files** that exist
5. **Read relevant docs** for the area you're working on:
   - Architecture docs (SYSTEM_ARCHITECTURE, API_ARCHITECTURE, DATABASE_SCHEMA)
   - Development guides (SETUP, TESTING_GUIDE)
   - Troubleshooting docs if debugging
6. **Report findings:**
   - What documentation exists
   - Key patterns and architectural decisions found
   - Project-specific conventions to follow
7. **Identify gaps** - What important docs are missing

Use this shortcut BEFORE starting significant work to understand project-specific patterns.

### QPLAN
Implementation planning:

Before planning implementation:
1. Check `/docs` for relevant architecture and development guides (if not already done)
2. Analyze similar parts of the codebase
3. Determine whether your plan:
   - Is consistent with existing patterns and domain vocabulary
   - Follows project-specific architecture (from docs)
   - Introduces minimal changes
   - Reuses existing code where appropriate
   - Follows TDD workflow
4. Present plan with pros/cons if multiple approaches exist

### QCODE
Implementation with verification:

Implement your plan following the workflow:
1. Write failing test first (TDD)
2. Implement minimal code to pass test
3. Run full test suite
4. Run code formatter
5. Run linter and type checker
6. Verify no regressions

### QCHECK
Code quality review:

As a skeptical senior engineer, review MAJOR code changes:
1. Run Function Design Checklist for each function
2. Run Security Checklist if user-facing
3. Run Test Design Checklist for each test
4. Report issues with specific file:line references
5. Suggest concrete improvements

### QCHECKF
Function-focused review:

Run Function Design Checklist on each MAJOR function added or edited (skip trivial changes).

### QCHECKT
Test-focused review:

Run Test Design Checklist on each MAJOR test added or edited (skip trivial changes).

### QDEBUG
Systematic debugging:

Follow the 5-step debugging process:
1. Reproduce: Create minimal failing test
2. Isolate: Binary search to find failing module
3. Analyze: Trace root cause
4. Fix: Implement minimal surgical fix
5. Verify: Run tests, check for regressions

Document root cause and fix in comments or commit message.

### QINSPECT
Deep code inspection:

Systematically inspect the codebase following Bug Finding Methodology:
1. Check all error boundaries, async boundaries, input validation
2. Review state management and edge case handling
3. Look for common bug patterns
4. Report findings with file:line references
5. Warn if code is overcomplicated

Focus on section being discussed. Do NOT make changes - only analyze and report.

### QLOOK
Comprehensive codebase exploration:

When exploring an unfamiliar codebase section:
1. Read all relevant files in the section
2. Trace data flow through the system
3. Identify component dependencies and relationships
4. Map out the architecture and design patterns
5. Use parallel Task tool calls to explore multiple areas simultaneously
6. Report findings with clear explanations

Do NOT modify code - only understand and explain.

### QCON
Complex problem solving:

When tackling a complex problem:
1. Follow Implementation Best Practices checklist
2. Analyze every MAJOR code change (skip minor changes)
3. Keep solutions simple - warn if becoming overcomplicated
4. Ensure code is easy to understand and maintain
5. Use parallel Task tool calls to solve independent sub-problems
6. Report what has been completed and what remains

### QUX
UX testing scenarios:

Generate comprehensive test scenarios as a human tester, sorted by priority:
1. Happy path: Most common user flow
2. Edge cases: Empty states, max limits, errors
3. Error recovery: What happens when things go wrong
4. Accessibility: Keyboard navigation, screen readers
5. Performance: Load time, responsiveness

### QGIT
Commit and push:

1. Review git status
2. Stage all relevant changes
3. Create commit with Conventional Commits format
4. Do NOT mention AI tools in commit message
5. Push to remote

---

## Response Formatting

When working with users:

- Start responses with the key outcome or change before deeper detail
- Cite files using inline code with `path:line` references (1-based)
- Keep tone concise and collaborative; avoid unnecessary filler
- Call out any verification steps you could not run
- Offer natural next steps when appropriate

---

**Remember:** Simple, testable, secure code is better than clever code.
