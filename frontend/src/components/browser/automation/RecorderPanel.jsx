import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../../../utils/api';
import { ActionList } from './ActionList';
import { CodeGenerator } from './CodeGenerator';

export function RecorderPanel({ onClose }) {
  const [recordingSession, setRecordingSession] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [actions, setActions] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showCodeGenerator, setShowCodeGenerator] = useState(false);

  // Check for active recording on mount
  useEffect(() => {
    checkActiveRecording();
  }, []);

  // Poll for actions when recording
  useEffect(() => {
    if (!isRecording || !recordingSession) return;

    const interval = setInterval(async () => {
      try {
        const response = await apiFetch(`/api/browser/recorder/actions/${recordingSession.id}`);
        setActions(response.recording.actions || []);
      } catch (err) {
        console.error('Failed to fetch actions:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isRecording, recordingSession]);

  const checkActiveRecording = async () => {
    try {
      const response = await apiFetch('/api/browser/recorder/active');
      if (response.active) {
        setRecordingSession(response.recording);
        setIsRecording(true);
        setIsPaused(false);
      }
    } catch (err) {
      console.error('Failed to check active recording:', err);
    }
  };

  const handleStartRecording = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/browser/recorder/start', {
        method: 'POST'
      });
      setRecordingSession(response.recording);
      setIsRecording(true);
      setIsPaused(false);
      setActions([]);
    } catch (err) {
      setError(err.message || 'Failed to start recording');
    } finally {
      setLoading(false);
    }
  };

  const handleStopRecording = async () => {
    if (!recordingSession) return;

    setLoading(true);
    setError(null);
    try {
      await apiFetch('/api/browser/recorder/stop', {
        method: 'POST',
        body: JSON.stringify({ recordingId: recordingSession.id })
      });
      setIsRecording(false);
      setIsPaused(false);
      setShowCodeGenerator(true);
    } catch (err) {
      setError(err.message || 'Failed to stop recording');
    } finally {
      setLoading(false);
    }
  };

  const handlePauseRecording = () => {
    setIsPaused(!isPaused);
  };

  const handleAddAssertion = async () => {
    if (!recordingSession) return;

    const type = prompt('Assertion type (visible, hidden, text, value, count):');
    if (!type) return;

    const selector = prompt('CSS Selector:');
    if (!selector) return;

    let expected = null;
    if (type === 'text' || type === 'value' || type === 'count') {
      expected = prompt('Expected value:');
    }

    try {
      await apiFetch('/api/browser/recorder/assertion', {
        method: 'POST',
        body: JSON.stringify({
          recordingId: recordingSession.id,
          type,
          selector,
          expected
        })
      });
    } catch (err) {
      setError(err.message || 'Failed to add assertion');
    }
  };

  const handleAddWait = async () => {
    if (!recordingSession) return;

    const type = prompt('Wait type (selector, navigation, timeout):');
    if (!type) return;

    let selector = null;
    let timeout = null;
    let state = null;

    if (type === 'selector') {
      selector = prompt('CSS Selector:');
      if (!selector) return;
      state = prompt('State (attached, detached, visible, hidden):');
    } else if (type === 'timeout') {
      timeout = parseInt(prompt('Timeout (ms):'), 10);
      if (isNaN(timeout)) return;
    }

    try {
      await apiFetch('/api/browser/recorder/wait', {
        method: 'POST',
        body: JSON.stringify({
          recordingId: recordingSession.id,
          type,
          selector,
          timeout,
          state
        })
      });
    } catch (err) {
      setError(err.message || 'Failed to add wait');
    }
  };

  const handleDeleteRecording = async () => {
    if (!recordingSession) return;

    if (!confirm('Delete this recording? This cannot be undone.')) return;

    try {
      await apiFetch(`/api/browser/recorder/${recordingSession.id}`, {
        method: 'DELETE'
      });
      setRecordingSession(null);
      setIsRecording(false);
      setActions([]);
    } catch (err) {
      setError(err.message || 'Failed to delete recording');
    }
  };

  if (showCodeGenerator && recordingSession) {
    return (
      <CodeGenerator
        recordingId={recordingSession.id}
        actions={actions}
        onClose={() => {
          setShowCodeGenerator(false);
          setRecordingSession(null);
          setActions([]);
        }}
      />
    );
  }

  return (
    <div className="recorder-panel-overlay" onClick={(e) => e.target.className === 'recorder-panel-overlay' && onClose()}>
      <div className="recorder-panel">
        <div className="recorder-panel-header">
          <h3>Action Recorder</h3>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="recorder-error">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        <div className="recorder-controls">
          <div className="recorder-status">
            <div className={`status-indicator ${isRecording ? 'recording' : 'stopped'} ${isPaused ? 'paused' : ''}`} />
            <span className="status-text">
              {isRecording ? (isPaused ? 'Paused' : 'Recording') : 'Stopped'}
            </span>
            <span className="action-count">{actions.length} actions</span>
          </div>

          <div className="recorder-buttons">
            {!isRecording ? (
              <button
                className="btn-primary"
                onClick={handleStartRecording}
                disabled={loading}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
                </svg>
                Start Recording
              </button>
            ) : (
              <>
                <button
                  className="btn-secondary"
                  onClick={handlePauseRecording}
                  disabled={loading}
                >
                  {isPaused ? (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                      Resume
                    </>
                  ) : (
                    <>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="6" y="4" width="4" height="16"></rect>
                        <rect x="14" y="4" width="4" height="16"></rect>
                      </svg>
                      Pause
                    </>
                  )}
                </button>
                <button
                  className="btn-danger"
                  onClick={handleStopRecording}
                  disabled={loading}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="6" y="6" width="12" height="12"></rect>
                  </svg>
                  Stop
                </button>
              </>
            )}
          </div>
        </div>

        {isRecording && (
          <div className="recorder-manual-actions">
            <button className="btn-outline" onClick={handleAddAssertion}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              Add Assertion
            </button>
            <button className="btn-outline" onClick={handleAddWait}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              Add Wait
            </button>
          </div>
        )}

        {actions.length > 0 && (
          <div className="recorder-actions-container">
            <div className="actions-header">
              <h4>Recorded Actions</h4>
              {!isRecording && (
                <div className="actions-toolbar">
                  <button className="btn-outline-sm" onClick={() => setShowCodeGenerator(true)}>
                    Generate Code
                  </button>
                  <button className="btn-danger-sm" onClick={handleDeleteRecording}>
                    Delete
                  </button>
                </div>
              )}
            </div>
            <ActionList actions={actions} />
          </div>
        )}

        {actions.length === 0 && !isRecording && (
          <div className="recorder-empty">
            <p>No actions recorded yet.</p>
            <p>Click "Start Recording" to begin capturing browser actions.</p>
          </div>
        )}
      </div>

      <style jsx>{`
        .recorder-panel-overlay {
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

        .recorder-panel {
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

        .recorder-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .recorder-panel-header h3 {
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

        .recorder-error {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          background: rgba(239, 68, 68, 0.1);
          border-bottom: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
          font-size: 13px;
        }

        .recorder-error button {
          background: none;
          border: none;
          color: #ef4444;
          font-size: 20px;
          cursor: pointer;
          padding: 0 8px;
        }

        .recorder-controls {
          padding: 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #252525);
        }

        .recorder-status {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }

        .status-indicator {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--text-tertiary, #666);
        }

        .status-indicator.recording {
          background: #ef4444;
          animation: pulse 1.5s ease-in-out infinite;
        }

        .status-indicator.paused {
          background: #f59e0b;
          animation: none;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .status-text {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .action-count {
          margin-left: auto;
          font-size: 13px;
          color: var(--text-secondary, #999);
          background: var(--bg-primary, #1e1e1e);
          padding: 4px 10px;
          border-radius: 12px;
        }

        .recorder-buttons {
          display: flex;
          gap: 8px;
        }

        .btn-primary, .btn-secondary, .btn-danger, .btn-outline {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border: 1px solid;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary {
          background: #3b82f6;
          border-color: #3b82f6;
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          background: #2563eb;
        }

        .btn-secondary {
          background: #f59e0b;
          border-color: #f59e0b;
          color: white;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #d97706;
        }

        .btn-danger {
          background: #ef4444;
          border-color: #ef4444;
          color: white;
        }

        .btn-danger:hover:not(:disabled) {
          background: #dc2626;
        }

        .btn-outline {
          background: transparent;
          border-color: var(--border-color, #3a3a3a);
          color: var(--text-primary, #d4d4d4);
        }

        .btn-outline:hover:not(:disabled) {
          background: var(--bg-hover, #2a2a2a);
          border-color: #3b82f6;
        }

        .btn-primary:disabled, .btn-secondary:disabled, .btn-danger:disabled, .btn-outline:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .recorder-manual-actions {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          display: flex;
          gap: 8px;
        }

        .recorder-actions-container {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .actions-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .actions-header h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .actions-toolbar {
          display: flex;
          gap: 8px;
        }

        .btn-outline-sm, .btn-danger-sm {
          padding: 6px 12px;
          font-size: 12px;
          border: 1px solid;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
        }

        .btn-outline-sm {
          background: transparent;
          border-color: var(--border-color, #3a3a3a);
          color: var(--text-primary, #d4d4d4);
        }

        .btn-outline-sm:hover {
          background: var(--bg-hover, #2a2a2a);
          border-color: #3b82f6;
        }

        .btn-danger-sm {
          background: transparent;
          border-color: #ef4444;
          color: #ef4444;
        }

        .btn-danger-sm:hover {
          background: rgba(239, 68, 68, 0.1);
        }

        .recorder-empty {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 60px 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .recorder-empty p {
          margin: 8px 0;
          font-size: 14px;
        }

        .recorder-empty p:first-child {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }
      `}</style>
    </div>
  );
}
