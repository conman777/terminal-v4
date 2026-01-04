import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { getAccessToken } from '../utils/auth';

// Convert URL for iframe display (simplified from PreviewPanel)
function toPreviewUrl(inputUrl) {
  if (!inputUrl) return null;

  const token = getAccessToken();
  const withToken = (url) => {
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
  };

  // Handle localhost URLs - use preview subdomain
  try {
    const parsed = new URL(inputUrl);
    const hostname = parsed.hostname;
    const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
    const isPrivateIP = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname);

    if ((isLocalhost || isPrivateIP) && parsed.port) {
      const path = parsed.pathname + parsed.search + parsed.hash;
      return `https://preview-${parsed.port}.conordart.com${path}`;
    }
  } catch {
    // Not a valid URL
  }

  // External URLs - route through proxy
  try {
    const parsed = new URL(inputUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return withToken(`/api/proxy-external?url=${encodeURIComponent(inputUrl)}`);
    }
  } catch {
    // Not a valid URL
  }

  return inputUrl;
}

/**
 * Picture-in-Picture preview window.
 * Floating, draggable, resizable preview that stays on top.
 */
export function PreviewPip({
  url,
  position,
  size,
  onPositionChange,
  onSizeChange,
  onClose,
  onDock,
  onMinimize
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const containerRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  const iframeSrc = useMemo(() => toPreviewUrl(url), [url]);

  // Default position and size
  const pos = position || { x: window.innerWidth - 420, y: 80 };
  const sz = size || { width: 400, height: 300 };

  // Drag handlers
  const handleDragStart = useCallback((e) => {
    if (e.target.closest('.pip-resize-handle')) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: pos.x,
      posY: pos.y
    };
  }, [pos.x, pos.y]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      const newX = Math.max(0, Math.min(window.innerWidth - sz.width, dragStartRef.current.posX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - sz.height, dragStartRef.current.posY + dy));
      onPositionChange?.({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, sz.width, sz.height, onPositionChange]);

  // Resize handlers
  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: sz.width,
      height: sz.height
    };
  }, [sz.width, sz.height]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e) => {
      const dx = e.clientX - resizeStartRef.current.x;
      const dy = e.clientY - resizeStartRef.current.y;
      const newWidth = Math.max(280, Math.min(800, resizeStartRef.current.width + dx));
      const newHeight = Math.max(200, Math.min(600, resizeStartRef.current.height + dy));
      onSizeChange?.({ width: newWidth, height: newHeight });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, onSizeChange]);

  const handleLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleRefresh = useCallback(() => {
    if (containerRef.current) {
      const iframe = containerRef.current.querySelector('iframe');
      if (iframe) {
        setIsLoading(true);
        iframe.src = iframe.src;
      }
    }
  }, []);

  const handleToggleMinimize = useCallback(() => {
    setIsMinimized(prev => !prev);
  }, []);

  if (!url) return null;

  return (
    <div
      ref={containerRef}
      className={`preview-pip${isDragging ? ' dragging' : ''}${isResizing ? ' resizing' : ''}${isMinimized ? ' minimized' : ''}`}
      style={{
        left: pos.x,
        top: pos.y,
        width: isMinimized ? 200 : sz.width,
        height: isMinimized ? 36 : sz.height
      }}
    >
      {/* Header - draggable */}
      <div className="pip-header" onMouseDown={handleDragStart}>
        <span className="pip-title">Preview</span>
        <div className="pip-actions">
          <button
            type="button"
            className="pip-btn"
            onClick={handleRefresh}
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          <button
            type="button"
            className="pip-btn"
            onClick={handleToggleMinimize}
            title={isMinimized ? 'Expand' : 'Minimize'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            className="pip-btn"
            onClick={onDock}
            title="Dock to side panel"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
          <button
            type="button"
            className="pip-btn pip-close"
            onClick={onClose}
            title="Close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div className="pip-content">
          {isLoading && (
            <div className="pip-loading">
              <div className="pip-spinner" />
            </div>
          )}
          <iframe
            src={iframeSrc}
            className="pip-iframe"
            onLoad={handleLoad}
            title="Preview"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            style={{ opacity: isLoading ? 0 : 1 }}
          />
        </div>
      )}

      {/* Resize handle */}
      {!isMinimized && (
        <div
          className="pip-resize-handle"
          onMouseDown={handleResizeStart}
        />
      )}
    </div>
  );
}
