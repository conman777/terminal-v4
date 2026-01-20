import { NavigationControls } from './NavigationControls';
import { ScreenshotTools } from './ScreenshotTools';

export function PreviewToolbar({
  // Navigation props
  onBack,
  onForward,
  onReload,
  canGoBack,
  canGoForward,
  isLoading,
  // Screenshot props
  previewPort,
  selectedElement,
  // URL control props
  showUrlInput,
  onToggleUrlInput,
  inputUrl,
  onInputUrlChange,
  onUrlSubmit,
  // Inspect mode props
  inspectMode,
  onToggleInspectMode,
  // Status display
  url,
  // Automation props
  onOpenRecorder,
  onOpenTests,
  onOpenCookies
}) {
  return (
    <div className="preview-toolbar" style={{
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      padding: '8px 12px',
      borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
      background: 'rgba(15, 23, 42, 0.8)',
      backdropFilter: 'blur(8px)'
    }}>
      {/* Navigation Section */}
      <NavigationControls
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
      />

      {/* Separator */}
      <div style={{
        width: '1px',
        height: '20px',
        background: 'rgba(148, 163, 184, 0.2)'
      }} />

      {/* Tools Section */}
      <ScreenshotTools
        previewPort={previewPort}
        selectedElement={selectedElement}
      />

      {/* Separator */}
      <div style={{
        width: '1px',
        height: '20px',
        background: 'rgba(148, 163, 184, 0.2)'
      }} />

      {/* Inspect Mode Toggle */}
      <button
        onClick={onToggleInspectMode}
        className={`preview-tool-btn ${inspectMode ? 'active' : ''}`}
        title="Toggle inspect mode (Click to select elements)"
        aria-label="Toggle inspect mode"
        style={inspectMode ? { color: '#3b82f6', borderColor: '#3b82f6' } : {}}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      </button>

      {/* Separator */}
      <div style={{
        width: '1px',
        height: '20px',
        background: 'rgba(148, 163, 184, 0.2)'
      }} />

      {/* Automation Tools */}
      {onOpenRecorder && (
        <button
          onClick={onOpenRecorder}
          className="preview-tool-btn"
          title="Open Action Recorder"
          aria-label="Open Action Recorder"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
          </svg>
        </button>
      )}

      {onOpenTests && (
        <button
          onClick={onOpenTests}
          className="preview-tool-btn"
          title="Run Tests"
          aria-label="Run Tests"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
        </button>
      )}

      {onOpenCookies && (
        <button
          onClick={onOpenCookies}
          className="preview-tool-btn"
          title="Manage Cookies"
          aria-label="Manage Cookies"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8z"></path>
            <circle cx="8" cy="9" r="1"></circle>
            <circle cx="16" cy="10" r="1"></circle>
            <circle cx="10" cy="14" r="1"></circle>
            <circle cx="15" cy="15" r="1"></circle>
          </svg>
        </button>
      )}

      {/* URL Display/Input */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
        {showUrlInput ? (
          <form onSubmit={onUrlSubmit} style={{ display: 'flex', flex: 1, gap: '4px' }}>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => onInputUrlChange(e.target.value)}
              placeholder="Enter preview URL or port number"
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: '12px',
                background: 'rgba(30, 41, 59, 0.8)',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                borderRadius: '4px',
                color: '#e2e8f0',
                outline: 'none'
              }}
              autoFocus
            />
            <button type="submit" className="preview-tool-btn" title="Go">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
            <button
              type="button"
              onClick={onToggleUrlInput}
              className="preview-tool-btn"
              title="Cancel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </form>
        ) : (
          <>
            <div
              onClick={onToggleUrlInput}
              style={{
                flex: 1,
                fontSize: '12px',
                color: '#94a3b8',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: '4px',
                background: 'rgba(30, 41, 59, 0.4)',
                border: '1px solid transparent'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(30, 41, 59, 0.6)';
                e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(30, 41, 59, 0.4)';
                e.currentTarget.style.borderColor = 'transparent';
              }}
              title={url}
            >
              {url || 'No URL'}
            </div>
            <button
              onClick={onToggleUrlInput}
              className="preview-tool-btn"
              title="Change URL"
              aria-label="Change URL"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
