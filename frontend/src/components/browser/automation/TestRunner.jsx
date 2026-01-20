import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../../../utils/api';
import { TestResults } from './TestResults';

export function TestRunner({ onClose }) {
  const [tests, setTests] = useState([]);
  const [selectedTests, setSelectedTests] = useState(new Set());
  const [concurrency, setConcurrency] = useState(3);
  const [maxRetries, setMaxRetries] = useState(0);
  const [captureScreenshots, setCaptureScreenshots] = useState(true);
  const [running, setRunning] = useState(false);
  const [currentRun, setCurrentRun] = useState(null);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    loadTests();
  }, []);

  useEffect(() => {
    if (currentRun && currentRun.id) {
      connectWebSocket(currentRun.id);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [currentRun]);

  const loadTests = async () => {
    try {
      const response = await apiFetch('/api/browser/recorder/sessions');
      // Convert recording sessions to tests
      const testList = response.sessions.map(session => ({
        id: session.id,
        name: `Recording ${session.id.slice(0, 8)}`,
        recordingId: session.id,
        actionCount: session.actionCount,
        framework: 'playwright',
        selected: false
      }));
      setTests(testList);
    } catch (err) {
      setError(err.message || 'Failed to load tests');
    }
  };

  const connectWebSocket = (runId) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/browser/tests/stream?runId=${runId}`;

    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'update') {
        setCurrentRun(prevRun => ({
          ...prevRun,
          ...message.data
        }));
      }
    };

    wsRef.current.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current.onclose = () => {
      wsRef.current = null;
    };
  };

  const handleToggleTest = (testId) => {
    setSelectedTests(prev => {
      const next = new Set(prev);
      if (next.has(testId)) {
        next.delete(testId);
      } else {
        next.add(testId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedTests.size === tests.length) {
      setSelectedTests(new Set());
    } else {
      setSelectedTests(new Set(tests.map(t => t.id)));
    }
  };

  const handleRunTests = async () => {
    if (selectedTests.size === 0) {
      setError('Please select at least one test to run');
      return;
    }

    setRunning(true);
    setError(null);

    try {
      // Generate code for each selected test
      const testConfigs = [];
      for (const testId of selectedTests) {
        const test = tests.find(t => t.id === testId);
        if (!test) continue;

        // Generate code for this recording
        const codeResponse = await apiFetch('/api/browser/recorder/generate', {
          method: 'POST',
          body: JSON.stringify({
            recordingId: test.recordingId,
            framework: test.framework || 'playwright',
            language: 'javascript',
            testFramework: 'none'
          })
        });

        testConfigs.push({
          name: test.name,
          code: codeResponse.code,
          framework: test.framework || 'playwright'
        });
      }

      // Run tests
      const response = await apiFetch('/api/browser/tests/run', {
        method: 'POST',
        body: JSON.stringify({
          tests: testConfigs,
          maxRetries,
          captureScreenshotOnFailure: captureScreenshots,
          concurrency: concurrency
        })
      });

      setCurrentRun(response.run);
    } catch (err) {
      setError(err.message || 'Failed to run tests');
      setRunning(false);
    }
  };

  const handleCancelRun = async () => {
    if (!currentRun || !currentRun.id) return;

    try {
      await apiFetch(`/api/browser/tests/cancel/${currentRun.id}`, {
        method: 'POST'
      });
      setRunning(false);
    } catch (err) {
      setError(err.message || 'Failed to cancel test run');
    }
  };

  const handleCloseResults = () => {
    setCurrentRun(null);
    setRunning(false);
    setSelectedTests(new Set());
  };

  if (currentRun) {
    return (
      <TestResults
        run={currentRun}
        onClose={handleCloseResults}
        onRetry={handleRunTests}
      />
    );
  }

  return (
    <div className="test-runner-overlay" onClick={(e) => e.target.className === 'test-runner-overlay' && onClose()}>
      <div className="test-runner">
        <div className="test-runner-header">
          <h3>Test Runner</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="test-runner-error">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        <div className="test-runner-config">
          <div className="config-row">
            <div className="config-group">
              <label>Concurrency</label>
              <input
                type="range"
                min="1"
                max="10"
                value={concurrency}
                onChange={(e) => setConcurrency(parseInt(e.target.value, 10))}
              />
              <span className="config-value">{concurrency} parallel</span>
            </div>

            <div className="config-group">
              <label>Max Retries</label>
              <input
                type="number"
                min="0"
                max="5"
                value={maxRetries}
                onChange={(e) => setMaxRetries(parseInt(e.target.value, 10))}
              />
            </div>

            <div className="config-group">
              <label>
                <input
                  type="checkbox"
                  checked={captureScreenshots}
                  onChange={(e) => setCaptureScreenshots(e.target.checked)}
                />
                Capture screenshots on failure
              </label>
            </div>
          </div>
        </div>

        <div className="test-list-header">
          <label className="select-all">
            <input
              type="checkbox"
              checked={selectedTests.size === tests.length && tests.length > 0}
              onChange={handleSelectAll}
            />
            Select All ({selectedTests.size} of {tests.length})
          </label>
          <button
            className="btn-primary"
            onClick={handleRunTests}
            disabled={running || selectedTests.size === 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            Run Selected Tests
          </button>
        </div>

        <div className="test-list">
          {tests.length === 0 ? (
            <div className="test-list-empty">
              <p>No tests available</p>
              <p>Record some browser actions first to create tests</p>
            </div>
          ) : (
            tests.map(test => (
              <div
                key={test.id}
                className={`test-item ${selectedTests.has(test.id) ? 'selected' : ''}`}
                onClick={() => handleToggleTest(test.id)}
              >
                <input
                  type="checkbox"
                  checked={selectedTests.has(test.id)}
                  onChange={() => handleToggleTest(test.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="test-info">
                  <div className="test-name">{test.name}</div>
                  <div className="test-meta">
                    <span>{test.actionCount} actions</span>
                    <span>{test.framework}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <style jsx>{`
        .test-runner-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
        }

        .test-runner {
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          width: 700px;
          max-width: 90vw;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .test-runner-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .test-runner-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-secondary, #999);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          line-height: 1;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
          color: var(--text-primary, #d4d4d4);
        }

        .test-runner-error {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          background: rgba(239, 68, 68, 0.1);
          border-bottom: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
          font-size: 13px;
        }

        .test-runner-error button {
          background: none;
          border: none;
          color: #ef4444;
          font-size: 20px;
          cursor: pointer;
          padding: 0 8px;
        }

        .test-runner-config {
          padding: 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #252525);
        }

        .config-row {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 20px;
        }

        .config-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .config-group label {
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary, #999);
        }

        .config-group input[type="range"] {
          width: 100%;
        }

        .config-group input[type="number"] {
          padding: 8px 12px;
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 6px;
          color: var(--text-primary, #d4d4d4);
          font-size: 14px;
        }

        .config-group input[type="checkbox"] {
          margin-right: 8px;
        }

        .config-value {
          font-size: 13px;
          color: var(--text-primary, #d4d4d4);
        }

        .test-list-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .select-all {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          color: var(--text-primary, #d4d4d4);
          cursor: pointer;
        }

        .select-all input {
          cursor: pointer;
        }

        .btn-primary {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          background: #3b82f6;
          border: 1px solid #3b82f6;
          border-radius: 6px;
          color: white;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary:hover:not(:disabled) {
          background: #2563eb;
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .test-list {
          flex: 1;
          overflow-y: auto;
          padding: 16px 20px;
        }

        .test-list-empty {
          padding: 60px 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .test-list-empty p {
          margin: 8px 0;
          font-size: 14px;
        }

        .test-list-empty p:first-child {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .test-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          margin-bottom: 8px;
          background: var(--bg-secondary, #252525);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .test-item:hover {
          border-color: #3b82f6;
        }

        .test-item.selected {
          background: rgba(59, 130, 246, 0.1);
          border-color: #3b82f6;
        }

        .test-item input[type="checkbox"] {
          cursor: pointer;
        }

        .test-info {
          flex: 1;
          min-width: 0;
        }

        .test-name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
          margin-bottom: 4px;
        }

        .test-meta {
          display: flex;
          gap: 12px;
          font-size: 12px;
          color: var(--text-secondary, #999);
        }
      `}</style>
    </div>
  );
}
