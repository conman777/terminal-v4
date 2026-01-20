# DevTools Quick Start Guide

Get DevTools up and running in 5 minutes.

## Step 1: Install Dependencies

```bash
cd frontend
npm install react-window
```

## Step 2: Test the Example

Create a test page to see DevTools in action:

```javascript
// frontend/src/pages/DevToolsDemo.jsx
import { DevToolsExample } from '../components/devtools/DevToolsExample';

export function DevToolsDemo() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <DevToolsExample />
    </div>
  );
}
```

Add route in your router:
```javascript
<Route path="/devtools-demo" element={<DevToolsDemo />} />
```

Visit: `http://localhost:5173/devtools-demo`

## Step 3: View Documentation

- **Integration Guide:** `DEVTOOLS_INTEGRATION.md` - Full integration steps
- **Implementation Summary:** `DEVTOOLS_SUMMARY.md` - What was built

## Step 4: Run Tests

```bash
cd frontend

# Unit tests
npm test NetworkTab.test.jsx
npm test ConsoleTab.test.jsx
npm test StorageTab.test.jsx

# E2E tests (after integration)
npm run test:e2e devtools.spec.ts
```

## Quick Integration Example

Minimal integration into PreviewPanel:

```javascript
// In PreviewPanel.jsx
import { DevToolsPanel } from './devtools/DevToolsPanel';
import '../devtools.css';

// Add state
const [showDevTools, setShowDevTools] = useState(false);
const [storageData, setStorageData] = useState({
  localStorage: {},
  sessionStorage: {},
  cookies: {}
});

// Add handlers
const handleUpdateStorage = useCallback(async (type, operation, key, value) => {
  // Send to iframe
  if (iframeRef.current?.contentWindow) {
    iframeRef.current.contentWindow.postMessage({
      type: 'preview-storage-operation',
      storageType: type,
      operation,
      key,
      value
    }, '*');
  }
}, []);

const handleEvaluate = useCallback(async (expression) => {
  if (iframeRef.current?.contentWindow) {
    iframeRef.current.contentWindow.postMessage({
      type: 'preview-evaluate',
      expression
    }, '*');
  }
}, []);

// Add toggle button
<button onClick={() => setShowDevTools(!showDevTools)}>
  🛠️ DevTools
</button>

// Render DevTools
{showDevTools && (
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
)}
```

## File Structure

```
frontend/src/
├── components/devtools/
│   ├── DevToolsPanel.jsx          # Main container
│   ├── NetworkTab.jsx             # Network monitoring
│   ├── ConsoleTab.jsx             # Console logs
│   ├── StorageTab.jsx             # Storage inspector
│   ├── DevToolsExample.jsx        # Standalone demo
│   ├── shared/
│   │   ├── FilterBar.jsx
│   │   ├── JsonTreeView.jsx
│   │   └── LogViewer.jsx
│   └── __tests__/
│       ├── NetworkTab.test.jsx
│       ├── ConsoleTab.test.jsx
│       └── StorageTab.test.jsx
├── devtools.css                   # Styles
└── ...

backend/src/routes/
└── preview-api-routes.ts          # Backend endpoints (modified)

frontend/e2e/
└── devtools.spec.ts               # E2E tests
```

## Key Features

### Network Tab
- Request/response inspection
- HAR export
- Copy as cURL/fetch/Axios
- Filter by type (XHR, JS, CSS, Images)
- Color-coded status

### Console Tab
- Log levels with icons
- Virtual scrolling (10K+ logs)
- REPL with history
- JSON object expansion
- Stack trace viewer

### Storage Tab
- LocalStorage/SessionStorage/Cookies
- Add/Edit/Delete operations
- Import/Export JSON
- Search and filter

## Performance

- ✅ Network: 1000+ requests
- ✅ Console: 10K+ logs
- ✅ Storage: Instant CRUD
- ✅ Virtual scrolling for efficiency

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge). Requires ES2020+ support.

## Troubleshooting

**Import errors:**
- Make sure `react-window` is installed: `npm install react-window`
- Import CSS: `import '../devtools.css'` or add to main.jsx

**TypeScript errors in backend:**
- Backend endpoints use proper TypeScript types
- Run `npm run build` in backend to verify

**Tests failing:**
- Install test dependencies: `npm install --save-dev @testing-library/react`
- Run `npm test` to see specific errors

## Next Steps

1. View the standalone example at `/devtools-demo`
2. Read `DEVTOOLS_INTEGRATION.md` for full integration
3. Run tests to verify everything works
4. Integrate into PreviewPanel following the guide

## Support

- Check `DEVTOOLS_INTEGRATION.md` for detailed integration steps
- See `DEVTOOLS_SUMMARY.md` for implementation details
- Review test files for usage examples
