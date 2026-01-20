# Phase 6 Automation UI - Quick Reference

## Component Imports

```javascript
// Import individual components
import { RecorderPanel } from './components/browser/automation/RecorderPanel';
import { TestRunner } from './components/browser/automation/TestRunner';
import { CookieManager } from './components/browser/automation/CookieManager';

// Or import all at once
import { RecorderPanel, TestRunner, CookieManager } from './components/browser/automation';
```

## Component Usage

### RecorderPanel

```jsx
<RecorderPanel onClose={() => setShowRecorder(false)} />
```

**Props**:
- `onClose: () => void` - Callback when modal closes

**State Management**:
- Manages recording session internally
- Polls for actions every 1s while recording
- Transitions to CodeGenerator on "Generate Code"

### TestRunner

```jsx
<TestRunner onClose={() => setShowTests(false)} />
```

**Props**:
- `onClose: () => void` - Callback when modal closes

**State Management**:
- Loads test list from recording sessions
- Manages WebSocket connection for updates
- Transitions to TestResults on test execution

### CookieManager

```jsx
<CookieManager onClose={() => setShowCookies(false)} />
```

**Props**:
- `onClose: () => void` - Callback when modal closes

**State Management**:
- Fetches cookies on mount
- Manages search and filter state
- Handles form modal state

## API Endpoints

### Recording

```typescript
// Start recording
POST /api/browser/recorder/start
Response: { success: boolean, recording: RecordingSession }

// Stop recording
POST /api/browser/recorder/stop
Body: { recordingId: string }
Response: { success: boolean, recording: RecordingSession }

// Get actions
GET /api/browser/recorder/actions/:sessionId
Response: { recording: RecordingSession }

// Add assertion
POST /api/browser/recorder/assertion
Body: { recordingId: string, type: string, selector: string, expected?: any }
Response: { success: boolean }

// Generate code
POST /api/browser/recorder/generate
Body: { recordingId: string, framework: string, language: string, testFramework?: string }
Response: { success: boolean, code: string }
```

### Test Execution

```typescript
// Run tests
POST /api/browser/tests/run
Body: {
  tests: Array<{ name: string, code: string, framework: string }>,
  maxRetries?: number,
  captureScreenshotOnFailure?: boolean
}
Response: { success: boolean, run: TestRun }

// Get test run status
GET /api/browser/tests/status/:runId
Response: { run: TestRun }

// Get test job result
GET /api/browser/tests/result/:jobId
Response: { job: TestJob }

// WebSocket updates
WS /api/browser/tests/stream?runId=X
Message: { type: 'update', data: TestRun }
```

### Cookie Management

```typescript
// Get all cookies
GET /api/browser/cookies
Response: { count: number, cookies: Cookie[] }

// Set cookie
POST /api/browser/cookies
Body: { cookie: Cookie }
Response: { success: boolean }

// Delete cookie
DELETE /api/browser/cookies/:name
Response: { success: boolean, message: string }

// Export cookies
GET /api/browser/cookies/export
Response: JSON file download

// Import cookies
POST /api/browser/cookies/import
Body: { json: string }
Response: { success: boolean, imported: number }
```

## Type Definitions

### RecordingSession

```typescript
interface RecordingSession {
  id: string;
  sessionId: string;
  status: 'recording' | 'stopped' | 'paused';
  startTime: number;
  endTime?: number;
  actions: Action[];
}
```

### Action

```typescript
interface Action {
  type: 'goto' | 'click' | 'type' | 'fill' | 'select' | 'scroll' | 'hover' | 'wait' | 'assertion';
  timestamp: number;
  selector?: string;
  url?: string;
  text?: string;
  value?: any;
  timeout?: number;
  assertionType?: 'visible' | 'hidden' | 'text' | 'value' | 'count';
  expected?: any;
  waitType?: 'selector' | 'navigation' | 'timeout';
  waitState?: 'attached' | 'detached' | 'visible' | 'hidden';
}
```

### TestRun

```typescript
interface TestRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  startTime: number;
  endTime?: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    running: number;
  };
  jobs: TestJob[];
}
```

### TestJob

```typescript
interface TestJob {
  id: string;
  name: string;
  framework: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startTime?: number;
  endTime?: number;
  duration?: number;
  error?: string;
  logs?: string[];
  screenshot?: Buffer;
}
```

### Cookie

```typescript
interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // -1 for session
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}
```

## Styling

### CSS Variables

```css
/* Theme colors */
--bg-primary: #1e1e1e
--bg-secondary: #252525
--bg-hover: #2a2a2a
--text-primary: #d4d4d4
--text-secondary: #999
--text-tertiary: #666
--border-color: #3a3a3a

/* Status colors */
--color-primary: #3b82f6
--color-success: #10b981
--color-danger: #ef4444
--color-warning: #f59e0b
```

### Common Classes

```css
.btn-primary {
  background: #3b82f6;
  color: white;
  padding: 8px 16px;
  border-radius: 6px;
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.btn-danger {
  background: #ef4444;
  color: white;
}

.status-badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
```

## Common Patterns

### Modal Overlay

```jsx
<div className="modal-overlay" onClick={(e) => e.target.className === 'modal-overlay' && onClose()}>
  <div className="modal" onClick={(e) => e.stopPropagation()}>
    {/* Content */}
  </div>
</div>
```

### Error Display

```jsx
{error && (
  <div className="error-banner">
    {error}
    <button onClick={() => setError(null)}>×</button>
  </div>
)}
```

### Loading State

```jsx
{loading ? (
  <div className="loading">Loading...</div>
) : (
  <div>{content}</div>
)}
```

### Empty State

```jsx
{items.length === 0 ? (
  <div className="empty-state">
    <p>No items found</p>
  </div>
) : (
  <div>{items.map(...)}</div>
)}
```

## Keyboard Shortcuts

Currently supported in Preview Panel:
- `⌘/Ctrl + I` - Toggle inspect mode
- `⌘/Ctrl + K` - Toggle terminal split
- `⌘/Ctrl + ⇧ + D` - Toggle DevTools
- `⌘/Ctrl + R` - Refresh preview
- `Esc` - Close inspector/logs

Automation shortcuts (planned):
- `⌘/Ctrl + ⇧ + R` - Toggle recorder
- `⌘/Ctrl + ⇧ + T` - Open tests
- `⌘/Ctrl + ⇧ + C` - Open cookies

## Error Handling

### Standard Pattern

```javascript
try {
  const response = await apiFetch('/api/endpoint');
  // Handle success
  setData(response.data);
  setError(null);
} catch (err) {
  // Handle error
  setError(err.message || 'Operation failed');
  console.error('Operation failed:', err);
}
```

### User-Friendly Messages

```javascript
// Bad
setError(err.toString());

// Good
setError(err.message || 'Failed to load cookies');
```

## Best Practices

### 1. State Management

```javascript
// Use functional updates for derived state
setCount(prev => prev + 1);

// Don't mutate state directly
// Bad: items.push(newItem);
// Good: setItems([...items, newItem]);
```

### 2. API Calls

```javascript
// Always handle loading and error states
const [loading, setLoading] = useState(false);
const [error, setError] = useState(null);

const loadData = async () => {
  setLoading(true);
  setError(null);
  try {
    const data = await apiFetch('/api/data');
    setData(data);
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
};
```

### 3. Cleanup

```javascript
// Always cleanup timers and listeners
useEffect(() => {
  const interval = setInterval(fetchData, 1000);
  return () => clearInterval(interval);
}, []);
```

### 4. WebSocket

```javascript
// Store in ref, cleanup on unmount
const wsRef = useRef(null);

useEffect(() => {
  wsRef.current = new WebSocket(url);
  wsRef.current.onmessage = handleMessage;

  return () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  };
}, []);
```

## Debugging

### Enable Verbose Logging

```javascript
// In component
useEffect(() => {
  console.log('[RecorderPanel] State:', { isRecording, actions });
}, [isRecording, actions]);
```

### Check API Responses

```javascript
const response = await apiFetch('/api/endpoint');
console.log('[API Response]', response);
```

### Monitor WebSocket

```javascript
wsRef.current.onopen = () => console.log('[WS] Connected');
wsRef.current.onclose = () => console.log('[WS] Disconnected');
wsRef.current.onerror = (err) => console.error('[WS] Error:', err);
wsRef.current.onmessage = (msg) => console.log('[WS] Message:', msg.data);
```

## Performance Tips

### 1. Memoization

```javascript
// Memoize expensive computations
const filteredItems = useMemo(() => {
  return items.filter(item => item.name.includes(search));
}, [items, search]);
```

### 2. Debouncing

```javascript
// Debounce search input
const [search, setSearch] = useState('');
const debouncedSearch = useDebounce(search, 300);

useEffect(() => {
  fetchResults(debouncedSearch);
}, [debouncedSearch]);
```

### 3. Virtualization

For large lists (100+ items), consider virtualization:

```javascript
// Use react-window or similar
import { FixedSizeList } from 'react-window';

<FixedSizeList
  height={400}
  itemCount={items.length}
  itemSize={50}
>
  {Row}
</FixedSizeList>
```

## Common Issues

### Issue: Modal doesn't close on overlay click

**Solution**: Check event propagation

```javascript
// Correct pattern
onClick={(e) => e.target.className === 'modal-overlay' && onClose()}

// In modal content
onClick={(e) => e.stopPropagation()}
```

### Issue: State not updating

**Solution**: Check if you're mutating state

```javascript
// Bad
items.push(newItem);
setItems(items);

// Good
setItems([...items, newItem]);
```

### Issue: Component re-renders too much

**Solution**: Memoize callbacks

```javascript
const handleClick = useCallback(() => {
  // Handle click
}, [dependencies]);
```

## File Locations

```
Component Files:
- frontend/src/components/browser/automation/RecorderPanel.jsx
- frontend/src/components/browser/automation/ActionList.jsx
- frontend/src/components/browser/automation/CodeGenerator.jsx
- frontend/src/components/browser/automation/TestRunner.jsx
- frontend/src/components/browser/automation/TestResults.jsx
- frontend/src/components/browser/automation/CookieManager.jsx

Integration:
- frontend/src/components/PreviewPanel.jsx (lines 8-10, 116-119, 2072-2723)
- frontend/src/components/preview/PreviewToolbar.jsx (lines 26-29, 92-135)

Backend:
- backend/src/routes/browser-routes.ts
- backend/src/browser/recorder-service.ts
- backend/src/browser/test-runner-service.ts
- backend/src/browser/cookie-service.ts

Documentation:
- docs/AUTOMATION_UI_GUIDE.md
- PHASE6_UI_IMPLEMENTATION_SUMMARY.md
- PHASE6_UI_QUICKREF.md (this file)
```

## Quick Commands

```bash
# Build frontend
cd frontend && npm run build

# Build backend
cd backend && npm run build

# Restart server
./restart.sh

# View logs
tail -f /tmp/backend.log

# Check running processes
ps aux | grep node
```

---

**Version**: 1.0.0
**Last Updated**: 2026-01-20
