# DevTools Integration Guide

This document describes the new DevTools system for Terminal V4's preview panel.

## Overview

The DevTools system provides browser-like developer tools for inspecting and debugging previewed applications:

- **Network Tab**: HTTP request/response inspection with HAR export
- **Console Tab**: JavaScript console logs with REPL evaluation
- **Storage Tab**: LocalStorage/SessionStorage/Cookies management

## Architecture

### Frontend Components

```
frontend/src/components/devtools/
├── DevToolsPanel.jsx          # Main tab container
├── NetworkTab.jsx             # Network monitoring
├── ConsoleTab.jsx             # Console logs with virtualization
├── StorageTab.jsx             # Storage inspection/editing
└── shared/
    ├── FilterBar.jsx          # Reusable filter component
    ├── JsonTreeView.jsx       # Collapsible JSON viewer
    └── LogViewer.jsx          # Virtualized log list (react-window)
```

### Backend Endpoints

Added to `backend/src/routes/preview-api-routes.ts`:

- `POST /api/preview/:port/evaluate` - Execute JavaScript in preview context (REPL)
- `GET /api/preview/:port/storage` - Request storage snapshot
- `POST /api/preview/:port/storage` - Update storage (set/remove/clear operations)

Existing endpoints used:
- `GET /api/preview/:port/proxy-logs` - Fetch network requests (server-side proxy logs)
- `DELETE /api/preview/:port/proxy-logs` - Clear network logs
- `GET /api/preview/:port/cookies` - Get cookies for port
- `DELETE /api/preview/:port/cookies` - Clear cookies for port

### CSS Styles

- `frontend/src/devtools.css` - Complete DevTools styling

Import in your main styles or App component:
```javascript
import './devtools.css';
```

## Integration into PreviewPanel

### Step 1: Import DevTools Components

```javascript
import { DevToolsPanel } from './devtools/DevToolsPanel';
import '../devtools.css';
```

### Step 2: Add State for DevTools Toggle

```javascript
const [showDevTools, setShowDevTools] = useState(false);
```

### Step 3: Implement Storage Operations

```javascript
const handleUpdateStorage = useCallback(async (storageType, operation, key, value) => {
  if (!previewPort) return;

  try {
    await apiFetch(`/api/preview/${previewPort}/storage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: storageType, operation, key, value })
    });

    // Send message to iframe to execute operation
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'preview-storage-operation',
        storageType,
        operation,
        key,
        value
      }, '*');
    }
  } catch (error) {
    console.error('Storage operation failed:', error);
  }
}, [previewPort]);
```

### Step 4: Implement Console Evaluation

```javascript
const handleEvaluate = useCallback(async (expression) => {
  if (!previewPort) return;

  try {
    // Send evaluation request to preview iframe
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'preview-evaluate',
        expression
      }, '*');
    }

    // Also send to backend for logging
    await apiFetch(`/api/preview/${previewPort}/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression })
    });
  } catch (error) {
    console.error('Evaluation failed:', error);
  }
}, [previewPort]);
```

### Step 5: Track Storage State

```javascript
const [storageData, setStorageData] = useState({
  localStorage: {},
  sessionStorage: {},
  cookies: {}
});

// Listen for storage sync messages from preview iframe
useEffect(() => {
  const handleMessage = (event) => {
    if (event.data?.type === 'preview-storage-sync') {
      const { port, local, session } = event.data;
      if (port === previewPort) {
        setStorageData(prev => ({
          ...prev,
          localStorage: local || {},
          sessionStorage: session || {}
        }));
      }
    }
  };
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}, [previewPort]);
```

### Step 6: Add DevTools UI Toggle

Add a button to toggle DevTools display:

```javascript
<button
  onClick={() => setShowDevTools(!showDevTools)}
  className="preview-devtools-toggle"
  title="Toggle DevTools"
>
  🛠️ DevTools
</button>
```

### Step 7: Render DevTools Panel

Replace or augment the existing logs panel:

```javascript
{showDevTools ? (
  <DevToolsPanel
    networkRequests={proxyLogs}
    consoleLogs={logs}
    storage={storageData}
    previewPort={previewPort}
    onClearNetwork={handleClearProxyLogs}
    onClearConsole={handleClearLogs}
    onUpdateStorage={handleUpdateStorage}
    onEvaluate={handleEvaluate}
  />
) : (
  // Existing logs panel...
)}
```

## Client-Side Script Updates

The preview debug script (`PREVIEW_DEBUG_SCRIPT` in `preview-subdomain-routes.ts`) needs to handle new message types:

### Storage Operations

```javascript
window.addEventListener('message', function(event) {
  if (event.data?.type === 'preview-storage-operation') {
    const { storageType, operation, key, value } = event.data;
    const storage = storageType === 'localStorage' ? localStorage : sessionStorage;

    if (operation === 'set' && key) {
      storage.setItem(key, value);
    } else if (operation === 'remove' && key) {
      storage.removeItem(key);
    } else if (operation === 'clear') {
      storage.clear();
    }

    // Trigger storage sync
    scheduleStorageSync();
  }
});
```

### Console Evaluation

```javascript
window.addEventListener('message', function(event) {
  if (event.data?.type === 'preview-evaluate') {
    const { expression } = event.data;
    try {
      const result = eval(expression);
      queueLog({
        type: 'console',
        level: 'log',
        message: serialize([`> ${expression}`, result]),
        timestamp: Date.now()
      });
    } catch (error) {
      queueLog({
        type: 'console',
        level: 'error',
        message: `Evaluation error: ${error.message}`,
        stack: error.stack,
        timestamp: Date.now()
      });
    }
  }
});
```

## Features

### Network Tab

- **Request Table**: Method, URL, Status (color-coded), Type, Size, Time
- **Filters**: All, Fetch/XHR, JS, CSS, Images, Other
- **Search**: Filter by URL, method, or status
- **Details**: Headers (request/response), Request body, Response body, Timing
- **Export**: HAR format, Copy as cURL/fetch/Axios

### Console Tab

- **Log Levels**: log, warn, error, info, debug with icons
- **Object Expansion**: Collapsible JSON tree view for objects
- **Stack Traces**: Expandable error stack traces
- **Virtual Scrolling**: Efficient rendering of 10K+ logs using react-window
- **REPL**: Evaluate JavaScript expressions in preview context
- **History**: Navigate previous evaluations with ↑/↓ arrows

### Storage Tab

- **Tree View**: LocalStorage, SessionStorage, Cookies with counts
- **CRUD Operations**: Add, Edit, Delete storage items
- **Search**: Filter by key or value
- **Import/Export**: JSON format for backup/restore

## Testing

Unit tests are provided in `frontend/src/components/devtools/__tests__/`:

```bash
cd frontend
npm test NetworkTab.test.jsx
```

E2E tests should verify:
- Network request logging and filtering (1000+ requests)
- Console log rendering performance (10K+ logs)
- Storage CRUD operations
- REPL evaluation

## Performance Considerations

1. **Virtual Scrolling**: Console tab uses react-window for efficient rendering of large log lists
2. **Memoization**: Request filtering and log filtering use `useMemo` to avoid recomputation
3. **Debouncing**: Search inputs should debounce to reduce re-renders
4. **Log Limits**: Keep max 200 logs in memory, older logs are pruned

## Integration Status

### Phase 3: PreviewPanel Integration (COMPLETED)

**Date Completed**: 2026-01-20

The DevTools system has been fully integrated into PreviewPanel.jsx:

1. **Imports and CSS**: Added DevToolsPanel component import and devtools.css
2. **State Management**: Added `showDevTools` and `storageData` state variables
3. **Event Handlers**: Implemented `handleUpdateStorage`, `handleEvaluate`, and `handleClearProxyLogs`
4. **Storage Sync**: Updated `preview-storage-sync` message handler to populate DevTools storage state
5. **UI Integration**:
   - Added DevTools toggle button in desktop toolbar (with keyboard shortcut ⌘⇧D)
   - Replaced logs panel with conditional rendering: DevToolsPanel when `showDevTools` is true, legacy logs panel otherwise
6. **Data Wiring**:
   - Network Tab: Connected to `proxyLogs` state (server-side proxy requests)
   - Console Tab: Connected to `logs` state (client-side console logs from injected script)
   - Storage Tab: Connected to `storageData` state (localStorage/sessionStorage from iframe)

### Keyboard Shortcuts

- **⌘⇧D**: Toggle DevTools panel
- **⌘I**: Toggle inspect mode
- **⌘K**: Toggle terminal split view
- **⌘R**: Refresh preview

### Testing Checklist

- [ ] Load a preview page (e.g., localhost:3000)
- [ ] Toggle DevTools with button or ⌘⇧D
- [ ] **Network Tab**:
  - [ ] Verify network requests appear in table
  - [ ] Test request filtering (All, Fetch/XHR, JS, CSS, Images)
  - [ ] Test request details expansion (Headers, Request, Response, Timing)
  - [ ] Test HAR export
  - [ ] Test copy as cURL/fetch/Axios
  - [ ] Test with 1000+ requests for performance
- [ ] **Console Tab**:
  - [ ] Verify console logs appear from preview app
  - [ ] Test log level filtering (All, Error, Warn, Info, Log)
  - [ ] Test object expansion with JsonTreeView
  - [ ] Test REPL: evaluate `window.location.href` and verify result
  - [ ] Test code execution in preview context
  - [ ] Test virtual scrolling with 10K+ logs
- [ ] **Storage Tab**:
  - [ ] Verify localStorage items appear
  - [ ] Test adding new key/value pair
  - [ ] Test editing existing item
  - [ ] Test deleting item
  - [ ] Test clearing all storage
  - [ ] Test import/export JSON
  - [ ] Test sessionStorage operations
  - [ ] Test cookie operations

## Future Enhancements

- **Elements Tab**: DOM tree inspector with inline editing
- **Performance Tab**: Timing waterfall and metrics
- **Application Tab**: Service workers, manifests, cache storage
- **Sources Tab**: Source file viewer with breakpoints (requires CDP integration)
- **Network Throttling**: Simulate slow connections
- **Screenshot Capture**: Before/after comparison tools
