import { useState } from 'react';

export function VisualDiffViewer({ comparisonResult, baselineImage, currentImage, onClose, onAcceptBaseline }) {
  const [viewMode, setViewMode] = useState('sidebyside'); // 'sidebyside', 'diff', 'slider'
  const [sliderPosition, setSliderPosition] = useState(50);

  const { comparison, diffImage } = comparisonResult;
  const matches = comparison.matches;
  const percentDiff = comparison.percentDifferent.toFixed(2);

  return (
    <div className="visual-diff-viewer">
      <div className="visual-diff-header">
        <h3>Visual Regression Test: {comparison.name}</h3>
        <div className="visual-diff-status">
          <span className={`status-badge ${matches ? 'pass' : 'fail'}`}>
            {matches ? 'PASS' : 'FAIL'}
          </span>
          <span className="diff-stats">
            {comparison.pixelsDifferent.toLocaleString()} pixels different ({percentDiff}%)
          </span>
        </div>
        <button className="close-button" onClick={onClose} title="Close">×</button>
      </div>

      <div className="visual-diff-controls">
        <div className="view-mode-buttons">
          <button
            className={`view-mode-button ${viewMode === 'sidebyside' ? 'active' : ''}`}
            onClick={() => setViewMode('sidebyside')}
          >
            Side by Side
          </button>
          <button
            className={`view-mode-button ${viewMode === 'diff' ? 'active' : ''}`}
            onClick={() => setViewMode('diff')}
          >
            Diff Only
          </button>
          <button
            className={`view-mode-button ${viewMode === 'slider' ? 'active' : ''}`}
            onClick={() => setViewMode('slider')}
          >
            Slider
          </button>
        </div>

        {!matches && onAcceptBaseline && (
          <button className="accept-baseline-button" onClick={onAcceptBaseline}>
            Accept as New Baseline
          </button>
        )}
      </div>

      <div className="visual-diff-content">
        {viewMode === 'sidebyside' && (
          <div className="side-by-side-view">
            <div className="image-panel">
              <div className="image-label">Baseline</div>
              <img src={baselineImage} alt="Baseline" />
            </div>
            <div className="image-panel">
              <div className="image-label">Current</div>
              <img src={currentImage} alt="Current" />
            </div>
            <div className="image-panel">
              <div className="image-label">Diff</div>
              <img src={`data:image/png;base64,${diffImage}`} alt="Diff" />
            </div>
          </div>
        )}

        {viewMode === 'diff' && (
          <div className="diff-only-view">
            <img src={`data:image/png;base64,${diffImage}`} alt="Diff" />
          </div>
        )}

        {viewMode === 'slider' && (
          <div className="slider-view">
            <div className="slider-container">
              <div className="slider-images">
                <img
                  src={baselineImage}
                  alt="Baseline"
                  className="slider-baseline"
                  style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}
                />
                <img
                  src={currentImage}
                  alt="Current"
                  className="slider-current"
                  style={{ clipPath: `inset(0 0 0 ${sliderPosition}%)` }}
                />
              </div>
              <div
                className="slider-divider"
                style={{ left: `${sliderPosition}%` }}
              >
                <div className="slider-handle"></div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={sliderPosition}
                onChange={(e) => setSliderPosition(Number(e.target.value))}
                className="slider-control"
              />
            </div>
            <div className="slider-labels">
              <span>Baseline</span>
              <span>Current</span>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .visual-diff-viewer {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--bg-primary, #1e1e1e);
          z-index: 10000;
          display: flex;
          flex-direction: column;
        }

        .visual-diff-header {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .visual-diff-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          flex: 1;
        }

        .visual-diff-status {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .status-badge {
          padding: 4px 12px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }

        .status-badge.pass {
          background: rgba(0, 255, 0, 0.1);
          color: #4caf50;
          border: 1px solid rgba(0, 255, 0, 0.3);
        }

        .status-badge.fail {
          background: rgba(255, 0, 0, 0.1);
          color: #f44336;
          border: 1px solid rgba(255, 0, 0, 0.3);
        }

        .diff-stats {
          font-size: 13px;
          color: var(--text-secondary, #999);
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

        .visual-diff-controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .view-mode-buttons {
          display: flex;
          gap: 8px;
        }

        .view-mode-button {
          padding: 8px 16px;
          background: var(--bg-secondary, #2a2a2a);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          color: var(--text-primary, #d4d4d4);
          cursor: pointer;
          font-size: 13px;
          transition: all 0.2s;
        }

        .view-mode-button:hover {
          background: var(--bg-hover, #333);
        }

        .view-mode-button.active {
          background: var(--accent-color, #007acc);
          border-color: var(--accent-color, #007acc);
          color: white;
        }

        .accept-baseline-button {
          padding: 8px 16px;
          background: var(--accent-color, #007acc);
          border: none;
          border-radius: 4px;
          color: white;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
        }

        .accept-baseline-button:hover {
          background: var(--accent-hover, #0066b3);
        }

        .visual-diff-content {
          flex: 1;
          overflow: auto;
          padding: 16px;
        }

        .side-by-side-view {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
          gap: 16px;
          height: 100%;
        }

        .image-panel {
          display: flex;
          flex-direction: column;
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          overflow: hidden;
        }

        .image-label {
          padding: 8px 12px;
          background: var(--bg-secondary, #2a2a2a);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--text-secondary, #999);
        }

        .image-panel img {
          width: 100%;
          height: auto;
          display: block;
          background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 20px 20px;
        }

        .diff-only-view {
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100%;
        }

        .diff-only-view img {
          max-width: 100%;
          max-height: 100%;
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 20px 20px;
        }

        .slider-view {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
        }

        .slider-container {
          position: relative;
          max-width: 100%;
          max-height: calc(100% - 60px);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          overflow: hidden;
        }

        .slider-images {
          position: relative;
          width: 100%;
          height: 100%;
        }

        .slider-baseline,
        .slider-current {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          display: block;
        }

        .slider-divider {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: #007acc;
          pointer-events: none;
          z-index: 10;
        }

        .slider-handle {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 32px;
          height: 32px;
          background: #007acc;
          border: 2px solid white;
          border-radius: 50%;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .slider-control {
          width: 100%;
          margin-top: 8px;
          cursor: pointer;
        }

        .slider-labels {
          display: flex;
          justify-content: space-between;
          width: 100%;
          max-width: 600px;
          font-size: 12px;
          color: var(--text-secondary, #999);
          font-weight: 600;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}
