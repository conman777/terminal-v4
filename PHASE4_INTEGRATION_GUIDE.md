# Phase 4 Advanced Testing Features - Integration Guide

This guide explains how to integrate Phase 4 features (Device Presets, Visual Regression Testing, and Session Switcher) into PreviewPanel.jsx.

## Status

The file `/home/conor/terminal-v4/frontend/src/components/PreviewPanel.jsx` is being actively modified (possibly by a dev server or hot reload). This guide provides the changes needed once the file stabilizes.

## Prerequisites

All Phase 4 components already exist:
- `/home/conor/terminal-v4/frontend/src/components/preview/DevicePresets.jsx`
- `/home/conor/terminal-v4/frontend/src/components/browser/VisualDiffViewer.jsx`
- `/home/conor/terminal-v4/frontend/src/components/browser/SessionSwitcher.jsx`

## Step 1: Add Imports

At the top of `PreviewPanel.jsx`, after the existing imports, add:

```javascript
import { DevicePresets } from './preview/DevicePresets';
import { VisualDiffViewer } from './browser/VisualDiffViewer';
import { SessionSwitcher } from './browser/SessionSwitcher';
```

**Status:** ✓ DONE (imports added at lines 9-11)

## Step 2: Add State Variables

After the existing state variables (around line 113), add:

```javascript
// Phase 4: Advanced Testing Features state
const [showDevicePresets, setShowDevicePresets] = useState(false);
const [selectedDevice, setSelectedDevice] = useState(null);
const [showVisualDiff, setShowVisualDiff] = useState(false);
const [visualDiffResult, setVisualDiffResult] = useState(null);
const [showSessionSwitcher, setShowSessionSwitcher] = useState(false);
```

**Status:** ⏳ PENDING (file keeps changing, waiting for stability)

## Step 3: Add Handler Functions

After `handleOpenExternal` (around line 792), add the Phase 4 handlers from `/home/conor/terminal-v4/phase4-handlers.js`:

```javascript
// Phase 4: Device Presets Handler
const handleDeviceSelect = useCallback((device) => {
  setSelectedDevice(device);
  setShowDevicePresets(false);

  // Apply device viewport via CSS transform to iframe wrapper
  if (iframeRef.current) {
    const iframeWrapper = iframeRef.current.parentElement;
    if (iframeWrapper) {
      const scale = Math.min(
        iframeWrapper.clientWidth / device.width,
        iframeWrapper.clientHeight / device.height,
        1
      );

      iframeWrapper.style.width = `${device.width}px`;
      iframeWrapper.style.height = `${device.height}px`;
      iframeWrapper.style.transform = `scale(${scale})`;
      iframeWrapper.style.transformOrigin = 'top left';
    }
  }

  // Inject viewport meta tag into iframe
  if (iframeRef.current && iframeRef.current.contentWindow) {
    try {
      const iframeDoc = iframeRef.current.contentDocument || iframeRef.current.contentWindow.document;
      let viewportMeta = iframeDoc.querySelector('meta[name="viewport"]');
      if (!viewportMeta) {
        viewportMeta = iframeDoc.createElement('meta');
        viewportMeta.setAttribute('name', 'viewport');
        iframeDoc.head.appendChild(viewportMeta);
      }
      viewportMeta.setAttribute('content', `width=${device.width}, initial-scale=${1 / (device.pixelRatio || 1)}`);

      // Override user agent if provided
      if (device.userAgent) {
        Object.defineProperty(iframeRef.current.contentWindow.navigator, 'userAgent', {
          get: () => device.userAgent,
          configurable: true
        });
      }
    } catch (err) {
      console.warn('Could not modify iframe viewport:', err);
    }
  }
}, []);

const handleResetDevice = useCallback(() => {
  setSelectedDevice(null);

  // Reset iframe wrapper styles
  if (iframeRef.current) {
    const iframeWrapper = iframeRef.current.parentElement;
    if (iframeWrapper) {
      iframeWrapper.style.width = '';
      iframeWrapper.style.height = '';
      iframeWrapper.style.transform = '';
      iframeWrapper.style.transformOrigin = '';
    }
  }
}, []);

// Phase 4: Visual Regression Testing Handlers
const handleVisualTest = useCallback(async () => {
  if (!previewPort) return;

  try {
    const testName = `preview-${previewPort}`;
    const response = await apiFetch(`/api/browser/visual-test/${testName}`, {
      method: 'POST',
      body: JSON.stringify({
        url: iframeSrc,
        viewport: selectedDevice ? {
          width: selectedDevice.width,
          height: selectedDevice.height,
          deviceScaleFactor: selectedDevice.pixelRatio || 1
        } : undefined
      })
    });

    setVisualDiffResult(response);
    setShowVisualDiff(true);
  } catch (err) {
    console.error('Visual test failed:', err);
    alert(`Visual test failed: ${err.message}`);
  }
}, [previewPort, iframeSrc, selectedDevice]);

const handleSetBaseline = useCallback(async () => {
  if (!previewPort) return;

  try {
    const testName = `preview-${previewPort}`;
    await apiFetch(`/api/browser/visual-test/${testName}/baseline`, {
      method: 'POST',
      body: JSON.stringify({
        url: iframeSrc,
        viewport: selectedDevice ? {
          width: selectedDevice.width,
          height: selectedDevice.height,
          deviceScaleFactor: selectedDevice.pixelRatio || 1
        } : undefined
      })
    });

    alert('Baseline set successfully!');
  } catch (err) {
    console.error('Failed to set baseline:', err);
    alert(`Failed to set baseline: ${err.message}`);
  }
}, [previewPort, iframeSrc, selectedDevice]);

const handleAcceptBaseline = useCallback(async () => {
  if (!visualDiffResult || !previewPort) return;

  try {
    const testName = `preview-${previewPort}`;
    await apiFetch(`/api/browser/visual-test/${testName}/baseline`, {
      method: 'PUT'
    });

    setShowVisualDiff(false);
    setVisualDiffResult(null);
    alert('New baseline accepted!');
  } catch (err) {
    console.error('Failed to accept baseline:', err);
    alert(`Failed to accept baseline: ${err.message}`);
  }
}, [visualDiffResult, previewPort]);
```

**Status:** ⏳ PENDING

## Step 4: Add Toolbar Buttons

In the toolbar section (around line 1944, in the `<div className="preview-actions">` section), add these buttons:

```jsx
{/* Phase 4: Device Presets Button */}
<Tooltip text="Device presets" shortcut="⌘D">
  <button
    type="button"
    className={`preview-action-btn ${selectedDevice ? 'active' : ''}`}
    onClick={() => setShowDevicePresets(true)}
    disabled={!iframeSrc}
    aria-label="Device presets"
    title={selectedDevice ? `Device: ${selectedDevice.name}` : 'Select device preset'}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M12 18h.01" />
    </svg>
  </button>
</Tooltip>

{/* Reset Device Button (only show when device is selected) */}
{selectedDevice && (
  <Tooltip text="Reset to default viewport">
    <button
      type="button"
      className="preview-action-btn"
      onClick={handleResetDevice}
      aria-label="Reset device"
    >
      ↻
    </button>
  </Tooltip>
)}

{/* Phase 4: Visual Test Button */}
<Tooltip text="Visual regression test">
  <button
    type="button"
    className="preview-action-btn"
    onClick={handleVisualTest}
    disabled={!iframeSrc}
    aria-label="Visual test"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </button>
</Tooltip>

{/* Phase 4: Set Baseline Button */}
<Tooltip text="Set visual baseline">
  <button
    type="button"
    className="preview-action-btn"
    onClick={handleSetBaseline}
    disabled={!iframeSrc}
    aria-label="Set baseline"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  </button>
</Tooltip>

{/* Phase 4: Session Switcher Button */}
<Tooltip text="Browser sessions">
  <button
    type="button"
    className="preview-action-btn"
    onClick={() => setShowSessionSwitcher(true)}
    aria-label="Browser sessions"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  </button>
</Tooltip>
```

**Status:** ⏳ PENDING

## Step 5: Add Modal Components

At the end of the component's return statement, before the closing tags, add:

```jsx
{/* Phase 4: Device Presets Modal */}
{showDevicePresets && (
  <DevicePresets
    onDeviceSelect={handleDeviceSelect}
    onClose={() => setShowDevicePresets(false)}
  />
)}

{/* Phase 4: Visual Diff Viewer */}
{showVisualDiff && visualDiffResult && (
  <VisualDiffViewer
    comparisonResult={visualDiffResult}
    baselineImage={visualDiffResult.baselineImage}
    currentImage={visualDiffResult.currentImage}
    onClose={() => setShowVisualDiff(false)}
    onAcceptBaseline={handleAcceptBaseline}
  />
)}

{/* Phase 4: Session Switcher */}
{showSessionSwitcher && (
  <SessionSwitcher
    onClose={() => setShowSessionSwitcher(false)}
  />
)}
```

**Status:** ⏳ PENDING

## Step 6: Create Baseline Storage Directory

Run these commands to set up the baseline storage:

```bash
sudo mkdir -p /var/lib/terminal-v4/baselines
sudo chown -R $USER:$USER /var/lib/terminal-v4
chmod 755 /var/lib/terminal-v4/baselines
```

**Status:** ⏳ PENDING

## Step 7: Test the Integration

Once all changes are applied:

1. **Test Device Presets:**
   - Click the device preset button
   - Select iPhone 12 Pro
   - Verify iframe resizes to 390x844
   - Test rotation to landscape
   - Verify viewport meta tag injection
   - Test reset button

2. **Test Visual Regression:**
   - Click "Set Baseline" on a preview
   - Make a visual change to the app
   - Click "Visual Test"
   - Verify diff viewer shows differences
   - Test "Accept as New Baseline"
   - Verify baseline updates

3. **Test Session Switcher:**
   - Click "Browser Sessions" button
   - Create a new session
   - Switch between sessions
   - Verify session isolation (cookies, localStorage)
   - Close a session

## Notes

- The file is currently unstable due to active modifications (possibly from a dev server)
- All Phase 4 component files exist and are ready to use
- Handlers are saved in `/home/conor/terminal-v4/phase4-handlers.js` for reference
- Integration should be done when the file stabilizes

## Keyboard Shortcuts to Add

Consider adding these keyboard shortcuts in the keyboard handler:

- `⌘D` or `Ctrl+D`: Toggle device presets modal
- `⌘T` or `Ctrl+T`: Run visual test
- `⌘B` or `Ctrl+B`: Set baseline
- `⌘J` or `Ctrl+J`: Toggle session switcher

## CSS Additions Needed

Add to the PreviewPanel styles:

```css
.preview-action-btn.active {
  background: var(--accent-color, #007acc);
  color: white;
}

.preview-action-btn[title*="Device:"] {
  position: relative;
}

.preview-action-btn[title*="Device:"]::after {
  content: attr(data-device);
  position: absolute;
  bottom: -20px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  white-space: nowrap;
  background: var(--bg-secondary, #2a2a2a);
  padding: 2px 6px;
  border-radius: 3px;
}
```

## Troubleshooting

**Issue:** Viewport changes don't apply
- **Solution:** Ensure iframe has loaded before calling handleDeviceSelect
- **Solution:** Check browser console for CORS errors

**Issue:** Visual test fails with "baseline not found"
- **Solution:** Click "Set Baseline" first
- **Solution:** Verify /var/lib/terminal-v4/baselines directory exists

**Issue:** Session switcher shows "no sessions"
- **Solution:** Backend session management endpoints may need to be implemented
- **Solution:** Check /api/browser/sessions endpoint is working

## Next Steps

1. Wait for file to stabilize (stop dev server if needed)
2. Apply Steps 2-5 in order
3. Run Step 6 to create baseline directory
4. Test each feature individually (Step 7)
5. Fix any issues found during testing
6. Consider adding keyboard shortcuts
7. Update documentation with screenshots
