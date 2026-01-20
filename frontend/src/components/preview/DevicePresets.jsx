import { useState } from 'react';
import { getDevicePresetsByType, rotateDeviceDimensions, validateDeviceDimensions } from '../../utils/device-presets';

export function DevicePresets({ onDeviceSelect, onClose }) {
  const [customWidth, setCustomWidth] = useState('');
  const [customHeight, setCustomHeight] = useState('');
  const [customError, setCustomError] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const devicesByType = getDevicePresetsByType();

  const handlePresetSelect = (device) => {
    onDeviceSelect({
      width: device.width,
      height: device.height,
      pixelRatio: device.pixelRatio,
      userAgent: device.userAgent,
      touch: device.touch,
      name: device.name
    });
  };

  const handleRotate = (device) => {
    const rotated = rotateDeviceDimensions(device);
    onDeviceSelect({
      width: rotated.width,
      height: rotated.height,
      pixelRatio: device.pixelRatio,
      userAgent: device.userAgent,
      touch: device.touch,
      name: `${device.name} (Landscape)`
    });
  };

  const handleCustomApply = () => {
    const width = parseInt(customWidth, 10);
    const height = parseInt(customHeight, 10);

    // Check for NaN first
    if (isNaN(width) || isNaN(height)) {
      setCustomError('Width and height must be valid numbers');
      return;
    }

    // Now validate
    const validation = validateDeviceDimensions(width, height);
    if (!validation.valid) {
      setCustomError(validation.error);
      return;
    }

    // Apply custom device
    onDeviceSelect({
      width,
      height,
      pixelRatio: 1,
      userAgent: null,
      touch: false,
      name: `Custom ${width}x${height}`
    });
    setShowCustom(false);
    setCustomError('');
  };

  return (
    <div className="device-presets-modal">
      <div className="device-presets-header">
        <h3>Device Presets</h3>
        <button className="close-button" onClick={onClose} title="Close">×</button>
      </div>

      <div className="device-presets-content">
        <div className="device-presets-section">
          <h4>Mobile</h4>
          <div className="device-list">
            {devicesByType.mobile.map(device => (
              <div key={device.id} className="device-item">
                <button
                  className="device-button"
                  onClick={() => handlePresetSelect(device)}
                  title={`${device.width}x${device.height} @ ${device.pixelRatio}x DPR`}
                >
                  <span className="device-name">{device.name}</span>
                  <span className="device-dimensions">{device.width}×{device.height}</span>
                </button>
                <button
                  className="device-rotate-button"
                  onClick={() => handleRotate(device)}
                  title="Rotate to landscape"
                >
                  ↻
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="device-presets-section">
          <h4>Tablet</h4>
          <div className="device-list">
            {devicesByType.tablet.map(device => (
              <div key={device.id} className="device-item">
                <button
                  className="device-button"
                  onClick={() => handlePresetSelect(device)}
                  title={`${device.width}x${device.height} @ ${device.pixelRatio}x DPR`}
                >
                  <span className="device-name">{device.name}</span>
                  <span className="device-dimensions">{device.width}×{device.height}</span>
                </button>
                <button
                  className="device-rotate-button"
                  onClick={() => handleRotate(device)}
                  title="Rotate to landscape"
                >
                  ↻
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="device-presets-section">
          <h4>Desktop</h4>
          <div className="device-list">
            {devicesByType.desktop.map(device => (
              <div key={device.id} className="device-item">
                <button
                  className="device-button"
                  onClick={() => handlePresetSelect(device)}
                  title={`${device.width}x${device.height} @ ${device.pixelRatio}x DPR`}
                >
                  <span className="device-name">{device.name}</span>
                  <span className="device-dimensions">{device.width}×{device.height}</span>
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="device-presets-section">
          <h4>Custom</h4>
          <button
            className="custom-toggle-button"
            onClick={() => setShowCustom(!showCustom)}
          >
            {showCustom ? 'Hide' : 'Show'} Custom Dimensions
          </button>

          {showCustom && (
            <div className="custom-device-form">
              <div className="custom-input-group">
                <label>
                  Width:
                  <input
                    type="number"
                    value={customWidth}
                    onChange={(e) => setCustomWidth(e.target.value)}
                    placeholder="e.g. 1920"
                    min="320"
                    max="4096"
                  />
                </label>
                <label>
                  Height:
                  <input
                    type="number"
                    value={customHeight}
                    onChange={(e) => setCustomHeight(e.target.value)}
                    placeholder="e.g. 1080"
                    min="320"
                    max="4096"
                  />
                </label>
              </div>
              {customError && <div className="custom-error">{customError}</div>}
              <button
                className="custom-apply-button"
                onClick={handleCustomApply}
                disabled={!customWidth || !customHeight}
              >
                Apply Custom Size
              </button>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .device-presets-modal {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
          max-width: 600px;
          max-height: 80vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          z-index: 10000;
        }

        .device-presets-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .device-presets-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-primary, #d4d4d4);
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
        }

        .device-presets-content {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
        }

        .device-presets-section {
          margin-bottom: 24px;
        }

        .device-presets-section h4 {
          margin: 0 0 12px 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-secondary, #999);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .device-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .device-item {
          display: flex;
          gap: 8px;
        }

        .device-button {
          flex: 1;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          background: var(--bg-secondary, #2a2a2a);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          cursor: pointer;
          font-size: 14px;
          text-align: left;
          transition: all 0.2s;
        }

        .device-button:hover {
          background: var(--bg-hover, #333);
          border-color: var(--accent-color, #007acc);
        }

        .device-name {
          font-weight: 500;
        }

        .device-dimensions {
          color: var(--text-secondary, #999);
          font-size: 12px;
          font-family: 'Courier New', monospace;
        }

        .device-rotate-button {
          padding: 10px 16px;
          background: var(--bg-secondary, #2a2a2a);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          cursor: pointer;
          font-size: 18px;
          transition: all 0.2s;
        }

        .device-rotate-button:hover {
          background: var(--bg-hover, #333);
          transform: rotate(90deg);
        }

        .custom-toggle-button {
          padding: 10px 16px;
          background: var(--bg-secondary, #2a2a2a);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          cursor: pointer;
          font-size: 14px;
          width: 100%;
        }

        .custom-toggle-button:hover {
          background: var(--bg-hover, #333);
        }

        .custom-device-form {
          margin-top: 12px;
          padding: 12px;
          background: var(--bg-secondary, #2a2a2a);
          border-radius: 4px;
        }

        .custom-input-group {
          display: flex;
          gap: 12px;
          margin-bottom: 12px;
        }

        .custom-input-group label {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 6px;
          font-size: 12px;
          font-weight: 500;
        }

        .custom-input-group input {
          padding: 8px;
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          font-size: 14px;
        }

        .custom-error {
          padding: 8px;
          background: rgba(255, 0, 0, 0.1);
          border: 1px solid rgba(255, 0, 0, 0.3);
          border-radius: 4px;
          color: #ff6b6b;
          font-size: 12px;
          margin-bottom: 12px;
        }

        .custom-apply-button {
          padding: 10px 16px;
          background: var(--accent-color, #007acc);
          border: none;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          width: 100%;
        }

        .custom-apply-button:hover:not(:disabled) {
          background: var(--accent-hover, #0066b3);
        }

        .custom-apply-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
