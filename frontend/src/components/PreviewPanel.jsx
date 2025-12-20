import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

// Convert file:// URLs or local paths to preview API URLs
function toPreviewUrl(inputUrl) {
  if (!inputUrl) return null;

  // Handle file:// URLs
  if (inputUrl.startsWith('file:///')) {
    const filePath = decodeURIComponent(inputUrl.replace('file:///', ''));
    // Extract directory and filename
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const directory = filePath.substring(0, lastSlash);
    const filename = filePath.substring(lastSlash + 1);
    return `/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`;
  }

  // Handle Windows-style paths (C:\... or C:/...)
  if (/^[A-Za-z]:[/\\]/.test(inputUrl)) {
    const lastSlash = Math.max(inputUrl.lastIndexOf('/'), inputUrl.lastIndexOf('\\'));
    const directory = inputUrl.substring(0, lastSlash);
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return `/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`;
  }

  // Handle Unix-style absolute paths
  if (inputUrl.startsWith('/') && !inputUrl.startsWith('//')) {
    const lastSlash = inputUrl.lastIndexOf('/');
    const directory = inputUrl.substring(0, lastSlash) || '/';
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return `/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`;
  }

  // Regular HTTP(S) URLs pass through
  return inputUrl;
}

export function PreviewPanel({ url, onClose, onUrlChange, projectInfo, onStartProject }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inputUrl, setInputUrl] = useState(url || '');
  const iframeRef = useRef(null);

  // Convert the URL for iframe display
  const iframeSrc = useMemo(() => toPreviewUrl(url), [url]);

  useEffect(() => {
    setInputUrl(url || '');
  }, [url]);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setError(null);
  }, []);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setError('Failed to load preview. The server may not be running or CORS may be blocking the request.');
  }, []);

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && iframeSrc) {
      setIsLoading(true);
      setError(null);
      iframeRef.current.src = iframeSrc;
    }
  }, [iframeSrc]);

  const handleUrlSubmit = useCallback((e) => {
    e.preventDefault();
    if (inputUrl && onUrlChange) {
      onUrlChange(inputUrl);
    }
  }, [inputUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [url]);

  return (
    <div className="preview-panel">
      <div className="preview-header">
        <div className="preview-title">
          <span className="preview-icon">{'\u2699'}</span>
          <span>Preview</span>
        </div>
        <form className="preview-url-form" onSubmit={handleUrlSubmit}>
          <input
            type="text"
            className="preview-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="http://localhost:3000 or C:\path\to\index.html"
            aria-label="Preview URL"
          />
        </form>
        <div className="preview-actions">
          <button
            type="button"
            className="preview-action-btn"
            onClick={handleRefresh}
            title="Refresh"
            disabled={!iframeSrc}
            aria-label="Refresh preview"
          >
            {'\u21BB'}
          </button>
          <button
            type="button"
            className="preview-action-btn"
            onClick={handleOpenExternal}
            title="Open in new tab"
            disabled={!url}
            aria-label="Open preview in new tab"
          >
            {'\u2197'}
          </button>
          <button
            type="button"
            className="preview-action-btn preview-close-btn"
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview"
          >
            {'\u00D7'}
          </button>
        </div>
      </div>

      <div className="preview-content">
        {!iframeSrc ? (
          <div className="preview-empty">
            {projectInfo && projectInfo.projectType !== 'unknown' ? (
              <>
                <div className="preview-empty-icon">{projectInfo.projectType === 'static' ? '\u{1F4C4}' : '\u{1F4E6}'}</div>
                <h3>{projectInfo.projectName || projectInfo.projectType.charAt(0).toUpperCase() + projectInfo.projectType.slice(1)} Project</h3>
                {projectInfo.projectType === 'static' ? (
                  <>
                    <p>Static site detected in this directory.</p>
                    <button
                      type="button"
                      className="btn-primary project-action-btn"
                      onClick={() => onUrlChange && onUrlChange(projectInfo.indexPath)}
                    >
                      Preview Static Site
                    </button>
                  </>
                ) : projectInfo.startCommand ? (
                  <>
                    <p>Run the dev server to see your preview:</p>
                    <button
                      type="button"
                      className="btn-primary project-action-btn"
                      onClick={() => onStartProject && onStartProject(projectInfo.startCommand)}
                    >
                      {projectInfo.startCommand}
                    </button>
                  </>
                ) : (
                  <p>No start script detected. Add a <code>dev</code> or <code>start</code> script to your package.json.</p>
                )}
                <p className="project-cwd">
                  <code>{projectInfo.cwd}</code>
                </p>
              </>
            ) : (
              <>
                <div className="preview-empty-icon">{'\u{1F4BB}'}</div>
                <h3>No Preview URL</h3>
                <p>Start a dev server in the terminal, or enter a local file path like:</p>
                <p className="preview-hint">
                  <code>C:\path\to\project\index.html</code>
                </p>
              </>
            )}
          </div>
        ) : error ? (
          <div className="preview-error">
            <div className="preview-error-icon">{'\u26A0'}</div>
            <h3>Preview Error</h3>
            <p>{error}</p>
            <button type="button" className="btn-primary" onClick={handleRefresh}>
              Try Again
            </button>
          </div>
        ) : (
          <>
            {isLoading && (
              <div className="preview-loading">
                <div className="preview-spinner"></div>
                <p>Loading preview...</p>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              className="preview-iframe"
              onLoad={handleLoad}
              onError={handleError}
              title="App Preview"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
              style={{ opacity: isLoading ? 0 : 1 }}
            />
          </>
        )}
      </div>
    </div>
  );
}
