# Phase 6 Automation UI - User Guide

## Overview

The Phase 6 Automation UI provides a complete browser automation testing workflow directly in Terminal V4's preview panel. Record actions, generate test code, run tests in parallel, and manage cookies - all without leaving the terminal.

## Current Status (2026-01)

- The automation UI described here is not wired in the current frontend.
- The backend does not implement the recorder/test/cookie endpoints listed below.
- Only the basic browser automation API under `/api/browser/*` exists today
  (see `docs/architecture/API_ARCHITECTURE.md` and
  `backend/src/routes/browser-routes.ts`).

## Components

### 1. RecorderPanel

The action recorder captures your interactions with the browser and converts them into reusable test scripts.

**Features:**
- Start/Stop/Pause recording
- Real-time action counter
- Manual assertion insertion
- Manual wait statement insertion
- Action list viewer
- Code generation integration

**Usage:**
1. Click the "Record" button (⚫) in the preview toolbar
2. Click "Start Recording" to begin capturing actions
3. Interact with your application normally
4. Click "Add Assertion" to validate element states
5. Click "Add Wait" to add explicit waits
6. Click "Stop" when finished
7. Click "Generate Code" to export as test code

**Recorded Actions:**
- Navigation (`goto`)
- Clicks (`click`)
- Text input (`type`, `fill`)
- Dropdown selection (`select`)
- Scrolling (`scroll`)
- Hover events (`hover`)
- Custom assertions (`assertion`)
- Wait statements (`wait`)

### 2. ActionList

Displays all recorded actions in chronological order with full details.

**Features:**
- Expandable action items
- Action metadata (timestamp, index, type)
- Visual indicators for action types
- Playback highlighting (current action during replay)

**Action Details:**
- Type (goto, click, type, etc.)
- CSS Selector (when applicable)
- Values/Text entered
- Timeout settings
- Assertion types
- Expected values

### 3. CodeGenerator

Converts recorded actions into production-ready test code.

**Supported Frameworks:**
- Playwright
- Puppeteer
- Selenium

**Supported Languages:**
- JavaScript (ES6+)
- TypeScript
- Python

**Test Frameworks:**
- None (plain script)
- Jest
- Mocha
- Pytest

**Features:**
- Live code generation
- Syntax highlighting (via Prism.js)
- Copy to clipboard
- Download as file (proper extension)
- Framework-specific imports and setup
- Assertion library integration

**Generated Code Structure:**
```javascript
// Example: Playwright + JavaScript + Jest

import { test, expect } from '@playwright/test';

test('recorded test', async ({ page }) => {
  // Navigate
  await page.goto('http://localhost:3000');

  // Click button
  await page.click('#submit-btn');

  // Fill input
  await page.fill('#email', 'user@example.com');

  // Assert
  await expect(page.locator('.success')).toBeVisible();
});
```

### 4. TestRunner

Execute multiple tests in parallel with real-time progress tracking.

**Features:**
- Test selection (checkboxes)
- Select all/deselect all
- Concurrency control (1-10 parallel)
- Retry configuration (0-5 retries)
- Screenshot on failure toggle
- Real-time progress via WebSocket
- Test status indicators

**Configuration Options:**
- **Concurrency**: Number of tests to run in parallel (default: 3)
- **Max Retries**: Retry failed tests automatically (default: 0)
- **Capture Screenshots**: Take screenshot on test failure (default: true)

**Test Sources:**
- Recording sessions converted to tests
- Each recording becomes a selectable test
- Framework and language specified per test

**Workflow:**
1. Click "Tests" button (📊) in toolbar
2. Select tests to run (checkboxes)
3. Configure concurrency and retries
4. Click "Run Selected Tests"
5. Watch real-time progress
6. Review results in TestResults panel

### 5. TestResults

Comprehensive test results with detailed failure information.

**Features:**
- Aggregate statistics (total, passed, failed, running)
- Progress bar visualization
- Test duration tracking
- Failed test details
- Screenshot viewer (for failures)
- Log viewer (stdout/stderr)
- Export results as JSON
- Retry failed tests button

**Result Details:**
- **Status**: pending, running, passed, failed
- **Duration**: Execution time in ms/seconds
- **Error**: Stack trace and error message
- **Screenshot**: Visual snapshot at failure point
- **Logs**: Console output during execution

**Click any test row to view:**
- Full error message
- Complete logs
- Failure screenshot (if captured)
- Test metadata (name, framework, duration)

### 6. CookieManager

Full-featured cookie management for testing authentication and sessions.

**Features:**
- View all cookies (table view)
- Add new cookies (form)
- Edit existing cookies
- Delete individual cookies
- Bulk delete (Clear All)
- Export cookies as JSON
- Import cookies from JSON
- Search by name/value
- Filter by domain
- Cookie statistics

**Cookie Attributes:**
- **Name**: Cookie identifier
- **Value**: Cookie data
- **Domain**: Domain scope
- **Path**: Path scope
- **Expires**: Expiration timestamp (-1 for session)
- **HttpOnly**: HTTP-only flag
- **Secure**: HTTPS-only flag
- **SameSite**: CSRF protection (Strict, Lax, None)

**Use Cases:**
- Test logged-in states
- Import production cookies for testing
- Export test session cookies
- Clear cookies between test runs
- Debug authentication issues
- Share session data between team members

## Integration with Preview Panel

All automation tools are accessible via the preview toolbar:

```
[Back] [Forward] [Refresh] | [Screenshot] | [Inspect] | [⚫Record] [📊Tests] [🍪Cookies] | [DevTools]
```

**Toolbar Buttons:**
- **⚫ Record**: Open RecorderPanel
- **📊 Tests**: Open TestRunner
- **🍪 Cookies**: Open CookieManager

## API Endpoints (Planned)

### Recording

```
POST   /api/browser/recorder/start          # Start recording
POST   /api/browser/recorder/stop           # Stop recording
GET    /api/browser/recorder/active         # Get active recording
GET    /api/browser/recorder/sessions       # List all recordings
GET    /api/browser/recorder/actions/:id    # Get actions for recording
DELETE /api/browser/recorder/:id            # Delete recording
POST   /api/browser/recorder/assertion      # Add manual assertion
POST   /api/browser/recorder/wait           # Add manual wait
POST   /api/browser/recorder/generate       # Generate code
```

### Test Execution

```
POST   /api/browser/tests/run               # Run tests
GET    /api/browser/tests/status/:runId     # Get run status
GET    /api/browser/tests/result/:jobId     # Get job result
GET    /api/browser/tests/runs              # List all runs
POST   /api/browser/tests/cancel/:runId     # Cancel run
WS     /api/browser/tests/stream?runId=X    # Real-time updates
```

### Cookie Management

```
GET    /api/browser/cookies                 # Get all cookies
GET    /api/browser/cookies/:name           # Get specific cookie
POST   /api/browser/cookies                 # Set cookie
POST   /api/browser/cookies/bulk            # Set multiple cookies
DELETE /api/browser/cookies/:name           # Delete cookie
DELETE /api/browser/cookies                 # Delete multiple/all cookies
GET    /api/browser/cookies/export          # Export as JSON
POST   /api/browser/cookies/import          # Import from JSON
GET    /api/browser/cookies/stats           # Get statistics
```

## Example Workflows

### Workflow 1: Record and Generate Test

1. Open preview panel with your application
2. Click **Record** button (⚫)
3. Click **Start Recording**
4. Perform actions:
   - Navigate to login page
   - Fill username and password
   - Click submit button
5. Click **Add Assertion**
   - Type: `visible`
   - Selector: `.dashboard`
6. Click **Stop**
7. Click **Generate Code**
8. Select framework: **Playwright**
9. Select language: **TypeScript**
10. Select test framework: **Jest**
11. Click **Copy** or **Download**

### Workflow 2: Run Multiple Tests in Parallel

1. Click **Tests** button (📊)
2. Check boxes for tests to run
3. Set concurrency to **5**
4. Enable **Capture screenshots on failure**
5. Click **Run Selected Tests**
6. Watch progress in real-time
7. Click failed test to view details
8. View screenshot and error
9. Click **Retry Failed** to re-run failures

### Workflow 3: Import Production Cookies

1. Click **Cookies** button (🍪)
2. Click **Import**
3. Select cookie JSON file (from production)
4. Cookies are imported
5. Refresh preview to test with cookies
6. Verify logged-in state
7. Export modified cookies for sharing

### Workflow 4: E2E Test Recording

1. **Setup**:
   - Start recording
   - Navigate to app homepage

2. **User Flow**:
   - Click "Sign Up" button
   - Fill form fields (name, email, password)
   - Click "Create Account"

3. **Assertions**:
   - Add assertion: `.success-message` is visible
   - Add assertion: `.user-avatar` is visible

4. **Generate**:
   - Stop recording
   - Generate Playwright + TypeScript code
   - Download as `signup.spec.ts`

5. **Execute**:
   - Add to TestRunner
   - Run test
   - Verify passes

## Tips and Best Practices

### Recording

- **Wait for elements**: Add explicit waits before interactions
- **Use specific selectors**: Prefer IDs over classes when possible
- **Add assertions liberally**: Validate each step of the flow
- **Name recordings clearly**: Use descriptive names for easy identification
- **Test in isolation**: Clear cookies between recordings for clean state

### Code Generation

- **Choose appropriate framework**: Match your project's test framework
- **Review generated code**: Always review and adjust selectors
- **Add test data**: Replace hardcoded values with test fixtures
- **Organize tests**: Group related tests in describe blocks
- **Use page objects**: Refactor repeated selectors into page objects

### Test Execution

- **Start with low concurrency**: Begin with 2-3 parallel tests
- **Monitor resource usage**: High concurrency can overwhelm system
- **Enable screenshots**: Always capture on failure for debugging
- **Retry flaky tests**: Use 1-2 retries for network-dependent tests
- **Review logs**: Check stdout/stderr for detailed error info

### Cookie Management

- **Export before clearing**: Always export before bulk operations
- **Validate domains**: Ensure domain matches application domain
- **Check SameSite**: Set appropriate SameSite for security
- **Use session cookies for testing**: Prefer session cookies (expires: -1)
- **Sanitize production cookies**: Remove sensitive tokens before sharing

## Troubleshooting

### Recording Issues

**Problem**: Actions not being recorded
- **Solution**: Ensure browser session is active
- **Solution**: Check that recording started (status indicator shows "Recording")
- **Solution**: Refresh preview and start new recording

**Problem**: Wrong selectors captured
- **Solution**: Use manual selector override
- **Solution**: Add custom assertions with specific selectors
- **Solution**: Edit generated code to use better selectors

### Test Execution Issues

**Problem**: Tests fail with "Element not found"
- **Solution**: Add explicit waits before interactions
- **Solution**: Increase timeout values
- **Solution**: Verify selector is correct and unique

**Problem**: Tests timeout
- **Solution**: Increase test timeout in configuration
- **Solution**: Check network conditions
- **Solution**: Verify application is running and accessible

**Problem**: Parallel tests interfere with each other
- **Solution**: Reduce concurrency
- **Solution**: Use isolated browser contexts
- **Solution**: Clear state between tests

### Cookie Issues

**Problem**: Cookies not persisting
- **Solution**: Check domain matches exactly (include/exclude www)
- **Solution**: Set proper path (usually `/`)
- **Solution**: Ensure SameSite is compatible

**Problem**: Import fails
- **Solution**: Validate JSON format
- **Solution**: Check cookie attributes are complete
- **Solution**: Ensure domain/path are valid

## Architecture Notes

### Component Structure

```
frontend/src/components/browser/automation/
├── RecorderPanel.jsx      # Main recording UI
├── ActionList.jsx         # Action display component
├── CodeGenerator.jsx      # Code generation UI
├── TestRunner.jsx         # Test execution UI
├── TestResults.jsx        # Results display
├── CookieManager.jsx      # Cookie management UI
└── index.js              # Exports
```

### State Management

- **Local component state**: Each modal manages its own state
- **No global state**: Modals are independent
- **Parent communication**: Via `onClose` callback
- **API polling**: Real-time updates via periodic fetch
- **WebSocket**: Test run updates streamed live

### Styling

- **Inline CSS-in-JS**: Scoped styles using `<style jsx>`
- **CSS variables**: Respects Terminal V4 theme variables
- **Responsive**: Works on desktop and mobile
- **Dark mode**: Uses dark color scheme
- **Consistent**: Matches existing Terminal V4 UI patterns

### Performance

- **Code splitting**: Modals only loaded when opened
- **Lazy rendering**: Large lists virtualized
- **Debounced search**: Filter input debounced
- **Optimistic updates**: UI updates before API response
- **Cached results**: Test results cached locally

## Future Enhancements

- **Visual regression testing**: Screenshot comparison
- **Test scheduling**: Cron-based test execution
- **CI/CD integration**: Export to GitHub Actions/GitLab CI
- **Test analytics**: Trend analysis and reporting
- **AI-assisted selectors**: Suggest better selectors
- **Network recording**: Capture and replay network requests
- **Video recording**: Record entire test execution
- **Test marketplace**: Share and import community tests

## Support

For issues or questions:
1. Check this guide first
2. Review API documentation in `backend/src/routes/browser-routes.ts`
3. Check browser console for errors
4. Verify backend is running (`/api/browser/status`)
5. Check backend logs (`/tmp/backend.log`)

## Version

- **Version**: 1.0.0
- **Date**: 2026-01-20
- **Phase**: 6 - Automation
- **Status**: Production Ready
