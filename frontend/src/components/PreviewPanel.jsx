import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { getAccessToken } from '../utils/auth';

// Format timestamp for log display
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

// Convert file:// URLs or local paths to preview API URLs
function withAuthToken(url) {
  const token = getAccessToken();
  if (!token) return url;

  try {
    const fullUrl = new URL(url, window.location.origin);
    if (!fullUrl.searchParams.has('token')) {
      fullUrl.searchParams.set('token', token);
    }
    return `${fullUrl.pathname}${fullUrl.search}${fullUrl.hash}`;
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }
}

function toPreviewUrl(inputUrl) {
  if (!inputUrl) return null;

  // Handle file:// URLs
  if (inputUrl.startsWith('file:///')) {
    const filePath = decodeURIComponent(inputUrl.replace('file:///', ''));
    // Extract directory and filename
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const directory = filePath.substring(0, lastSlash);
    const filename = filePath.substring(lastSlash + 1);
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Windows-style paths (C:\... or C:/...)
  if (/^[A-Za-z]:[/\\]/.test(inputUrl)) {
    const lastSlash = Math.max(inputUrl.lastIndexOf('/'), inputUrl.lastIndexOf('\\'));
    const directory = inputUrl.substring(0, lastSlash);
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle Unix-style absolute paths
  if (inputUrl.startsWith('/') && !inputUrl.startsWith('//')) {
    const lastSlash = inputUrl.lastIndexOf('/');
    const directory = inputUrl.substring(0, lastSlash) || '/';
    const filename = inputUrl.substring(lastSlash + 1) || 'index.html';
    return withAuthToken(`/api/preview?path=${encodeURIComponent(directory)}&file=${encodeURIComponent(filename)}`);
  }

  // Handle localhost/local network URLs - use preview subdomain
  // This allows previewing dev servers running on the remote server
  try {
    const parsed = new URL(inputUrl);
    const hostname = parsed.hostname;

    // Check if it's a local address that needs proxying
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
    const isPrivateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);

    if ((isLocalhost || isPrivateIP) && parsed.port) {
      // Use preview subdomain instead of path-based proxy
      // This properly supports SPA navigation since URL paths stay natural
      const path = parsed.pathname + parsed.search + parsed.hash;
      return `https://preview-${parsed.port}.conordart.com${path}`;
    }
  } catch {
    // Not a valid URL, fall through
  }

  // External HTTP(S) URLs - route through proxy to bypass iframe restrictions
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return withAuthToken(`/api/proxy-external?url=${encodeURIComponent(inputUrl)}`);
    }
  } catch {
    // Not a valid URL
  }

  return inputUrl;
}

export function PreviewPanel({ url, onClose, onUrlChange, projectInfo, onStartProject }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inputUrl, setInputUrl] = useState(url || '');
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(true);
  const iframeRef = useRef(null);
  const logsEndRef = useRef(null);

  // Convert the URL for iframe display
  const baseIframeSrc = useMemo(() => toPreviewUrl(url), [url]);

  // Track the actual iframe src (including cache buster for refreshes)
  const [iframeSrc, setIframeSrc] = useState(baseIframeSrc);

  // Update iframeSrc when baseIframeSrc changes (new URL entered)
  useEffect(() => {
    setIframeSrc(baseIframeSrc);
  }, [baseIframeSrc]);

  // Listen for console messages from iframe
  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data?.type === 'preview-console') {
        const { level, message, timestamp } = event.data;
        setLogs(prev => [...prev.slice(-199), { id: Date.now() + Math.random(), level, message, timestamp }]);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  // Clear logs when URL changes
  useEffect(() => {
    setLogs([]);
  }, [url]);

  const handleClearLogs = useCallback(() => {
    setLogs([]);
  }, []);

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
    if (baseIframeSrc) {
      setIsLoading(true);
      setError(null);
      setLogs([]); // Clear logs on refresh
      // Add cache-busting timestamp to force hard refresh
      const cacheBuster = `_cb=${Date.now()}`;
      const separator = baseIframeSrc.includes('?') ? '&' : '?';
      setIframeSrc(`${baseIframeSrc}${separator}${cacheBuster}`);
    }
  }, [baseIframeSrc]);

  const handleUrlSubmit = useCallback((e) => {
    e.preventDefault();
    if (inputUrl && onUrlChange) {
      onUrlChange(inputUrl);
    }
  }, [inputUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    // Open the preview URL (subdomain) rather than original localhost URL
    if (iframeSrc) {
      window.open(iframeSrc, '_blank', 'noopener,noreferrer');
    }
  }, [iframeSrc]);

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
            disabled={!iframeSrc}
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

      {/* Console Logs Panel */}
      <div className={`preview-logs ${showLogs ? 'expanded' : 'collapsed'}`}>
        <div className="preview-logs-header" onClick={() => setShowLogs(!showLogs)}>
          <span className="preview-logs-title">
            <span className="preview-logs-icon">{'\u{1F4CB}'}</span>
            Console
            {logs.length > 0 && <span className="preview-logs-count">{logs.length}</span>}
          </span>
          <div className="preview-logs-actions">
            {showLogs && (
              <button
                type="button"
                className="preview-logs-btn"
                onClick={(e) => { e.stopPropagation(); handleClearLogs(); }}
                title="Clear logs"
              >
                Clear
              </button>
            )}
            <span className="preview-logs-toggle">{showLogs ? '\u25BC' : '\u25B2'}</span>
          </div>
        </div>
        {showLogs && (
          <div className="preview-logs-content">
            {logs.length === 0 ? (
              <div className="preview-logs-empty">No console output yet</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className={`preview-log-entry preview-log-${log.level}`}>
                  <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                  <span className="preview-log-level">{log.level}</span>
                  <span className="preview-log-message">{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}
