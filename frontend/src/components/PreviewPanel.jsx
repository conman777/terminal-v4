import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { toPreviewUrl, withAuthToken } from '../utils/previewUrl';
import { getAccessToken } from '../utils/auth';
import { StyleEditor } from './StyleEditor';

// Format timestamp for log display
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

export function PreviewPanel({ url, onClose, onUrlChange, projectInfo, onStartProject, onSendToTerminal, onSendToClaudeCode }) {
  const isMobile = useMobileDetect();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inputUrl, setInputUrl] = useState(url || '');
  const [logs, setLogs] = useState([]);  // Client-side logs from injected script
  const [proxyLogs, setProxyLogs] = useState([]);  // Server-side proxy logs
  const [processLogs, setProcessLogs] = useState([]);  // Process stdout/stderr logs
  const [showLogs, setShowLogs] = useState(false);
  const [logFilter, setLogFilter] = useState('all');  // 'all', 'client', 'proxy', 'server'
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });
  const [inspectMode, setInspectMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState(null);
  const [editDescription, setEditDescription] = useState('');
  const [showEditInput, setShowEditInput] = useState(false);
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [hasCookies, setHasCookies] = useState(false);
  const [activePorts, setActivePorts] = useState([]);
  const [showPortDropdown, setShowPortDropdown] = useState(false);
  const iframeRef = useRef(null);
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const isLogsNearBottomRef = useRef(true);
  const urlInputRef = useRef(null);
  const portDropdownRef = useRef(null);

  const baseIframeSrc = useMemo(() => {
    const result = toPreviewUrl(url);
    console.log('[Preview] URL conversion:', url, '->', result);
    return result;
  }, [url]);
  const [iframeSrc, setIframeSrc] = useState(baseIframeSrc);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Extract port from preview URL for cookie management
  const previewPort = useMemo(() => {
    if (!iframeSrc) return null;
    try {
      const parsed = new URL(iframeSrc, window.location.origin);
      const hostMatch = parsed.hostname.match(/preview-(\d+)\./);
      if (hostMatch) {
        return parseInt(hostMatch[1], 10);
      }
      const pathMatch = parsed.pathname.match(/^\/preview\/(\d+)(\/|$)/);
      return pathMatch ? parseInt(pathMatch[1], 10) : null;
    } catch {
      return null;
    }
  }, [iframeSrc]);

  // Check for cookies when preview loads or port changes
  useEffect(() => {
    if (!previewPort) {
      setHasCookies(false);
      return;
    }
    if (!isDocumentVisible) {
      return;
    }
    const checkCookies = async () => {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/preview/${previewPort}/cookies`, { headers });
        const data = await res.json();
        setHasCookies(data.hasCookies);
      } catch {
        setHasCookies(false);
      }
    };
    checkCookies();
    // Re-check periodically while preview is active
    const interval = setInterval(checkCookies, 10000);
    return () => clearInterval(interval);
  }, [previewPort, isDocumentVisible]);

  const handleClearCookies = useCallback(async () => {
    if (!previewPort) return;
    try {
      const token = getAccessToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      await fetch(`/api/preview/${previewPort}/cookies`, { method: 'DELETE', headers });
      setHasCookies(false);
      // Refresh the preview to apply cleared cookies
      if (baseIframeSrc) {
        setIsLoading(true);
        setError(null);
        setLogs([]);
        setProxyLogs([]);
        const cacheBuster = `_cb=${Date.now()}`;
        const separator = baseIframeSrc.includes('?') ? '&' : '?';
        setIframeSrc(`${baseIframeSrc}${separator}${cacheBuster}`);
      }
    } catch (err) {
      console.error('Failed to clear cookies:', err);
    }
  }, [previewPort, baseIframeSrc]);

  // Fetch active ports for the dropdown
  useEffect(() => {
    if (!isDocumentVisible) return;
    const fetchActivePorts = async () => {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/preview/active-ports', { headers });
        if (res.ok) {
          const data = await res.json();
          setActivePorts(data.ports || []);
        }
      } catch {
        // Ignore fetch errors
      }
    };
    fetchActivePorts();
    // Refresh every 5 seconds
    const interval = setInterval(fetchActivePorts, 5000);
    return () => clearInterval(interval);
  }, [isDocumentVisible]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showPortDropdown) return;
    const handleClickOutside = (e) => {
      if (portDropdownRef.current && !portDropdownRef.current.contains(e.target)) {
        setShowPortDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPortDropdown]);

  const handleSelectPort = useCallback((port) => {
    const newUrl = `http://localhost:${port}`;
    setInputUrl(newUrl);
    setShowPortDropdown(false);
    if (onUrlChange) {
      onUrlChange(newUrl);
    }
  }, [onUrlChange]);

  // Poll for proxy logs (server-side network requests)
  const lastProxyLogTimestamp = useRef(0);
  useEffect(() => {
    if (!previewPort) {
      setProxyLogs([]);
      lastProxyLogTimestamp.current = 0;
      return;
    }
    if (!showLogs || !isDocumentVisible || logFilter === 'client') {
      return;
    }
    const fetchProxyLogs = async () => {
      try {
        const token = getAccessToken();
        const since = lastProxyLogTimestamp.current;
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/preview/${previewPort}/proxy-logs?since=${since}`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          setProxyLogs(prev => {
            const newLogs = [...prev, ...data.logs];
            // Keep max 200 logs
            return newLogs.slice(-200);
          });
          // Update last timestamp
          const lastLog = data.logs[data.logs.length - 1];
          if (lastLog) {
            lastProxyLogTimestamp.current = lastLog.timestamp;
          }
        }
      } catch {
        // Ignore fetch errors
      }
    };
    // Initial fetch (get all logs)
    fetchProxyLogs();
    // Poll every 2 seconds while logs are visible
    const interval = setInterval(fetchProxyLogs, 2000);
    return () => clearInterval(interval);
  }, [previewPort, showLogs, isDocumentVisible, logFilter]);

  // Poll for process logs (stdout/stderr from dev server)
  const lastProcessLogTimestamp = useRef(0);
  useEffect(() => {
    if (!previewPort) {
      setProcessLogs([]);
      lastProcessLogTimestamp.current = 0;
      return;
    }
    if (!showLogs || !isDocumentVisible || logFilter === 'client' || logFilter === 'proxy') {
      return;
    }
    const fetchProcessLogs = async () => {
      try {
        const token = getAccessToken();
        const since = lastProcessLogTimestamp.current;
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/preview/${previewPort}/process-logs?since=${since}`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          setProcessLogs(prev => {
            const newLogs = [...prev, ...data.logs];
            // Keep max 200 logs
            return newLogs.slice(-200);
          });
          // Update last timestamp
          const lastLog = data.logs[data.logs.length - 1];
          if (lastLog) {
            lastProcessLogTimestamp.current = lastLog.timestamp;
          }
        }
      } catch {
        // Ignore fetch errors
      }
    };
    // Initial fetch (get all logs)
    fetchProcessLogs();
    // Poll every 2 seconds while logs are visible
    const interval = setInterval(fetchProcessLogs, 2000);
    return () => clearInterval(interval);
  }, [previewPort, showLogs, isDocumentVisible, logFilter]);

  useEffect(() => {
    setIframeSrc(baseIframeSrc);
  }, [baseIframeSrc]);

  // Listen for messages from iframe (console logs and element selection)
  useEffect(() => {
    const handleMessage = (event) => {
      // Verify message is from our iframe to prevent stale/cross-origin issues
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      if (event.data?.type === 'preview-console') {
        const { level, message, timestamp } = event.data;
        setLogs(prev => [...prev.slice(-199), { id: Date.now() + Math.random(), level, message, timestamp }]);
      } else if (event.data?.type === 'preview-element-selected') {
        setSelectedElement(event.data.element);
      } else if (event.data?.type === 'preview-inspector-ready') {
        // Inspector is ready, sync inspect mode state
        if (inspectMode && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage({ type: 'preview-inspect-mode', enabled: true }, '*');
        }
      } else if (event.data?.type === 'preview-send-to-terminal') {
        // Send element info to terminal
        if (onSendToTerminal && event.data.element) {
          const el = event.data.element;
          // Format element info for terminal - include selector and key details
          const parts = [`Element: ${el.selector}`];
          if (el.rect) {
            parts.push(`Size: ${el.rect.width}x${el.rect.height}px`);
          }
          if (el.className) {
            parts.push(`Classes: ${el.className}`);
          }
          // Get the outer HTML structure hint
          let htmlHint = `<${el.tagName}`;
          if (el.id) htmlHint += ` id="${el.id}"`;
          if (el.className) htmlHint += ` class="${el.className}"`;
          htmlHint += '>';
          parts.push(`HTML: ${htmlHint}`);

          const text = parts.join(' | ');
          onSendToTerminal(text);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [inspectMode, onSendToTerminal]);

  // Track if user scrolled away from bottom in logs
  const handleLogsScroll = useCallback(() => {
    const container = logsContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    isLogsNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  // Auto-scroll logs to bottom (only if user is near bottom)
  useEffect(() => {
    if (showLogs && logsEndRef.current && isLogsNearBottomRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'instant' });
    }
  }, [logs, showLogs]);

  // Clear logs and selection when URL changes
  useEffect(() => {
    setLogs([]);
    setSelectedElement(null);
    setInspectMode(false);
  }, [url]);

  // Focus URL input when shown
  useEffect(() => {
    if (showUrlInput && urlInputRef.current) {
      urlInputRef.current.focus();
      urlInputRef.current.select();
    }
  }, [showUrlInput]);

  const handleClearLogs = useCallback(async () => {
    setLogs([]);
    setProxyLogs([]);
    setProcessLogs([]);
    lastProxyLogTimestamp.current = 0;
    lastProcessLogTimestamp.current = 0;
    // Also clear on server
    if (previewPort) {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        // Clear client-side logs and proxy logs (process logs are not clearable)
        await Promise.all([
          fetch(`/api/preview/${previewPort}/logs`, { method: 'DELETE' }),
          fetch(`/api/preview/${previewPort}/proxy-logs`, { method: 'DELETE', headers })
        ]);
      } catch {
        // Ignore
      }
    }
  }, [previewPort]);

  const handleToggleInspect = useCallback(() => {
    const newMode = !inspectMode;
    setInspectMode(newMode);
    if (!newMode) {
      setSelectedElement(null);
    }
    // Send message to iframe
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-inspect-mode', enabled: newMode }, '*');
    }
  }, [inspectMode]);

  const handleClearSelection = useCallback(() => {
    setSelectedElement(null);
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-clear-selection' }, '*');
    }
  }, []);

  // Format element context for Claude and send
  const handleEditWithClaude = useCallback((description) => {
    if (!selectedElement || !onSendToClaudeCode) return;

    // Build context string for Claude
    const el = selectedElement;
    const parentPath = el.parentChain
      ? el.parentChain.map(p => p.selector).reverse().join(' > ')
      : '';

    let context = `I've selected an element in the preview that I'd like you to modify.\n\n`;
    context += `**Selected Element:**\n`;
    context += `- Selector: \`${el.fullSelector || el.selector}\`\n`;
    context += `- Tag: \`<${el.tagName}>\`\n`;
    if (el.id) context += `- ID: \`${el.id}\`\n`;
    if (el.className) context += `- Classes: \`${el.className}\`\n`;
    if (parentPath) context += `- Parent path: \`${parentPath}\`\n`;
    context += `- Size: ${el.rect.width} x ${el.rect.height}px\n`;

    // Add React component info if available
    if (el.react?.componentName) {
      context += `\n**React Component:**\n`;
      context += `- Component: \`<${el.react.componentName}>\`\n`;
      if (el.react.filePath) {
        context += `- Source: \`${el.react.filePath}${el.react.lineNumber ? ':' + el.react.lineNumber : ''}\`\n`;
      }
      if (Object.keys(el.react.props || {}).length > 0) {
        context += `- Props: \`${JSON.stringify(el.react.props)}\`\n`;
      }
    }

    // Add HTML snippet
    if (el.outerHTML) {
      const htmlSnippet = el.outerHTML.length > 500
        ? el.outerHTML.substring(0, 500) + '...'
        : el.outerHTML;
      context += `\n**HTML:**\n\`\`\`html\n${htmlSnippet}\n\`\`\`\n`;
    }

    // Add current styles
    const styles = el.extendedStyles || el.computedStyle;
    if (styles) {
      const relevantStyles = Object.entries(styles)
        .filter(([, v]) => v && v !== 'none' && v !== 'auto' && v !== 'normal')
        .slice(0, 10)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      if (relevantStyles) {
        context += `\n**Current Styles:** \`${relevantStyles}\`\n`;
      }
    }

    // Add user's requested change
    context += `\n**Requested Change:**\n${description}\n`;
    context += `\nPlease find and edit the relevant source file(s) to make this change.`;

    onSendToClaudeCode(context);
  }, [selectedElement, onSendToClaudeCode]);

  // Send style preview to iframe
  const handleStylePreview = useCallback((styles) => {
    if (!selectedElement?.elementId || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({
      type: 'preview-apply-style-preview',
      elementId: selectedElement.elementId,
      styles
    }, '*');
  }, [selectedElement]);

  // Revert style preview in iframe
  const handleStyleRevert = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage({
      type: 'preview-revert-style-preview'
    }, '*');
  }, []);

  // Copy element info to terminal
  const handleCopyToTerminal = useCallback(() => {
    if (!selectedElement || !onSendToTerminal) return;

    const el = selectedElement;
    const parts = [`Element: ${el.selector}`];
    if (el.rect) {
      parts.push(`Size: ${el.rect.width}x${el.rect.height}px`);
    }
    if (el.className) {
      parts.push(`Classes: ${el.className}`);
    }
    // HTML hint
    let htmlHint = `<${el.tagName}`;
    if (el.id) htmlHint += ` id="${el.id}"`;
    if (el.className) htmlHint += ` class="${el.className}"`;
    htmlHint += '>';
    parts.push(`HTML: ${htmlHint}`);

    onSendToTerminal(parts.join(' | '));
  }, [selectedElement, onSendToTerminal]);

  // Apply styles via Claude
  const handleStyleApply = useCallback((styles) => {
    if (!selectedElement || !onSendToClaudeCode) return;

    const el = selectedElement;
    const styleChanges = Object.entries(styles)
      .map(([prop, value]) => `${prop}: ${value}`)
      .join(';\n  ');

    let context = `I've made style changes to an element in the preview that I'd like you to apply to the source code.\n\n`;
    context += `**Selected Element:**\n`;
    context += `- Selector: \`${el.fullSelector || el.selector}\`\n`;
    if (el.react?.componentName) {
      context += `- React Component: \`<${el.react.componentName}>\`\n`;
      if (el.react.filePath) {
        context += `- Source: \`${el.react.filePath}\`\n`;
      }
    }

    context += `\n**Style Changes to Apply:**\n\`\`\`css\n${el.selector} {\n  ${styleChanges};\n}\n\`\`\`\n`;
    context += `\nPlease find and edit the relevant CSS/style file(s) to apply these changes. `;
    context += `If this is a React component, you may need to update inline styles, styled-components, CSS modules, or Tailwind classes as appropriate.`;

    // Revert preview before sending to Claude
    handleStyleRevert();
    setShowStyleEditor(false);
    onSendToClaudeCode(context);
  }, [selectedElement, onSendToClaudeCode, handleStyleRevert]);

  useEffect(() => {
    setInputUrl(url || '');
  }, [url]);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setError(null);
  }, []);

  // Fallback: if iframe doesn't fire onLoad within 5s, show it anyway
  // (some apps like Next.js dev mode may delay the load event)
  useEffect(() => {
    if (!isLoading || !iframeSrc) return;
    const timeout = setTimeout(() => {
      if (isLoading) {
        console.log('[Preview] Load timeout - showing iframe anyway');
        setIsLoading(false);
      }
    }, 5000);
    return () => clearTimeout(timeout);
  }, [isLoading, iframeSrc]);

  const handleError = useCallback(() => {
    setIsLoading(false);
    setError('Failed to load page. The server may not be running or CORS may be blocking the request.');
  }, []);

  const handleRefresh = useCallback(() => {
    if (baseIframeSrc) {
      setIsLoading(true);
      setError(null);
      setLogs([]);
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
    setShowUrlInput(false);
  }, [inputUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    if (iframeSrc) {
      window.open(iframeSrc, '_blank', 'noopener,noreferrer');
    }
  }, [iframeSrc]);

  // Truncate URL for display
  const displayUrl = useMemo(() => {
    if (!url) return 'No URL';
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname !== '/' ? parsed.pathname : ''}`;
    } catch {
      return url.length > 30 ? url.substring(0, 30) + '...' : url;
    }
  }, [url]);

  // Merge and filter logs (memoized for performance)
  const filteredLogs = useMemo(() => {
    const allLogs = [];
    if (logFilter === 'all' || logFilter === 'client') {
      logs.forEach(log => allLogs.push({ ...log, source: 'client' }));
    }
    if (logFilter === 'all' || logFilter === 'proxy') {
      proxyLogs.forEach(log => allLogs.push({
        id: log.id,
        timestamp: log.timestamp,
        source: 'proxy',
        method: log.method,
        url: log.url,
        status: log.status,
        duration: log.duration,
        error: log.error,
        contentType: log.contentType,
        responseSize: log.responseSize
      }));
    }
    if (logFilter === 'all' || logFilter === 'server') {
      processLogs.forEach(log => allLogs.push({
        id: log.id || `proc-${log.timestamp}-${Math.random()}`,
        timestamp: log.timestamp,
        source: 'server',
        stream: log.stream,  // 'stdout' or 'stderr'
        data: log.data
      }));
    }
    // Sort by timestamp
    allLogs.sort((a, b) => a.timestamp - b.timestamp);
    return allLogs;
  }, [logs, proxyLogs, processLogs, logFilter]);

  // Mobile layout
  if (isMobile) {
    return (
      <div className="preview-panel preview-panel-mobile">
        {/* Full-screen iframe */}
        <div className="preview-content-mobile">
          {!iframeSrc ? (
            <div className="preview-empty">
              {projectInfo && projectInfo.projectType !== 'unknown' ? (
                <>
                  <div className="preview-empty-icon">{projectInfo.projectType === 'static' ? '\u{1F4C4}' : '\u{1F4E6}'}</div>
                  <h3>{projectInfo.projectName || projectInfo.projectType.charAt(0).toUpperCase() + projectInfo.projectType.slice(1)} Project</h3>
                  {projectInfo.projectType === 'static' ? (
                    <>
                      <p>Static site detected.</p>
                      <button
                        type="button"
                        className="btn-primary project-action-btn"
                        onClick={() => onUrlChange && onUrlChange(projectInfo.indexPath)}
                      >
                        Open Static Site
                      </button>
                    </>
                  ) : projectInfo.startCommand ? (
                    <>
                      <p>Run the dev server:</p>
                      <button
                        type="button"
                        className="btn-primary project-action-btn"
                        onClick={() => onStartProject && onStartProject(projectInfo.startCommand)}
                      >
                        {projectInfo.startCommand}
                      </button>
                    </>
                  ) : (
                    <p>No start script detected.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="preview-empty-icon">{'\u{1F4BB}'}</div>
                  <h3>No URL</h3>
                  <p>Start a dev server or enter a URL</p>
                </>
              )}
            </div>
          ) : error ? (
            <div className="preview-error">
              <div className="preview-error-icon">{'\u26A0'}</div>
              <h3>Load Error</h3>
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
                  <p>Loading...</p>
                </div>
              )}
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                className="preview-iframe"
                onLoad={handleLoad}
                onError={handleError}
                title="Browser"
                allow="camera; microphone"
                style={{ opacity: isLoading ? 0 : 1 }}
              />
            </>
          )}
        </div>

        {/* Floating URL bar at top */}
        <div className="preview-floating-url">
          {/* Port selector button */}
          <button
            type="button"
            className={`preview-floating-btn preview-port-btn-mobile ${showPortDropdown ? 'active' : ''}`}
            onClick={() => setShowPortDropdown(!showPortDropdown)}
            aria-label="Select port"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
            </svg>
            {activePorts.filter(p => p.listening).length > 0 && (
              <span className="preview-port-badge-mobile">{activePorts.filter(p => p.listening).length}</span>
            )}
          </button>
          {showUrlInput ? (
            <form className="preview-url-form-mobile" onSubmit={handleUrlSubmit}>
              <input
                ref={urlInputRef}
                type="text"
                className="preview-url-input-mobile"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                placeholder="Enter URL..."
                onBlur={() => setTimeout(() => setShowUrlInput(false), 200)}
              />
            </form>
          ) : (
            <button
              type="button"
              className="preview-url-display"
              onClick={() => setShowUrlInput(true)}
            >
              {displayUrl}
            </button>
          )}
          {/* Cookie clear button - only shown when cookies exist */}
          {previewPort && hasCookies && (
            <button
              type="button"
              className="preview-floating-btn preview-cookie-btn-mobile"
              onClick={handleClearCookies}
              aria-label="Clear cookies"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 12h8" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="preview-floating-btn"
            onClick={handleRefresh}
            disabled={!iframeSrc}
            aria-label="Refresh"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            type="button"
            className="preview-floating-btn preview-close-btn-mobile"
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Port selector dropdown */}
        {showPortDropdown && (
          <div className="preview-port-sheet" ref={portDropdownRef}>
            <div className="preview-port-sheet-header">
              <span>Active Ports</span>
              <button
                type="button"
                className="preview-port-sheet-close"
                onClick={() => setShowPortDropdown(false)}
                aria-label="Close"
              >
                {'\u00D7'}
              </button>
            </div>
            {activePorts.length === 0 ? (
              <div className="preview-port-sheet-empty">No active ports found</div>
            ) : (
              <div className="preview-port-sheet-list">
                {activePorts.map(({ port, listening, previewed, process, cwd }) => (
                  <button
                    key={port}
                    type="button"
                    className={`preview-port-sheet-item ${port === previewPort ? 'current' : ''}`}
                    onClick={() => handleSelectPort(port)}
                  >
                    <span className="preview-port-sheet-number">:{port}</span>
                    {(cwd || process) && <span className="preview-port-sheet-process">{cwd || process}</span>}
                    <span className="preview-port-sheet-status">
                      {listening && <span className="preview-port-dot listening" title="Listening" />}
                      {previewed && <span className="preview-port-dot previewed" title="Previously viewed" />}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Console bottom sheet */}
        <div className={`preview-console-sheet ${showLogs ? 'open' : ''}`}>
          <div className="preview-console-header" onClick={() => setShowLogs(!showLogs)}>
            <div className="preview-console-handle" />
            <span className="preview-console-title">Logs {(logs.length + proxyLogs.length + processLogs.length) > 0 && `(${logs.length + proxyLogs.length + processLogs.length})`}</span>
            {showLogs && (
              <select
                className="preview-logs-filter-mobile"
                value={logFilter}
                onChange={(e) => { e.stopPropagation(); setLogFilter(e.target.value); }}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="all">All</option>
                <option value="server">Server</option>
                <option value="proxy">Network</option>
                <option value="client">Console</option>
              </select>
            )}
            <button
              type="button"
              className="preview-console-clear"
              onClick={(e) => { e.stopPropagation(); handleClearLogs(); }}
            >
              Clear
            </button>
          </div>
          <div className="preview-console-content" ref={logsContainerRef} onScroll={handleLogsScroll}>
            {filteredLogs.length === 0 ? (
              <div className="preview-logs-empty">No logs yet</div>
            ) : (
              filteredLogs.map((log) => {
                if (log.source === 'client') {
                  return (
                    <div key={`c-${log.id}`} className={`preview-log-entry preview-log-${log.level}`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className="preview-log-message">{log.message}</span>
                    </div>
                  );
                } else if (log.source === 'server') {
                  const isError = log.stream === 'stderr';
                  return (
                    <div key={`s-${log.id}`} className={`preview-log-entry preview-log-server ${isError ? 'preview-log-stderr' : 'preview-log-stdout'}`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className={`preview-log-stream ${isError ? 'stderr' : 'stdout'}`}>{log.stream}</span>
                      <span className="preview-log-data">{log.data}</span>
                    </div>
                  );
                } else {
                  const statusClass = log.error ? 'error' : (log.status >= 400 ? 'warn' : 'info');
                  const statusText = log.error ? 'ERR' : log.status;
                  return (
                    <div key={`p-${log.id}`} className={`preview-log-entry preview-log-${statusClass} preview-log-network`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className={`preview-log-status preview-log-status-${statusClass}`}>{statusText}</span>
                      <span className="preview-log-method">{log.method}</span>
                      <span className="preview-log-url" title={log.url}>{log.url}</span>
                    </div>
                  );
                }
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

        {/* Element inspector bottom sheet */}
        {selectedElement && (
          <div className="preview-inspector-sheet">
            <div className="preview-inspector-sheet-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
              </svg>
              <span>Element Inspector</span>
              <button
                type="button"
                className="preview-inspector-sheet-close"
                onClick={handleClearSelection}
                aria-label="Close"
              >
                {'\u00D7'}
              </button>
            </div>
            <div className="preview-inspector-sheet-content">
              <div className="preview-inspector-selector">
                <code>{selectedElement.selector}</code>
              </div>
              <div className="preview-inspector-section">
                <div className="preview-inspector-label">Element</div>
                <div className="preview-inspector-value">
                  <span className="preview-inspector-tag">&lt;{selectedElement.tagName}</span>
                  {selectedElement.id && <span className="preview-inspector-id">#{selectedElement.id}</span>}
                  {selectedElement.className && (
                    <span className="preview-inspector-class">
                      .{selectedElement.className.split(' ').filter(c => c).join('.')}
                    </span>
                  )}
                  <span className="preview-inspector-tag">&gt;</span>
                </div>
              </div>
              <div className="preview-inspector-section">
                <div className="preview-inspector-label">Size</div>
                <div className="preview-inspector-value">
                  {selectedElement.rect.width} x {selectedElement.rect.height}px
                </div>
              </div>
              {selectedElement.textContent && (
                <div className="preview-inspector-section">
                  <div className="preview-inspector-label">Text</div>
                  <div className="preview-inspector-text">
                    {selectedElement.textContent.length > 80
                      ? selectedElement.textContent.substring(0, 80) + '...'
                      : selectedElement.textContent}
                  </div>
                </div>
              )}
              {/* React Component Info */}
              {selectedElement.react?.componentName && (
                <div className="preview-inspector-section preview-inspector-react">
                  <div className="preview-inspector-label">React</div>
                  <div className="preview-inspector-value">
                    <span className="preview-inspector-component">&lt;{selectedElement.react.componentName}&gt;</span>
                  </div>
                </div>
              )}
            </div>
            {/* Actions - Mobile */}
            {onSendToClaudeCode && (
              <div className="preview-inspector-sheet-actions">
                {showEditInput ? (
                  <form
                    className="preview-inspector-edit-form-mobile"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editDescription.trim()) {
                        handleEditWithClaude(editDescription.trim());
                        setEditDescription('');
                        setShowEditInput(false);
                      }
                    }}
                  >
                    <input
                      type="text"
                      className="preview-inspector-edit-input"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Describe the change..."
                      autoFocus
                    />
                    <button type="submit" className="preview-inspector-edit-submit" disabled={!editDescription.trim()}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="22" y1="2" x2="11" y2="13"/>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                      </svg>
                    </button>
                  </form>
                ) : (
                  <div className="preview-inspector-btns-mobile">
                    <button
                      type="button"
                      className="preview-inspector-edit-btn-mobile"
                      onClick={() => setShowEditInput(true)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9"/>
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                      </svg>
                      Edit with Claude
                    </button>
                    <button
                      type="button"
                      className={`preview-inspector-style-btn-mobile ${showStyleEditor ? 'active' : ''}`}
                      onClick={() => setShowStyleEditor(!showStyleEditor)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="13.5" cy="6.5" r="2.5"/>
                        <circle cx="19" cy="17" r="2"/>
                        <circle cx="6" cy="12" r="2.5"/>
                        <path d="M9.5 10.5L14 6.5"/>
                        <path d="M16 8.5l2 6"/>
                        <path d="M8 14l5 2"/>
                      </svg>
                      Styles
                    </button>
                    {onSendToTerminal && (
                      <button
                        type="button"
                        className="preview-inspector-terminal-btn-mobile"
                        onClick={handleCopyToTerminal}
                        title="Copy element info to terminal"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                        Terminal
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Style Editor - Mobile */}
            {showStyleEditor && (
              <StyleEditor
                element={selectedElement}
                onStyleChange={handleStylePreview}
                onApply={handleStyleApply}
                onRevert={handleStyleRevert}
                isMobile={true}
              />
            )}
          </div>
        )}

        {/* Floating action buttons bottom-right */}
        <div className={`preview-floating-actions ${selectedElement ? 'with-inspector' : ''}`}>
          <button
            type="button"
            className={`preview-floating-btn ${inspectMode ? 'active' : ''}`}
            onClick={handleToggleInspect}
            disabled={!iframeSrc}
            aria-label={inspectMode ? 'Exit inspect mode' : 'Inspect elements'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
              <path d="M13 13l6 6" />
            </svg>
          </button>
          <button
            type="button"
            className="preview-floating-btn"
            onClick={handleOpenExternal}
            disabled={!iframeSrc}
            aria-label="Open in new tab"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          <button
            type="button"
            className={`preview-floating-btn ${showLogs ? 'active' : ''}`}
            onClick={() => setShowLogs(!showLogs)}
            aria-label="Toggle console"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            {(logs.length + proxyLogs.length + processLogs.length) > 0 && <span className="preview-log-badge">{logs.length + proxyLogs.length + processLogs.length}</span>}
          </button>
        </div>
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="preview-panel">
      <div className="preview-header">
        <div className="preview-title">
          <span className="preview-icon">{'\u2699'}</span>
          <span>Browser</span>
        </div>
        {/* Port selector dropdown */}
        <div className="preview-port-selector" ref={portDropdownRef}>
          <button
            type="button"
            className={`preview-port-btn ${showPortDropdown ? 'active' : ''}`}
            onClick={() => setShowPortDropdown(!showPortDropdown)}
            title="Select active port"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
            </svg>
            {activePorts.filter(p => p.listening).length > 0 && (
              <span className="preview-port-badge">{activePorts.filter(p => p.listening).length}</span>
            )}
          </button>
          {showPortDropdown && (
            <div className="preview-port-dropdown">
              <div className="preview-port-dropdown-header">Active Ports</div>
              {activePorts.length === 0 ? (
                <div className="preview-port-dropdown-empty">No active ports found</div>
              ) : (
                <div className="preview-port-dropdown-list">
                  {activePorts.map(({ port, listening, previewed, process, cwd }) => (
                    <button
                      key={port}
                      type="button"
                      className={`preview-port-item ${port === previewPort ? 'current' : ''}`}
                      onClick={() => handleSelectPort(port)}
                    >
                      <span className="preview-port-info">
                        <span className="preview-port-number">:{port}</span>
                        {(cwd || process) && <span className="preview-port-process">{cwd || process}</span>}
                      </span>
                      <span className="preview-port-status">
                        {listening && <span className="preview-port-dot listening" title="Listening" />}
                        {previewed && <span className="preview-port-dot previewed" title="Previously viewed" />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
            className={`preview-action-btn ${inspectMode ? 'active' : ''}`}
            onClick={handleToggleInspect}
            title={inspectMode ? 'Exit inspect mode' : 'Inspect elements'}
            disabled={!iframeSrc}
            aria-label="Inspect elements"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
              <path d="M13 13l6 6" />
            </svg>
          </button>
          {previewPort && (
            <button
              type="button"
              className={`preview-action-btn ${hasCookies ? 'has-cookies' : ''}`}
              onClick={handleClearCookies}
              title={hasCookies ? 'Clear stored cookies (logged in)' : 'No cookies stored'}
              disabled={!hasCookies}
              aria-label="Clear cookies"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 12h8" />
                {hasCookies && <circle cx="12" cy="12" r="3" fill="currentColor" />}
              </svg>
            </button>
          )}
          <button
            type="button"
            className="preview-action-btn"
            onClick={handleRefresh}
            title="Refresh"
            disabled={!iframeSrc}
            aria-label="Refresh"
          >
            {'\u21BB'}
          </button>
          <button
            type="button"
            className="preview-action-btn"
            onClick={handleOpenExternal}
            title="Open in new tab"
            disabled={!iframeSrc}
            aria-label="Open in new tab"
          >
            {'\u2197'}
          </button>
          <button
            type="button"
            className="preview-action-btn preview-close-btn"
            onClick={onClose}
            title="Close browser"
            aria-label="Close browser"
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
                      Open Static Site
                    </button>
                  </>
                ) : projectInfo.startCommand ? (
                  <>
                    <p>Run the dev server:</p>
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
                <h3>No URL</h3>
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
            <h3>Load Error</h3>
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
                <p>Loading...</p>
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              className="preview-iframe"
              onLoad={handleLoad}
              onError={handleError}
              title="Browser"
              allow="camera; microphone"
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
            Logs
            {(logs.length + proxyLogs.length + processLogs.length) > 0 && (
              <span className="preview-logs-count">{logs.length + proxyLogs.length + processLogs.length}</span>
            )}
          </span>
          <div className="preview-logs-actions">
            {showLogs && (
              <>
                <select
                  className="preview-logs-filter"
                  value={logFilter}
                  onChange={(e) => { e.stopPropagation(); setLogFilter(e.target.value); }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="all">All</option>
                  <option value="server">Server ({processLogs.length})</option>
                  <option value="proxy">Network ({proxyLogs.length})</option>
                  <option value="client">Console ({logs.length})</option>
                </select>
                <button
                  type="button"
                  className="preview-logs-btn"
                  onClick={(e) => { e.stopPropagation(); handleClearLogs(); }}
                  title="Clear logs"
                >
                  Clear
                </button>
              </>
            )}
            <span className="preview-logs-toggle">{showLogs ? '\u25BC' : '\u25B2'}</span>
          </div>
        </div>
        {showLogs && (
          <div className="preview-logs-content" ref={logsContainerRef} onScroll={handleLogsScroll}>
            {filteredLogs.length === 0 ? (
              <div className="preview-logs-empty">No logs yet</div>
            ) : (
              filteredLogs.map((log) => {
                if (log.source === 'client') {
                  return (
                    <div key={`c-${log.id}`} className={`preview-log-entry preview-log-${log.level}`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className="preview-log-level">{log.level}</span>
                      <span className="preview-log-message">{log.message}</span>
                    </div>
                  );
                } else if (log.source === 'server') {
                  // Process log (stdout/stderr)
                  const isError = log.stream === 'stderr';
                  return (
                    <div key={`s-${log.id}`} className={`preview-log-entry preview-log-server ${isError ? 'preview-log-stderr' : 'preview-log-stdout'}`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className={`preview-log-stream ${isError ? 'stderr' : 'stdout'}`}>{log.stream}</span>
                      <span className="preview-log-data">{log.data}</span>
                    </div>
                  );
                } else {
                  // Proxy log
                  const statusClass = log.error ? 'error' : (log.status >= 400 ? 'warn' : 'info');
                  const statusText = log.error ? 'ERR' : log.status;
                  const sizeText = log.responseSize ? `${(log.responseSize / 1024).toFixed(1)}KB` : '';
                  return (
                    <div key={`p-${log.id}`} className={`preview-log-entry preview-log-${statusClass} preview-log-network`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <span className={`preview-log-status preview-log-status-${statusClass}`}>{statusText}</span>
                      <span className="preview-log-method">{log.method}</span>
                      <span className="preview-log-url" title={log.url}>{log.url}</span>
                      <span className="preview-log-meta">
                        {log.duration}ms {sizeText}
                      </span>
                      {log.error && <span className="preview-log-error">{log.error}</span>}
                    </div>
                  );
                }
              })
            )}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* Element Inspector Panel */}
      {selectedElement && (
        <div className="preview-inspector">
          <div className="preview-inspector-header">
            <span className="preview-inspector-title">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
              </svg>
              Element Inspector
            </span>
            <button
              type="button"
              className="preview-inspector-close"
              onClick={handleClearSelection}
              aria-label="Close inspector"
            >
              {'\u00D7'}
            </button>
          </div>
          <div className="preview-inspector-content">
            <div className="preview-inspector-selector">
              <code>{selectedElement.selector}</code>
            </div>
            <div className="preview-inspector-section">
              <div className="preview-inspector-label">Element</div>
              <div className="preview-inspector-value">
                <span className="preview-inspector-tag">&lt;{selectedElement.tagName}</span>
                {selectedElement.id && <span className="preview-inspector-id">#{selectedElement.id}</span>}
                {selectedElement.className && (
                  <span className="preview-inspector-class">
                    .{selectedElement.className.split(' ').filter(c => c).join('.')}
                  </span>
                )}
                <span className="preview-inspector-tag">&gt;</span>
              </div>
            </div>
            <div className="preview-inspector-section">
              <div className="preview-inspector-label">Dimensions</div>
              <div className="preview-inspector-value">
                {selectedElement.rect.width} × {selectedElement.rect.height}px
                <span className="preview-inspector-muted"> at ({selectedElement.rect.x}, {selectedElement.rect.y})</span>
              </div>
            </div>
            {Object.keys(selectedElement.attributes).length > 0 && (
              <div className="preview-inspector-section">
                <div className="preview-inspector-label">Attributes</div>
                <div className="preview-inspector-attrs">
                  {Object.entries(selectedElement.attributes).map(([name, value]) => (
                    <div key={name} className="preview-inspector-attr">
                      <span className="preview-inspector-attr-name">{name}</span>
                      <span className="preview-inspector-attr-value">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="preview-inspector-section">
              <div className="preview-inspector-label">Computed Styles</div>
              <div className="preview-inspector-styles">
                {Object.entries(selectedElement.computedStyle).map(([prop, value]) => (
                  <div key={prop} className="preview-inspector-style">
                    <span className="preview-inspector-style-prop">{prop}</span>
                    <span className="preview-inspector-style-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
            {selectedElement.textContent && (
              <div className="preview-inspector-section">
                <div className="preview-inspector-label">Text Content</div>
                <div className="preview-inspector-text">
                  {selectedElement.textContent.length > 100
                    ? selectedElement.textContent.substring(0, 100) + '...'
                    : selectedElement.textContent}
                </div>
              </div>
            )}
            {/* React Component Info */}
            {selectedElement.react?.componentName && (
              <div className="preview-inspector-section preview-inspector-react">
                <div className="preview-inspector-label">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="12" r="2.5"/>
                    <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                    <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(60 12 12)"/>
                    <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" strokeWidth="1.5" transform="rotate(120 12 12)"/>
                  </svg>
                  React
                </div>
                <div className="preview-inspector-value">
                  <span className="preview-inspector-component">&lt;{selectedElement.react.componentName}&gt;</span>
                  {selectedElement.react.filePath && (
                    <span className="preview-inspector-muted"> {selectedElement.react.filePath.split('/').pop()}</span>
                  )}
                </div>
                {Object.keys(selectedElement.react.props || {}).length > 0 && (
                  <div className="preview-inspector-props">
                    {Object.entries(selectedElement.react.props).slice(0, 5).map(([name, value]) => (
                      <div key={name} className="preview-inspector-prop">
                        <span className="preview-inspector-prop-name">{name}</span>
                        <span className="preview-inspector-prop-value">
                          {typeof value === 'string' ? `"${value}"` : String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Actions: Edit with Claude or Style Editor */}
          {onSendToClaudeCode && (
            <div className="preview-inspector-actions">
              {showEditInput ? (
                <form
                  className="preview-inspector-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editDescription.trim()) {
                      handleEditWithClaude(editDescription.trim());
                      setEditDescription('');
                      setShowEditInput(false);
                    }
                  }}
                >
                  <input
                    type="text"
                    className="preview-inspector-edit-input"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Describe the change..."
                    autoFocus
                  />
                  <button type="submit" className="preview-inspector-edit-submit" disabled={!editDescription.trim()}>
                    Send
                  </button>
                  <button
                    type="button"
                    className="preview-inspector-edit-cancel"
                    onClick={() => { setShowEditInput(false); setEditDescription(''); }}
                  >
                    {'\u00D7'}
                  </button>
                </form>
              ) : (
                <div className="preview-inspector-btns">
                  <button
                    type="button"
                    className="preview-inspector-edit-btn"
                    onClick={() => setShowEditInput(true)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9"/>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                    </svg>
                    Edit with Claude
                  </button>
                  <button
                    type="button"
                    className={`preview-inspector-style-btn ${showStyleEditor ? 'active' : ''}`}
                    onClick={() => setShowStyleEditor(!showStyleEditor)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="13.5" cy="6.5" r="2.5"/>
                      <circle cx="19" cy="17" r="2"/>
                      <circle cx="6" cy="12" r="2.5"/>
                      <path d="M9.5 10.5L14 6.5"/>
                      <path d="M16 8.5l2 6"/>
                      <path d="M8 14l5 2"/>
                    </svg>
                    Styles
                  </button>
                  {onSendToTerminal && (
                    <button
                      type="button"
                      className="preview-inspector-terminal-btn"
                      onClick={handleCopyToTerminal}
                      title="Copy element info to terminal"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                      </svg>
                      Terminal
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Style Editor Panel */}
          {showStyleEditor && selectedElement && (
            <StyleEditor
              element={selectedElement}
              onStyleChange={handleStylePreview}
              onApply={handleStyleApply}
              onRevert={handleStyleRevert}
            />
          )}
        </div>
      )}
    </div>
  );
}
