// ============================================================================
// PHASE 4 INTEGRATION - Complete Code Snippets for PreviewPanel.jsx
// ============================================================================
// This file contains all the code needed to complete Phase 4 integration.
// Follow the instructions for each section.
// ============================================================================

// ----------------------------------------------------------------------------
// SECTION 1: State Variables
// ----------------------------------------------------------------------------
// INSERT AFTER: const [showPortDropdown, setShowPortDropdown] = useState(false);
// LOCATION: Around line 115

  // Phase 4: Advanced Testing Features state
  const [showDevicePresets, setShowDevicePresets] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [showVisualDiff, setShowVisualDiff] = useState(false);
  const [visualDiffResult, setVisualDiffResult] = useState(null);
  const [showSessionSwitcher, setShowSessionSwitcher] = useState(false);

// ----------------------------------------------------------------------------
// SECTION 2: Handler Functions
// ----------------------------------------------------------------------------
// INSERT AFTER: const handleOpenExternal = useCallback(() => { ... }, [baseIframeSrc, iframeSrc]);
// LOCATION: Around line 797

  // Phase 4: Device Presets Handlers
  const handleDeviceSelect = useCallback((device) => {
    setSelectedDevice(device);
    setShowDevicePresets(false);

    // Apply device viewport via CSS transform to iframe wrapper
    if (iframeRef.current) {
      const iframeWrapper = iframeRef.current.parentElement;
      if (iframeWrapper) {
        // Calculate scale to fit device in viewport
        const scale = Math.min(
          iframeWrapper.clientWidth / device.width,
          iframeWrapper.clientHeight / device.height,
          1
        );

        iframeWrapper.style.width = `${device.width}px`;
        iframeWrapper.style.height = `${device.height}px`;
        iframeWrapper.style.transform = `scale(${scale})`;
        iframeWrapper.style.transformOrigin = 'top left';
        iframeWrapper.style.margin = '0 auto';
      }
    }

    // Inject viewport meta tag into iframe
    if (iframeRef.current && iframeRef.current.contentWindow) {
      try {
        const iframeDoc = iframeRef.current.contentDocument || iframeRef.current.contentWindow.document;

        // Inject or update viewport meta tag
        let viewportMeta = iframeDoc.querySelector('meta[name="viewport"]');
        if (!viewportMeta) {
          viewportMeta = iframeDoc.createElement('meta');
          viewportMeta.setAttribute('name', 'viewport');
          iframeDoc.head.appendChild(viewportMeta);
        }
        viewportMeta.setAttribute('content', `width=${device.width}, initial-scale=${1 / (device.pixelRatio || 1)}`);

        // Override user agent if provided
        if (device.userAgent) {
          try {
            Object.defineProperty(iframeRef.current.contentWindow.navigator, 'userAgent', {
              get: () => device.userAgent,
              configurable: true
            });
          } catch (uaErr) {
            console.warn('Could not override user agent:', uaErr);
          }
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
        iframeWrapper.style.margin = '';
      }
    }
  }, []);

  // Phase 4: Visual Regression Testing Handlers
  const handleVisualTest = useCallback(async () => {
    if (!previewPort) {
      alert('No preview port detected');
      return;
    }

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
    if (!previewPort) {
      alert('No preview port detected');
      return;
    }

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

// ----------------------------------------------------------------------------
// SECTION 3: Toolbar Buttons
// ----------------------------------------------------------------------------
// INSERT IN: <div className="preview-actions"> section
// LOCATION: Around line 1960, before the close preview button
// ADD THESE BUTTONS:

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

// ----------------------------------------------------------------------------
// SECTION 4: Modal Components
// ----------------------------------------------------------------------------
// INSERT BEFORE: The final closing tags of the component's return statement
// LOCATION: Near the end of the component, before </div> or fragment close
// ADD THESE MODALS:

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

// ============================================================================
// END OF PHASE 4 INTEGRATION CODE
// ============================================================================
