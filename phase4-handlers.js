// Phase 4: Device Presets Handler
const handleDeviceSelect = useCallback((device) => {
  setSelectedDevice(device);
  setShowDevicePresets(false);

  // Inject viewport meta tag and user agent override into iframe
  if (iframeRef.current && iframeRef.current.contentWindow) {
    try {
      const iframe = iframeRef.current;
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

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
        Object.defineProperty(iframe.contentWindow.navigator, 'userAgent', {
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
