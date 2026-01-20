import { useState } from 'react';
import { apiFetch } from '../../utils/api';

export function ScreenshotTools({ previewPort, selectedElement }) {
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingId, setRecordingId] = useState(null);
  const [message, setMessage] = useState(null);

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const handleScreenshot = async (fullPage = false) => {
    if (!previewPort) {
      showMessage('No preview port available', 'error');
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiFetch(`/api/preview/${previewPort}/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullPage })
      });

      if (response.ok) {
        const data = await response.json();
        showMessage(`Screenshot saved: ${data.filename}`, 'success');
      } else {
        const error = await response.json();
        showMessage(error.message || 'Failed to take screenshot', 'error');
      }
    } catch (error) {
      console.error('Screenshot error:', error);
      showMessage('Failed to take screenshot', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleElementScreenshot = async () => {
    if (!previewPort) {
      showMessage('No preview port available', 'error');
      return;
    }

    if (!selectedElement?.fullSelector) {
      showMessage('No element selected', 'error');
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiFetch(`/api/preview/${previewPort}/screenshot/element`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selector: selectedElement.fullSelector })
      });

      if (response.ok) {
        const data = await response.json();
        showMessage(`Element screenshot saved: ${data.filename}`, 'success');
      } else {
        const error = await response.json();
        showMessage(error.message || 'Failed to take element screenshot', 'error');
      }
    } catch (error) {
      console.error('Element screenshot error:', error);
      showMessage('Failed to take element screenshot', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartRecording = async () => {
    if (!previewPort) {
      showMessage('No preview port available', 'error');
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiFetch(`/api/preview/${previewPort}/recording/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (response.ok) {
        const data = await response.json();
        setRecordingId(data.recordingId);
        setIsRecording(true);
        showMessage('Recording started', 'success');
      } else {
        const error = await response.json();
        showMessage(error.message || 'Failed to start recording', 'error');
      }
    } catch (error) {
      console.error('Recording start error:', error);
      showMessage('Failed to start recording', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStopRecording = async () => {
    if (!recordingId) return;

    setIsLoading(true);
    try {
      const response = await apiFetch(`/api/preview/recording/${recordingId}/stop`, {
        method: 'POST'
      });

      if (response.ok) {
        const data = await response.json();
        showMessage(`Recording saved: ${data.filename}`, 'success');
        setIsRecording(false);
        setRecordingId(null);
      } else {
        const error = await response.json();
        showMessage(error.message || 'Failed to stop recording', 'error');
      }
    } catch (error) {
      console.error('Recording stop error:', error);
      showMessage('Failed to stop recording', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="screenshot-tools" style={{ display: 'flex', gap: '4px', alignItems: 'center', position: 'relative' }}>
      {/* Viewport Screenshot */}
      <button
        onClick={() => handleScreenshot(false)}
        disabled={isLoading || isRecording}
        className="preview-tool-btn"
        title="Screenshot viewport"
        aria-label="Screenshot viewport"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
      </button>

      {/* Full Page Screenshot */}
      <button
        onClick={() => handleScreenshot(true)}
        disabled={isLoading || isRecording}
        className="preview-tool-btn"
        title="Screenshot full page"
        aria-label="Screenshot full page"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      </button>

      {/* Element Screenshot */}
      <button
        onClick={handleElementScreenshot}
        disabled={isLoading || isRecording || !selectedElement}
        className="preview-tool-btn"
        title="Screenshot selected element"
        aria-label="Screenshot selected element"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7"></rect>
          <rect x="14" y="3" width="7" height="7"></rect>
          <rect x="14" y="14" width="7" height="7"></rect>
          <rect x="3" y="14" width="7" height="7"></rect>
        </svg>
      </button>

      {/* Recording Toggle */}
      {!isRecording ? (
        <button
          onClick={handleStartRecording}
          disabled={isLoading}
          className="preview-tool-btn"
          title="Start recording"
          aria-label="Start recording"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
          </svg>
        </button>
      ) : (
        <button
          onClick={handleStopRecording}
          disabled={isLoading}
          className="preview-tool-btn recording-active"
          title="Stop recording"
          aria-label="Stop recording"
          style={{ color: '#ef4444' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="6" height="6" fill="currentColor"></rect>
          </svg>
        </button>
      )}

      {/* Message Toast */}
      {message && (
        <div
          className="screenshot-message"
          style={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginTop: '8px',
            padding: '6px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            background: message.type === 'error' ? '#dc2626' : '#059669',
            color: '#fff',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
