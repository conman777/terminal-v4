import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { toPreviewUrl, withAuthToken } from '../utils/previewUrl';
import { getAccessToken } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { isWebContainerSupported } from '../utils/webcontainer';
import { TerminalChat } from './TerminalChat';
import { StyleEditor } from './StyleEditor';
import { DevToolsPanel } from './devtools/DevToolsPanel';
import { WebContainerPreview } from './WebContainerPreview';

// Format timestamp for log display
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

const PREVIEW_STORAGE_KEY = 'terminal_preview_storage_v1';
const PREVIEW_STORAGE_MAX_BYTES = 200 * 1024;

function normalizePreviewUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value.trim();
  }
}

function readPreviewStorage() {
  try {
    const raw = localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function writePreviewStorage(data) {
  try {
    const payload = JSON.stringify(data);
    if (payload.length > PREVIEW_STORAGE_MAX_BYTES) {
      return false;
    }
    localStorage.setItem(PREVIEW_STORAGE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

function normalizeStorageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
  const result = {};
  Object.entries(snapshot).forEach(([key, value]) => {
    if (typeof key === 'string') {
      result[key] = value === null || value === undefined ? '' : String(value);
    }
  });
  return result;
}

// Tooltip component
function Tooltip({ children, text, shortcut }) {
  const [show, setShow] = useState(false);

  return (
    <div
      className="tooltip-wrapper"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div className="tooltip">
          <span className="tooltip-text">{text}</span>
          {shortcut && <span className="tooltip-shortcut">{shortcut}</span>}
        </div>
      )}
    </div>
  );
}

export function PreviewPanel({ url, onClose, onUrlChange, projectInfo, onStartProject, onSendToTerminal, onSendToClaudeCode, activeSessions = [], activeSessionId, fontSize = 14, webglEnabled, onUrlDetected, mainTerminalMinimized = false, onToggleMainTerminal }) {
  const isMobile = useMobileDetect();
  const getViewportHeight = useCallback(() => {
    if (typeof window === 'undefined') return 0;
    return window.visualViewport?.height || window.innerHeight;
  }, []);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [inputUrl, setInputUrl] = useState(url || '');
  const [logs, setLogs] = useState([]);  // Client-side logs from injected script
  const [proxyLogs, setProxyLogs] = useState([]);  // Server-side proxy logs
  const [processLogs, setProcessLogs] = useState([]);  // Process stdout/stderr logs
  const [storageData, setStorageData] = useState({ localStorage: {}, sessionStorage: {}, cookies: {} });
  const [showLogs, setShowLogs] = useState(false);
  const [showDevTools, setShowDevTools] = useState(() => !isMobile);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [logFilter, setLogFilter] = useState('all');  // 'all', 'client', 'proxy', 'server'
  const [logSearch, setLogSearch] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });
  const [inspectMode, setInspectMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showEditInput, setShowEditInput] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [showStyleEditor, setShowStyleEditor] = useState(false);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [hasCookies, setHasCookies] = useState(false);
  const [activePorts, setActivePorts] = useState([]);
  const [showPortDropdown, setShowPortDropdown] = useState(false);
  const [previewTerminalFitToken, setPreviewTerminalFitToken] = useState(0);
  // WebContainer mode state
  const [useWebContainer, setUseWebContainer] = useState(false);
  const [webContainerSupported, setWebContainerSupported] = useState(null);
  const [webContainerStatus, setWebContainerStatus] = useState(null);
  const iframeRef = useRef(null);
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const isLogsNearBottomRef = useRef(true);
  const urlInputRef = useRef(null);
  const portDropdownRef = useRef(null);
  const toolsMenuRef = useRef(null);
  const skipUrlSyncRef = useRef(false);
  const lastSyncedUrlRef = useRef(normalizePreviewUrl(url || ''));

  // Browser split view state (desktop) - enabled by default
  const [browserSplitEnabled, setBrowserSplitEnabled] = useState(!isMobile);
  const [browserSplitPosition, setBrowserSplitPosition] = useState(() => {
    try {
      const stored = localStorage.getItem('browser_split_position_v1');
      if (!stored) return 60; // Default to 60% browser, 40% terminal
      const parsed = parseInt(stored, 10);
      // Validate range (10-90%)
      if (isNaN(parsed) || parsed < 10 || parsed > 90) return 60;
      return parsed;
    } catch {
      return 60;
    }
  });
  const [terminalPosition, setTerminalPosition] = useState(() => {
    try {
      const stored = localStorage.getItem('browser_terminal_position_v1');
      return stored === 'left' ? 'left' : 'right';
    } catch {
      return 'right';
    }
  });
  const [selectedTerminalSession, setSelectedTerminalSession] = useState(null);
  const hasInitializedRef = useRef(false);
  const [previewTerminalRefreshToken, setPreviewTerminalRefreshToken] = useState(0);
  const handleRefreshPreviewTerminal = useCallback(() => {
    setPreviewTerminalRefreshToken(v => v + 1);
  }, []);
  const [isDraggingBrowserSplit, setIsDraggingBrowserSplit] = useState(false);
  const browserSplitRef = useRef(null);
  const resizeRafRef = useRef(null);

  // Mobile split view state (bottom sheet overlay)
  const [mobileSplitEnabled, setMobileSplitEnabled] = useState(false);
  const [mobileSplitHeight, setMobileSplitHeight] = useState(300);
  const [isDraggingMobileSplit, setIsDraggingMobileSplit] = useState(false);
  const mobileSplitStartY = useRef(0);
  const mobileSplitStartHeight = useRef(0);
  const mobileSplitRafRef = useRef(null);

  const baseIframeSrc = useMemo(() => {
    // Strip any existing _cb cache-buster params from the URL
    let cleanUrl = url;
    if (url) {
      try {
        const parsed = new URL(url, window.location.origin);
        // Remove all _cb params
        parsed.searchParams.delete('_cb');
        cleanUrl = parsed.toString();
      } catch {
        // If URL parsing fails, try regex fallback
        cleanUrl = url.replace(/([?&])_cb=[^&]*/g, '').replace(/\?&/, '?').replace(/\?$/, '');
      }
    }
    // Prevent viewing Terminal V4 in its own preview panel (port 3020)
    if (cleanUrl) {
      try {
        const parsed = new URL(cleanUrl, window.location.origin);
        const hostMatch = parsed.hostname.match(/preview-(\d+)\./);
        const pathMatch = parsed.pathname.match(/^\/preview\/(\d+)(\/|$)/);
        const hostPort = parsed.port ? parseInt(parsed.port, 10) : null;
        const previewPort = hostMatch ? parseInt(hostMatch[1], 10) : (pathMatch ? parseInt(pathMatch[1], 10) : null);
        const isLocalUiHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname);
        if (previewPort === 3020 || (isLocalUiHost && hostPort === 3020 && !pathMatch && !hostMatch)) {
          console.warn('[Preview] Cannot view Terminal V4 (port 3020) in its own preview panel');
          return null;
        }
      } catch {
        // Ignore parse failures, let toPreviewUrl handle
      }
    }
    const result = toPreviewUrl(cleanUrl);
    console.log('[Preview] URL conversion:', url, '->', result);
    return result;
  }, [url]);
  const [iframeSrc, setIframeSrc] = useState(baseIframeSrc);

  // Browser history navigation state
  const [historyStack, setHistoryStack] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Check WebContainer support on mount
  useEffect(() => {
    const support = isWebContainerSupported();
    setWebContainerSupported(support);
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
    let disposed = false;
    let pollTimer = null;

    const checkCookies = async () => {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`/api/preview/${previewPort}/cookies`, { headers });
        const data = await res.json();
        if (disposed) return false;
        setHasCookies(data.hasCookies);
        return true;
      } catch {
        if (disposed) return false;
        setHasCookies(false);
        return false;
      }
    };

    const schedule = (succeeded = true) => {
      if (disposed) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      pollTimer = setTimeout(async () => {
        const ok = await checkCookies();
        schedule(ok);
      }, succeeded ? 10000 : 20000);
    };

    const runNow = async () => {
      const ok = await checkCookies();
      schedule(ok);
    };

    void runNow();
    return () => {
      disposed = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [previewPort, isDocumentVisible]);

  const handleClearCookies = useCallback(async () => {
    if (!previewPort) return;
    try {
      // Capture iframe src before async to prevent stale state updates
      const currentIframeSrc = baseIframeSrc;
      const token = getAccessToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      await fetch(`/api/preview/${previewPort}/cookies`, { method: 'DELETE', headers });

      // Only update state if iframe src hasn't changed during the async operation
      if (currentIframeSrc === baseIframeSrc) {
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
      }
    } catch (err) {
      console.error('Failed to clear cookies:', err);
    }
  }, [previewPort, baseIframeSrc]);

  // Fetch active ports for the dropdown
  useEffect(() => {
    if (!isDocumentVisible) return;
    let disposed = false;
    let pollTimer = null;

    const fetchActivePorts = async () => {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/preview/active-ports', { headers });
        if (res.ok) {
          const data = await res.json();
          if (disposed) return false;
          setActivePorts(data.ports || []);
        }
        return true;
      } catch {
        // Ignore fetch errors
        return false;
      }
    };

    const schedule = (succeeded = true) => {
      if (disposed) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      pollTimer = setTimeout(async () => {
        const ok = await fetchActivePorts();
        schedule(ok);
      }, succeeded ? 5000 : 10000);
    };

    const runNow = async () => {
      const ok = await fetchActivePorts();
      schedule(ok);
    };

    void runNow();
    return () => {
      disposed = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
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

  useEffect(() => {
    if (!showToolsMenu) return;
    const handleClickOutside = (e) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target)) {
        setShowToolsMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showToolsMenu]);

  const handleSelectPort = useCallback((port) => {
    const newUrl = `http://localhost:${port}`;
    setInputUrl(newUrl);
    setShowPortDropdown(false);
    if (onUrlChange) {
      onUrlChange(newUrl);
    }
  }, [onUrlChange]);

  // Stream proxy/process logs with SSE (falls back to reconnect polling loop)
  const lastProxyLogTimestamp = useRef(0);
  const lastProcessLogTimestamp = useRef(0);
  useEffect(() => {
    if (!previewPort) {
      setProxyLogs([]);
      lastProcessLogTimestamp.current = 0;
      setProcessLogs([]);
      lastProxyLogTimestamp.current = 0;
      return;
    }
    if (!showLogs || !isDocumentVisible || logFilter === 'client') {
      return;
    }
    const types = logFilter === 'proxy'
      ? 'proxy'
      : (logFilter === 'server' ? 'server' : 'proxy,server');
    let disposed = false;
    let eventSource = null;
    let reconnectTimer = null;
    let retryDelayMs = 1000;

    const connect = () => {
      if (disposed) return;
      const token = getAccessToken();
      if (!token) return;
      const since = types === 'proxy'
        ? lastProxyLogTimestamp.current
        : (types === 'server'
            ? lastProcessLogTimestamp.current
            : Math.min(lastProxyLogTimestamp.current || 0, lastProcessLogTimestamp.current || 0));
      const params = new URLSearchParams({
        token,
        types,
        since: String(Math.max(0, since))
      });
      eventSource = new EventSource(`/api/preview/${previewPort}/log-stream?${params.toString()}`);

      eventSource.addEventListener('proxy', (event) => {
        if (disposed) return;
        try {
          const log = JSON.parse(event.data);
          if (!log || typeof log.timestamp !== 'number') return;
          setProxyLogs((prev) => {
            const next = [...prev, log];
            return next.slice(-200);
          });
          lastProxyLogTimestamp.current = Math.max(lastProxyLogTimestamp.current, log.timestamp);
        } catch {
          // Ignore malformed logs.
        }
      });

      eventSource.addEventListener('server', (event) => {
        if (disposed) return;
        try {
          const log = JSON.parse(event.data);
          if (!log || typeof log.timestamp !== 'number') return;
          setProcessLogs((prev) => {
            const next = [...prev, log];
            return next.slice(-200);
          });
          lastProcessLogTimestamp.current = Math.max(lastProcessLogTimestamp.current, log.timestamp);
        } catch {
          // Ignore malformed logs.
        }
      });

      eventSource.onerror = () => {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        if (disposed) return;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
        }
        reconnectTimer = setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 10000);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [previewPort, showLogs, isDocumentVisible, logFilter]);

  useEffect(() => {
    if (skipUrlSyncRef.current) {
      // Reset flag after a delay to prevent race conditions
      setTimeout(() => {
        skipUrlSyncRef.current = false;
      }, 100);
      return;
    }
    setIframeSrc(baseIframeSrc);
  }, [baseIframeSrc]);

  // Listen for messages from iframe (console logs, navigation, and element selection)
  useEffect(() => {
    const handleMessage = (event) => {
      // Verify message is from our iframe to prevent stale/cross-origin issues
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }

      if (event.data?.type === 'preview-console') {
        const { level, message, timestamp } = event.data;
        setLogs(prev => [...prev.slice(-199), { id: Date.now() + Math.random(), level, message, timestamp, type: 'console' }]);
      } else if (event.data?.type === 'preview-error') {
        // Capture runtime errors with full details like Chrome DevTools
        const { message, filename, lineno, colno, stack, timestamp } = event.data;
        setLogs(prev => [...prev.slice(-199), {
          id: Date.now() + Math.random(),
          level: 'error',
          message,
          timestamp,
          type: 'error',
          filename,
          lineno,
          colno,
          stack
        }]);
      } else if (event.data?.type === 'preview-element-selected') {
        setSelectedElement(event.data.element);
        setShowEditInput(true);
        setShowStyleEditor(false);
        setEditDescription('');
      } else if (event.data?.type === 'preview-inspector-ready') {
        // Inspector is ready, sync inspect mode state
        if (inspectMode && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage({ type: 'preview-inspect-mode', enabled: true }, '*');
        }
      } else if (event.data?.type === 'preview-location') {
        const nextUrl = event.data.url;
        if (!nextUrl || typeof nextUrl !== 'string') return;
        const normalizedNext = normalizePreviewUrl(nextUrl);
        if (!normalizedNext) return;
        const normalizedCurrent = normalizePreviewUrl(url);
        if (normalizedNext === normalizedCurrent || normalizedNext === lastSyncedUrlRef.current) {
          return;
        }
        lastSyncedUrlRef.current = normalizedNext;
        if (onUrlChange) {
          skipUrlSyncRef.current = true;
          // Batch URL change with requestAnimationFrame to prevent race conditions
          requestAnimationFrame(() => {
            onUrlChange(normalizedNext);
          });
        }
      } else if (event.data?.type === 'preview-storage-request') {
        const requestedPort = parseInt(event.data.port, 10);
        if (!requestedPort || requestedPort !== previewPort) return;
        const allStorage = readPreviewStorage();
        const stored = allStorage[requestedPort] || {};
        const localSnapshot = normalizeStorageSnapshot(stored.local);
        const sessionSnapshot = normalizeStorageSnapshot(stored.session);
        if (iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage({
            type: 'preview-storage-restore',
            port: requestedPort,
            local: localSnapshot,
            session: sessionSnapshot
          }, '*');
        }
      } else if (event.data?.type === 'preview-storage-sync') {
        const syncPort = parseInt(event.data.port, 10);
        if (!syncPort || syncPort !== previewPort) return;
        const localSnapshot = normalizeStorageSnapshot(event.data.local);
        const sessionSnapshot = normalizeStorageSnapshot(event.data.session);
        setStorageData(prev => ({
          ...prev,
          localStorage: localSnapshot,
          sessionStorage: sessionSnapshot
        }));
        const allStorage = readPreviewStorage();
        allStorage[syncPort] = { local: localSnapshot, session: sessionSnapshot };
        writePreviewStorage(allStorage);
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
  }, [inspectMode, onSendToTerminal, onUrlChange, url, previewPort]);

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
    if (skipUrlSyncRef.current) {
      skipUrlSyncRef.current = false;
      return;
    }
    let disposed = false;
    // Guard against stale state updates
    if (!disposed) {
      setLogs([]);
      setSelectedElement(null);
      setInspectMode(false);
      setShowEditInput(false);
      setShowStyleEditor(false);
      setEditDescription('');
    }
    return () => {
      disposed = true;
    };
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

  const handleClearProxyLogs = useCallback(async () => {
    setProxyLogs([]);
    lastProxyLogTimestamp.current = 0;
    if (previewPort) {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        await fetch(`/api/preview/${previewPort}/proxy-logs`, { method: 'DELETE', headers });
      } catch {
        // Ignore
      }
    }
  }, [previewPort]);

  const handleUpdateStorage = useCallback(async (storageType, operation, key, value) => {
    if (!previewPort) return;

    try {
      await apiFetch(`/api/preview/${previewPort}/storage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: storageType, operation, key, value })
      });

      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({
          type: 'preview-storage-operation',
          storageType,
          operation,
          key,
          value
        }, '*');
      }
    } catch (error) {
      console.error('Storage operation failed:', error);
    }
  }, [previewPort]);

  const handleEvaluate = useCallback(async (expression) => {
    if (!previewPort) return;

    try {
      if (iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage({
          type: 'preview-evaluate',
          expression
        }, '*');
      }

      await apiFetch(`/api/preview/${previewPort}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression })
      });
    } catch (error) {
      console.error('Evaluation failed:', error);
    }
  }, [previewPort]);

  const handleToggleInspect = useCallback(() => {
    const newMode = !inspectMode;
    setInspectMode(newMode);
    if (!newMode) {
      setSelectedElement(null);
      setShowEditInput(false);
      setShowStyleEditor(false);
      setEditDescription('');
    }

    // Lazy injection: reload iframe with/without __inspect parameter
    // This ensures the inspector script is only loaded when needed
    if (baseIframeSrc) {
      setIsLoading(true);
      setError(null);
      const cacheBuster = `_cb=${Date.now()}`;
      try {
        const url = new URL(baseIframeSrc, window.location.origin);
        if (newMode) {
          url.searchParams.set('__inspect', '1');
        } else {
          url.searchParams.delete('__inspect');
        }
        // Always add cache buster for fresh load
        url.searchParams.set('_cb', Date.now().toString());
        setIframeSrc(url.toString());
      } catch {
        // Fallback if URL parsing fails
        const separator = baseIframeSrc.includes('?') ? '&' : '?';
        const inspectParam = newMode ? '__inspect=1&' : '';
        setIframeSrc(`${baseIframeSrc}${separator}${inspectParam}${cacheBuster}`);
      }
    }

    // Send message to iframe (will be received after reload if inspector is injected)
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-inspect-mode', enabled: newMode }, '*');
    }
  }, [inspectMode, baseIframeSrc]);

  const handleClearSelection = useCallback(() => {
    setSelectedElement(null);
    setShowEditInput(false);
    setShowStyleEditor(false);
    setEditDescription('');
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-clear-selection' }, '*');
    }
  }, []);

  // Format element context for Claude and send
  // Send element info to terminal for Claude to see
  const handleSendElementToTerminal = useCallback(() => {
    if (!selectedElement || !onSendToTerminal) return;

    const el = selectedElement;
    const parentPath = el.parentChain
      ? el.parentChain.map(p => p.selector).reverse().join(' > ')
      : '';

    let text = `\n--- Selected Element ---\n`;
    text += `Selector: ${el.fullSelector || el.selector}\n`;
    text += `Tag: <${el.tagName}>\n`;
    if (el.id) text += `ID: ${el.id}\n`;
    if (el.className) text += `Classes: ${el.className}\n`;
    if (parentPath) text += `Parent path: ${parentPath}\n`;
    if (el.rect) text += `Size: ${Math.round(el.rect.width)} x ${Math.round(el.rect.height)}px\n`;

    // Add React component info if available
    if (el.react?.componentName) {
      text += `\nReact Component: <${el.react.componentName}>\n`;
      if (el.react.filePath) {
        text += `Source: ${el.react.filePath}${el.react.lineNumber ? ':' + el.react.lineNumber : ''}\n`;
      }
    }

    // Add HTML snippet (truncated)
    if (el.outerHTML) {
      const htmlSnippet = el.outerHTML.length > 300
        ? el.outerHTML.substring(0, 300) + '...'
        : el.outerHTML;
      text += `\nHTML:\n${htmlSnippet}\n`;
    }

    text += `--- End Element ---\n`;
    onSendToTerminal(text);
  }, [selectedElement, onSendToTerminal]);

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
  const handleCopyToTerminal = useCallback(async () => {
    if (!selectedElement) return;

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

    const text = parts.join(' | ');

    // Send to browser split terminal if available, otherwise use parent callback
    const targetSessionId = (browserSplitEnabled || mobileSplitEnabled) && selectedTerminalSession
      ? selectedTerminalSession
      : null;

    if (targetSessionId) {
      try {
        await apiFetch(`/api/terminal/${targetSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: text })
        });
      } catch (error) {
        console.error('Failed to send to terminal', error);
      }
    } else if (onSendToTerminal) {
      onSendToTerminal(text);
    }
  }, [selectedElement, onSendToTerminal, browserSplitEnabled, mobileSplitEnabled, selectedTerminalSession]);

  // Copy element info to clipboard
  const handleCopyElementInfo = useCallback(async () => {
    if (!selectedElement) return;

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

    const text = parts.join(' | ');

    let success = false;
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch (error) {
      // Fallback for contexts where clipboard API fails
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        success = true;
      } catch (fallbackError) {
        console.error('Failed to copy to clipboard', error, fallbackError);
      }
    }
    if (success) {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    }
  }, [selectedElement]);

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
    lastSyncedUrlRef.current = normalizePreviewUrl(url || '');
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
    const targetUrl = baseIframeSrc || iframeSrc;
    if (targetUrl) {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }, [baseIframeSrc, iframeSrc]);

  // Navigation handlers for browser history
  const handleBack = useCallback(() => {
    // Use functional setState to avoid stale closures
    setHistoryIndex(currentIndex => {
      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        setHistoryStack(currentStack => {
          const prevUrl = currentStack[prevIndex];
          if (onUrlChange && prevUrl) {
            // Batch with requestAnimationFrame to prevent race conditions
            requestAnimationFrame(() => {
              onUrlChange(prevUrl);
            });
          }
          return currentStack;
        });
        return prevIndex;
      }
      return currentIndex;
    });
  }, [onUrlChange]);

  const handleForward = useCallback(() => {
    // Use functional setState to avoid stale closures
    setHistoryIndex(currentIndex => {
      setHistoryStack(currentStack => {
        if (currentIndex < currentStack.length - 1) {
          const nextIndex = currentIndex + 1;
          const nextUrl = currentStack[nextIndex];
          if (onUrlChange && nextUrl) {
            // Batch with requestAnimationFrame to prevent race conditions
            requestAnimationFrame(() => {
              onUrlChange(nextUrl);
            });
          }
          // Update index in outer scope
          setHistoryIndex(nextIndex);
        }
        return currentStack;
      });
      return currentIndex;
    });
  }, [onUrlChange]);

  // Update history stack when URL changes (user navigation, not history navigation)
  useEffect(() => {
    if (!url) return;
    const normalizedUrl = normalizePreviewUrl(url);
    if (!normalizedUrl) return;

    // Check if this is a history navigation (URL matches current history position)
    if (historyIndex >= 0 && historyIndex < historyStack.length) {
      const currentHistoryUrl = normalizePreviewUrl(historyStack[historyIndex]);
      if (currentHistoryUrl === normalizedUrl) {
        return; // This is a history navigation, don't modify the stack
      }
    }

    // This is a new navigation, add to history
    setHistoryStack(prev => {
      // Remove any forward history
      const newStack = prev.slice(0, historyIndex + 1);
      // Add new URL if it's different from the last one
      if (newStack.length === 0 || normalizePreviewUrl(newStack[newStack.length - 1]) !== normalizedUrl) {
        newStack.push(normalizedUrl);
        setHistoryIndex(newStack.length - 1);
        return newStack;
      }
      return prev;
    });
  }, [url, historyIndex, historyStack]);

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

    // Apply search filter if present
    if (logSearch.trim()) {
      const searchLower = logSearch.toLowerCase();
      return allLogs.filter(log => {
        if (log.source === 'client') {
          return log.message.toLowerCase().includes(searchLower);
        } else if (log.source === 'server') {
          return log.data.toLowerCase().includes(searchLower);
        } else {
          // Network logs - search in method, url, or status
          return (
            log.method?.toLowerCase().includes(searchLower) ||
            log.url?.toLowerCase().includes(searchLower) ||
            String(log.status).includes(searchLower)
          );
        }
      });
    }

    return allLogs;
  }, [logs, proxyLogs, processLogs, logFilter, logSearch]);

  // Filter to only error logs
  const errorLogs = useMemo(() => {
    return filteredLogs.filter(log => {
      if (log.source === 'client') {
        return log.level === 'error';
      } else if (log.source === 'server') {
        return log.stream === 'stderr';
      } else {
        // Network logs - include failed requests
        return log.error || log.status >= 400;
      }
    });
  }, [filteredLogs]);

  const handleExportLogs = useCallback(() => {
    if (filteredLogs.length === 0) return;

    // Warn about large exports
    if (filteredLogs.length > 10000) {
      const confirmed = window.confirm(
        `You're about to export ${filteredLogs.length} log entries. This may take a moment and could freeze the UI. Continue?`
      );
      if (!confirmed) return;
    }

    const logText = filteredLogs.map(log => {
      const time = formatTime(log.timestamp);
      if (log.source === 'client') {
        return `[${time}] [${log.level.toUpperCase()}] ${log.message}`;
      } else if (log.source === 'server') {
        return `[${time}] [${log.stream.toUpperCase()}] ${log.data}`;
      } else {
        const status = log.error ? 'ERR' : log.status;
        return `[${time}] [${status}] ${log.method} ${log.url}`;
      }
    }).join('\n');

    // Copy to clipboard
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(logText).catch(err => {
        console.error('Failed to copy logs:', err);
      });
    } else {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = logText;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        console.error('Failed to copy logs:', err);
      } finally {
        document.body.removeChild(textArea);
      }
    }
  }, [filteredLogs]);

  // Compute breadcrumb path for inspector
  const elementPath = useMemo(() => {
    if (!selectedElement) return [];

    const path = [];
    let current = selectedElement;

    while (current && current.parentElement) {
      const tag = current.tagName?.toLowerCase() || 'unknown';
      const id = current.id ? `#${current.id}` : '';
      const classes = current.className && typeof current.className === 'string'
        ? `.${current.className.split(' ').filter(c => c).join('.')}`
        : '';

      path.unshift({
        tag,
        selector: `${tag}${id}${classes}`,
        element: current
      });

      current = current.parentElement;

      // Limit to 10 levels
      if (path.length >= 10) break;
    }

    return path;
  }, [selectedElement]);

  // Send error logs to terminal for Claude to see
  const handleSendLogsToTerminal = useCallback(() => {
    if (!onSendToTerminal || errorLogs.length === 0) return;

    const MAX_LOGS = 50;
    const logsToSend = errorLogs.slice(-MAX_LOGS);
    const totalCount = errorLogs.length;

    const header = `\n--- Browser Errors (${logsToSend.length}${totalCount > MAX_LOGS ? ` of ${totalCount}` : ''}) ---\n`;

    const formattedLogs = logsToSend.map(log => {
      const time = formatTime(log.timestamp);
      if (log.source === 'client') {
        return `[${time}] [ERROR] ${log.message}`;
      } else if (log.source === 'server') {
        return `[${time}] [STDERR] ${log.data}`;
      } else {
        const status = log.error ? 'ERR' : log.status;
        return `[${time}] [${status}] ${log.method} ${log.url}`;
      }
    }).join('\n');

    const footer = '\n--- End Errors ---\n';
    onSendToTerminal(header + formattedLogs + footer);
  }, [onSendToTerminal, errorLogs]);

  // Browser split handlers
  const handleBrowserSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDraggingBrowserSplit(true);
  }, []);

  const handleToggleTerminalSplit = useCallback(() => {
    setBrowserSplitEnabled(prev => !prev);
    setPreviewTerminalFitToken(token => token + 1);
  }, []);

  const handleToggleTerminalPosition = useCallback(() => {
    setTerminalPosition(prev => {
      const newPos = prev === 'right' ? 'left' : 'right';
      try {
        localStorage.setItem('browser_terminal_position_v1', newPos);
      } catch {}
      return newPos;
    });
    setPreviewTerminalFitToken(token => token + 1);
  }, []);

  // Handle browser split drag
  useEffect(() => {
    if (!isDraggingBrowserSplit) return;

    let rafId = null;

    const handleMouseMove = (e) => {
      // Throttle with requestAnimationFrame for better performance
      if (rafId !== null) return;

      rafId = requestAnimationFrame(() => {
        rafId = null;

        if (!browserSplitRef.current) return;
        const rect = browserSplitRef.current.getBoundingClientRect();
        let newPosition = ((e.clientX - rect.left) / rect.width) * 100;
        // If terminal is on the left, invert the position calculation
        if (terminalPosition === 'left') {
          newPosition = 100 - newPosition;
        }
        // Allow resize between 10% and 90%
        const clamped = Math.min(Math.max(newPosition, 10), 90);
        setBrowserSplitPosition(clamped);
      });
    };

    const handleMouseUp = () => {
      // Cancel any pending rAF
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setIsDraggingBrowserSplit(false);
      // Save final position to localStorage
      setBrowserSplitPosition(pos => {
        try {
          localStorage.setItem('browser_split_position_v1', String(Math.round(pos)));
        } catch {}
        return pos;
      });
      setPreviewTerminalFitToken(token => token + 1);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      // Cancel pending rAF on cleanup
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingBrowserSplit, terminalPosition]);

  // Nudge xterm fit when browser split changes (xterm doesn't always observe flex-basis changes)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!browserSplitEnabled || isMobile) return;
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      window.dispatchEvent(new Event('resize'));
    });
    return () => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [browserSplitEnabled, browserSplitPosition, terminalPosition, isMobile]);

  // Mobile split view handlers
  const handleToggleMobileSplit = useCallback(() => {
    setMobileSplitEnabled(prev => !prev);
  }, []);

  const handleMobileSplitTouchStart = useCallback((e) => {
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();
    mobileSplitStartY.current = e.touches[0].clientY;
    mobileSplitStartHeight.current = mobileSplitHeight;
    setIsDraggingMobileSplit(true);
  }, [mobileSplitHeight]);

  const handleMobileSplitTouchMove = useCallback((e) => {
    if (!isDraggingMobileSplit) return;
    if (!e.touches || e.touches.length === 0) return;

    e.preventDefault();

    // Capture touch coordinates before rAF (touch events can't be accessed async)
    const touchY = e.touches[0].clientY;

    // Throttle with requestAnimationFrame
    if (mobileSplitRafRef.current !== null) return;

    mobileSplitRafRef.current = requestAnimationFrame(() => {
      mobileSplitRafRef.current = null;

      const deltaY = mobileSplitStartY.current - touchY;
      const newHeight = mobileSplitStartHeight.current + deltaY;

      // Clamp height to 200px min, 70% of viewport max
      const maxHeight = getViewportHeight() * 0.7;
      const clampedHeight = Math.min(Math.max(newHeight, 200), maxHeight);
      setMobileSplitHeight(clampedHeight);
    });
  }, [getViewportHeight, isDraggingMobileSplit]);

  const handleMobileSplitTouchEnd = useCallback(() => {
    if (isDraggingMobileSplit) {
      // Cancel any pending rAF
      if (mobileSplitRafRef.current !== null) {
        cancelAnimationFrame(mobileSplitRafRef.current);
        mobileSplitRafRef.current = null;
      }

      setIsDraggingMobileSplit(false);
    }
  }, [isDraggingMobileSplit]);

  // Add touch event listeners for mobile split drag
  useEffect(() => {
    if (!isDraggingMobileSplit) return;

    document.addEventListener('touchmove', handleMobileSplitTouchMove, { passive: false });
    document.addEventListener('touchend', handleMobileSplitTouchEnd);
    document.addEventListener('touchcancel', handleMobileSplitTouchEnd);

    return () => {
      document.removeEventListener('touchmove', handleMobileSplitTouchMove);
      document.removeEventListener('touchend', handleMobileSplitTouchEnd);
      document.removeEventListener('touchcancel', handleMobileSplitTouchEnd);
    };
  }, [isDraggingMobileSplit, handleMobileSplitTouchMove, handleMobileSplitTouchEnd]);


  // Auto-select terminal session on initial load
  useEffect(() => {
    // Wait for sessions to load
    if (!activeSessions || activeSessions.length === 0) {
      return;
    }

    // Initial selection - runs once when sessions first become available
    if (!hasInitializedRef.current) {
      const targetId = activeSessionId || activeSessions[0]?.id;
      if (targetId) {
        hasInitializedRef.current = true;
        setSelectedTerminalSession(targetId);
      }
      return;
    }

    // If selected session no longer exists, switch to first available
    if (selectedTerminalSession) {
      const sessionExists = activeSessions.some(s => s.id === selectedTerminalSession);
      if (!sessionExists) {
        const targetId = activeSessions[0]?.id;
        if (targetId) {
          setSelectedTerminalSession(targetId);
        }
      }
    }
  }, [activeSessions, selectedTerminalSession]);

  // Keyboard shortcuts (consolidated for both mobile and desktop)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input/textarea (important for mobile)
      const activeElement = document.activeElement;
      if (activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable
      )) {
        return;
      }

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + I: Toggle inspector
      if (isCmdOrCtrl && e.key === 'i') {
        e.preventDefault();
        if (isMobile) {
          setInspectMode(prev => !prev);
        } else {
          handleToggleInspect();
        }
      }

      // Cmd/Ctrl + R: Refresh preview
      if (isCmdOrCtrl && e.key === 'r') {
        e.preventDefault();
        handleRefresh();
      }

      // Cmd/Ctrl + K: Toggle split (mobile split on mobile, terminal split on desktop)
      if (isCmdOrCtrl && e.key === 'k') {
        e.preventDefault();
        if (isMobile) {
          handleToggleMobileSplit();
        } else {
          handleToggleTerminalSplit();
        }
      }

      // Cmd/Ctrl + 1-9: Switch terminal session (desktop only)
      if (!isMobile && isCmdOrCtrl && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        if (activeSessions && activeSessions[index]) {
          setSelectedTerminalSession(activeSessions[index].id);
        }
      }

      // Escape: Close inspector or logs
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isMobile) {
          // Mobile-specific escape handling
          if (inspectMode) {
            setInspectMode(false);
          } else if (showStyleEditor) {
            setShowStyleEditor(false);
          } else if (showLogs) {
            setShowLogs(false);
          }
        } else {
          // Desktop escape handling
          if (selectedElement) {
            setSelectedElement(null);
          } else if (showLogs) {
            setShowLogs(false);
          } else if (showKeyboardHelp) {
            setShowKeyboardHelp(false);
          }
        }
      }

      // ? : Show keyboard help (desktop only)
      if (!isMobile && e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowKeyboardHelp(true);
      }
    };

    // Use document.addEventListener to avoid duplicate listeners
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, inspectMode, selectedElement, showLogs, showStyleEditor, showKeyboardHelp, activeSessions, handleRefresh, handleToggleInspect, handleToggleTerminalSplit, handleToggleMobileSplit]);

  // Auto-expand logs when errors appear
  useEffect(() => {
    if (errorLogs.length > 0 && !showLogs) {
      setShowLogs(true);
    }
  }, [errorLogs.length, showLogs]);

  const mobileViewportHeight = getViewportHeight();

  // Mobile layout
  if (isMobile) {
    return (
      <div className="preview-panel preview-panel-mobile">
        {/* Full-screen iframe */}
        <div
          className="preview-content-mobile"
          style={mobileSplitEnabled && mobileSplitHeight > 0 ? {
            height: `calc(100% - ${Math.min(mobileSplitHeight, mobileViewportHeight * 0.7)}px)`
          } : undefined}
        >
          {!iframeSrc ? (
            <div className="preview-empty">
              {url && (url.includes(':3020') || url.includes('preview-3020')) ? (
                <>
                  <div className="preview-empty-icon">{'\u{1F6AB}'}</div>
                  <h3>Cannot Preview Terminal V4</h3>
                  <p>Terminal V4 (port 3020) cannot be viewed in its own preview panel to prevent infinite recursion.</p>
                  <p style={{ marginTop: '1rem', opacity: 0.7 }}>Please select a different port from the port selector.</p>
                </>
              ) : projectInfo && projectInfo.projectType !== 'unknown' ? (
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

        {/* Mobile terminal overlay (bottom sheet) */}
        {mobileSplitEnabled && activeSessions && activeSessions.length > 0 && (
          <div
            className={`preview-mobile-terminal${isDraggingMobileSplit ? ' dragging' : ''}`}
            style={{ height: `${mobileSplitHeight}px` }}
          >
            {/* Drag handle */}
            <div
              className="preview-mobile-terminal-handle"
              onTouchStart={handleMobileSplitTouchStart}
            >
              <div className="preview-mobile-terminal-handle-bar" />
            </div>

            {/* Session switcher */}
            <div className="preview-mobile-terminal-header">
              {activeSessions.length > 0 ? (
                <div className="preview-mobile-terminal-sessions">
                  {activeSessions.map(session => (
                    <button
                      key={session.id}
                      className={`preview-mobile-session-chip ${selectedTerminalSession === session.id ? 'active' : ''}`}
                      onClick={() => setSelectedTerminalSession(session.id)}
                      type="button"
                    >
                      <span className="session-indicator" />
                      <span className="session-name">
                        {session.title || `Session ${session.id.slice(0, 8)}`}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <span className="preview-mobile-terminal-empty">No terminal sessions</span>
              )}
              <button
                className="preview-mobile-terminal-close"
                onClick={handleRefreshPreviewTerminal}
                type="button"
                aria-label="Reconnect terminal"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1 2.13-9" />
                </svg>
              </button>
              <button
                className="preview-mobile-terminal-close"
                onClick={handleToggleMobileSplit}
                type="button"
                aria-label="Close terminal"
              >
                ×
              </button>
            </div>

            {/* Terminal content */}
            <div className="preview-mobile-terminal-content">
              {selectedTerminalSession ? (
                <TerminalChat
                  key={`${selectedTerminalSession}-${previewTerminalRefreshToken}`}
                  sessionId={selectedTerminalSession}
                  keybarOpen={false}
                  viewportHeight={null}
                  fontSize={fontSize}
                  webglEnabled={webglEnabled}
                  onUrlDetected={onUrlDetected || (() => {})}
                  usesTmux={activeSessions.find(s => s.id === selectedTerminalSession)?.usesTmux}
                  onRegisterImageUpload={() => {}}
                  onRegisterHistoryPanel={() => {}}
                  onRegisterFocusTerminal={() => {}}
                  onActivityChange={() => {}}
                  onConnectionChange={() => {}}
                  onCwdChange={() => {}}
                  onScrollDirection={() => {}}
                />
              ) : (
                <div className="preview-empty">
                  <p>No terminal session selected</p>
                </div>
              )}
            </div>
          </div>
        )}

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
            {activePorts.filter(p => p.listening).length === 0 ? (
              <div className="preview-port-sheet-empty">No active ports found</div>
            ) : (
              <div className="preview-port-sheet-list">
                {activePorts.filter(p => p.listening).map(({ port, process, cwd }) => (
                  <button
                    key={port}
                    type="button"
                    className={`preview-port-sheet-item ${port === previewPort ? 'current' : ''}`}
                    onClick={() => handleSelectPort(port)}
                  >
                    <span className="preview-port-sheet-number">:{port}</span>
                    {(cwd || process) && <span className="preview-port-sheet-process">{cwd || process}</span>}
                    <span className="preview-port-sheet-status">
                      <span className="preview-port-dot listening" title="Listening" />
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
            <button
              type="button"
              className="preview-console-clear"
              onClick={(e) => { e.stopPropagation(); handleClearLogs(); }}
            >
              Clear
            </button>
            <button
              type="button"
              className="preview-console-clear"
              onClick={(e) => { e.stopPropagation(); handleExportLogs(); }}
              disabled={filteredLogs.length === 0}
              title="Export logs"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            {onSendToTerminal && (
              <button
                type="button"
                className="preview-console-clear"
                onClick={(e) => { e.stopPropagation(); handleSendLogsToTerminal(); }}
                disabled={errorLogs.length === 0}
                title="Send errors to terminal"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </button>
            )}
          </div>

          {/* Filter chips and search */}
          {showLogs && (
            <div className="preview-console-filters">
              <div className="preview-console-filter-chips">
                <button
                  className={`preview-filter-chip ${logFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setLogFilter('all')}
                  type="button"
                >
                  All ({logs.length + proxyLogs.length + processLogs.length})
                </button>
                <button
                  className={`preview-filter-chip ${logFilter === 'server' ? 'active' : ''}`}
                  onClick={() => setLogFilter('server')}
                  type="button"
                >
                  Server ({processLogs.length})
                </button>
                <button
                  className={`preview-filter-chip ${logFilter === 'proxy' ? 'active' : ''}`}
                  onClick={() => setLogFilter('proxy')}
                  type="button"
                >
                  Network ({proxyLogs.length})
                </button>
                <button
                  className={`preview-filter-chip ${logFilter === 'client' ? 'active' : ''}`}
                  onClick={() => setLogFilter('client')}
                  type="button"
                >
                  Console ({logs.length})
                </button>
              </div>
              <input
                type="text"
                className="preview-console-search"
                placeholder="Search logs..."
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}

          <div className="preview-console-content" ref={logsContainerRef} onScroll={handleLogsScroll}>
            {filteredLogs.length === 0 ? (
              <div className="preview-logs-empty">No logs yet</div>
            ) : (
              filteredLogs.map((log) => {
                if (log.source === 'client') {
                  // Check if this is an error with detailed info (like Chrome DevTools)
                  const hasErrorDetails = log.type === 'error' && (log.filename || log.stack);
                  return (
                    <div key={`c-${log.id}`} className={`preview-log-entry preview-log-${log.level}${hasErrorDetails ? ' preview-log-detailed' : ''}`}>
                      <span className="preview-log-time">{formatTime(log.timestamp)}</span>
                      <div className="preview-log-content">
                        <span className="preview-log-message">{log.message}</span>
                        {log.filename && (
                          <span className="preview-log-location">
                            {log.filename}{log.lineno ? `:${log.lineno}` : ''}{log.colno ? `:${log.colno}` : ''}
                          </span>
                        )}
                        {log.stack && (
                          <pre className="preview-log-stack">{log.stack}</pre>
                        )}
                      </div>
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

              {/* Breadcrumbs (parent chain) */}
              {selectedElement.parentChain && selectedElement.parentChain.length > 0 && (
                <div className="preview-inspector-section">
                  <div className="preview-inspector-label">Parents</div>
                  <div className="preview-inspector-breadcrumb">
                    {[...selectedElement.parentChain].reverse().map((parent, i) => (
                      <span key={i} className="breadcrumb-item">
                        {i > 0 && <span className="breadcrumb-sep"> › </span>}
                        <span className="breadcrumb-tag">{parent.selector}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Attributes (collapsible) */}
              {selectedElement.attributes && Object.keys(selectedElement.attributes).length > 0 && (
                <details className="preview-inspector-details">
                  <summary className="preview-inspector-summary">
                    Attributes ({Object.keys(selectedElement.attributes).length})
                  </summary>
                  <div className="preview-inspector-details-content">
                    {Object.entries(selectedElement.attributes).map(([name, value]) => (
                      <div key={name} className="preview-inspector-attr">
                        <span className="attr-name">{name}</span>
                        <span className="attr-value">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Computed Styles (collapsible) */}
              {selectedElement.extendedStyles && Object.keys(selectedElement.extendedStyles).length > 0 && (
                <details className="preview-inspector-details">
                  <summary className="preview-inspector-summary">
                    Computed Styles ({Object.keys(selectedElement.extendedStyles).length})
                  </summary>
                  <div className="preview-inspector-details-content">
                    {Object.entries(selectedElement.extendedStyles)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([prop, value]) => (
                        <div key={prop} className="preview-inspector-style">
                          <span className="style-prop">{prop}</span>
                          <span className="style-value">{String(value)}</span>
                        </div>
                      ))}
                  </div>
                </details>
              )}

              {/* React Props (collapsible) */}
              {selectedElement.react?.props && Object.keys(selectedElement.react.props).length > 0 && (
                <details className="preview-inspector-details">
                  <summary className="preview-inspector-summary">
                    React Props ({Object.keys(selectedElement.react.props).length})
                  </summary>
                  <div className="preview-inspector-details-content">
                    {Object.entries(selectedElement.react.props).map(([name, value]) => (
                      <div key={name} className="preview-inspector-prop">
                        <span className="prop-name">{name}</span>
                        <span className="prop-value">{String(value)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
            {/* Actions - Mobile */}
            <div className="preview-inspector-sheet-actions">
              <div className="preview-inspector-btns-mobile">
                <button
                  type="button"
                  className={`preview-inspector-copy-btn-mobile${copyFeedback ? ' copied' : ''}`}
                  onClick={handleCopyElementInfo}
                  title="Copy element info to clipboard"
                >
                  {copyFeedback ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                  )}
                  {copyFeedback ? 'Copied!' : 'Copy'}
                </button>
                {onSendToTerminal && (
                  <button
                    type="button"
                    className="preview-inspector-terminal-btn-mobile"
                    onClick={handleCopyToTerminal}
                    title="Send element info to terminal"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    Send
                  </button>
                )}
              </div>
            </div>
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

        {/* Footer with action buttons */}
        <div className="preview-mobile-footer">
          <button
            type="button"
            className={`preview-footer-btn ${inspectMode ? 'active' : ''}`}
            onClick={handleToggleInspect}
            disabled={!iframeSrc}
            aria-label={inspectMode ? 'Exit inspect mode' : 'Inspect elements'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
              <path d="M13 13l6 6" />
            </svg>
          </button>
          <button
            type="button"
            className={`preview-footer-btn ${mobileSplitEnabled ? 'active' : ''}`}
            onClick={handleToggleMobileSplit}
            disabled={!iframeSrc || !activeSessions || activeSessions.length === 0}
            aria-label={mobileSplitEnabled ? 'Hide terminal' : 'Show terminal'}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
            </svg>
          </button>
          <button
            type="button"
            className="preview-footer-btn"
            onClick={handleOpenExternal}
            disabled={!iframeSrc}
            aria-label="Open in new tab"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          <button
            type="button"
            className={`preview-footer-btn ${showLogs ? 'active' : ''}`}
            onClick={() => setShowLogs(!showLogs)}
            aria-label="Toggle console"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              {activePorts.filter(p => p.listening).length === 0 ? (
                <div className="preview-port-dropdown-empty">No active ports found</div>
              ) : (
                <div className="preview-port-dropdown-list">
                  {activePorts.filter(p => p.listening).map(({ port, process, cwd }) => (
                    <button
                      key={port}
                      type="button"
                      className={`preview-port-item ${port === previewPort ? 'current' : ''}`}
                      onClick={() => handleSelectPort(port)}
                    >
                      <div className="preview-port-info">
                        <div className="preview-port-header">
                          <span className="preview-port-badge">
                            <span className="preview-port-status-dot" />
                            {port}
                          </span>
                          <span className="preview-port-listening-badge">Active</span>
                        </div>
                        {(process || cwd) && (
                          <div className="preview-port-details">
                            {process && (
                              <span className="preview-port-command" title={process}>
                                {process}
                              </span>
                            )}
                            {cwd && (
                              <span className="preview-port-cwd" title={cwd}>
                                {cwd.split('/').slice(-2).join('/')}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
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
          {/* Simple back/forward/reload buttons */}
          <Tooltip text="Go back">
            <button
              type="button"
              className="preview-action-btn"
              onClick={handleBack}
              disabled={historyIndex <= 0}
              aria-label="Go back"
            >
              ←
            </button>
          </Tooltip>
          <Tooltip text="Go forward">
            <button
              type="button"
              className="preview-action-btn"
              onClick={handleForward}
              disabled={historyIndex >= historyStack.length - 1}
              aria-label="Go forward"
            >
              →
            </button>
          </Tooltip>
          <Tooltip text="Reload" shortcut="⌘R">
            <button
              type="button"
              className="preview-action-btn"
              onClick={handleRefresh}
              disabled={!iframeSrc}
              aria-label="Reload preview"
            >
              {isLoading ? '⋯' : '↻'}
            </button>
          </Tooltip>

          <Tooltip text={browserSplitEnabled ? 'Hide Terminal' : 'Show Terminal'} shortcut="⌘K">
            <button
              type="button"
              className={`preview-action-btn with-label ${browserSplitEnabled ? 'active' : ''}`}
              onClick={handleToggleTerminalSplit}
              disabled={!iframeSrc && !useWebContainer}
              aria-label="Toggle terminal split"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="18" rx="1" />
                <rect x="14" y="3" width="7" height="18" rx="1" />
              </svg>
              <span className="preview-action-label">Split</span>
            </button>
          </Tooltip>
          <Tooltip text={showDevTools ? 'Hide DevTools' : 'Show DevTools'} shortcut="⌘⇧D">
            <button
              type="button"
              className={`preview-action-btn with-label ${showDevTools ? 'active' : ''}`}
              onClick={() => {
                setShowDevTools(prev => !prev);
              }}
              disabled={!iframeSrc}
              aria-label="Toggle DevTools"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              <span className="preview-action-label">DevTools</span>
              {(logs.length + proxyLogs.length) > 0 && <span className="preview-log-badge-sm">{logs.length + proxyLogs.length}</span>}
            </button>
          </Tooltip>
          <div className="preview-tools-menu-wrap" ref={toolsMenuRef}>
            <button
              type="button"
              className={`preview-action-btn ${showToolsMenu ? 'active' : ''}`}
              onClick={() => setShowToolsMenu((prev) => !prev)}
              aria-label="More browser tools"
              title="More browser tools"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="6" cy="12" r="1.5" />
                <circle cx="18" cy="12" r="1.5" />
              </svg>
            </button>
            {showToolsMenu && (
              <div className="preview-tools-menu">
                <button
                  type="button"
                  className={`preview-tools-menu-item ${inspectMode ? 'active' : ''}`}
                  onClick={() => {
                    handleToggleInspect();
                    setShowToolsMenu(false);
                  }}
                  disabled={!iframeSrc}
                >
                  {inspectMode ? 'Exit Inspect' : 'Inspect Element'}
                </button>
                <button
                  type="button"
                  className={`preview-tools-menu-item ${useWebContainer ? 'active' : ''}`}
                  onClick={() => {
                    setUseWebContainer(!useWebContainer);
                    setShowToolsMenu(false);
                  }}
                  disabled={!webContainerSupported?.supported && !useWebContainer}
                  title={!webContainerSupported?.supported ? webContainerSupported?.reason : undefined}
                >
                  {useWebContainer ? 'Use Proxy Mode' : 'Use WebContainer'}
                </button>
                <button
                  type="button"
                  className="preview-tools-menu-item"
                  onClick={() => {
                    handleOpenExternal();
                    setShowToolsMenu(false);
                  }}
                  disabled={!iframeSrc}
                >
                  Open in New Tab
                </button>
                {previewPort && (
                  <button
                    type="button"
                    className={`preview-tools-menu-item ${hasCookies ? 'has-cookies' : ''}`}
                    onClick={() => {
                      handleClearCookies();
                      setShowToolsMenu(false);
                    }}
                    disabled={!hasCookies}
                  >
                    {hasCookies ? 'Clear Cookies' : 'No Cookies'}
                  </button>
                )}
                {onToggleMainTerminal && (
                  <button
                    type="button"
                    className={`preview-tools-menu-item ${mainTerminalMinimized ? 'active' : ''}`}
                    onClick={() => {
                      onToggleMainTerminal();
                      setShowToolsMenu(false);
                    }}
                  >
                    {mainTerminalMinimized ? 'Show Main Terminal' : 'Maximize Browser'}
                  </button>
                )}
              </div>
            )}
          </div>
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

      <div
        ref={browserSplitRef}
        className={`preview-content-wrapper${isDraggingBrowserSplit ? ' dragging' : ''}${terminalPosition === 'left' ? ' terminal-left' : ''}`}
      >
        <div
          className="preview-iframe-section"
          style={browserSplitEnabled ? { flex: `0 0 ${browserSplitPosition}%` } : { flex: 1 }}
        >
          <div className="preview-content">
            {!iframeSrc ? (
              <div className="preview-empty">
                {url && (url.includes(':3020') || url.includes('preview-3020')) ? (
                  <>
                    <div className="preview-empty-icon">{'\u{1F6AB}'}</div>
                    <h3>Cannot Preview Terminal V4</h3>
                    <p>Terminal V4 (port 3020) cannot be viewed in its own preview panel to prevent infinite recursion.</p>
                    <p style={{ marginTop: '1rem', opacity: 0.7 }}>Please select a different port from the port selector above.</p>
                  </>
                ) : projectInfo && projectInfo.projectType !== 'unknown' ? (
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
                    {activePorts.some((p) => p.listening) && (
                      <div className="preview-empty-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => {
                            const firstPort = activePorts.find((p) => p.listening)?.port;
                            if (!firstPort) return;
                            const detectedUrl = `http://localhost:${firstPort}`;
                            setInputUrl(detectedUrl);
                            onUrlChange?.(detectedUrl);
                          }}
                        >
                          Open Active Port
                        </button>
                      </div>
                    )}
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
            ) : useWebContainer ? (
              <WebContainerPreview
                projectPath={projectInfo?.cwd}
                startCommand={projectInfo?.startCommand || 'npm run dev'}
                onStatusChange={(status, message) => setWebContainerStatus({ status, message })}
                onServerReady={(url, port) => {
                  console.log('[WebContainer] Server ready:', url, port);
                }}
                onError={(error, phase) => {
                  console.error('[WebContainer] Error:', phase, error);
                }}
                onFallbackToProxy={() => setUseWebContainer(false)}
              />
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
        </div>

        {browserSplitEnabled && (
          <>
            <div
              className="split-handle"
              onMouseDown={handleBrowserSplitMouseDown}
            />
            <div className="preview-terminal-section">
              <div className="preview-terminal-header">
                {activeSessions && activeSessions.length > 0 ? (
                  <div className="preview-session-switcher">
                    {activeSessions.map(session => (
                      <button
                        key={session.id}
                        className={`preview-session-btn ${selectedTerminalSession === session.id ? 'active' : ''}`}
                        onClick={() => setSelectedTerminalSession(session.id)}
                        title={session.title || `Session ${session.id.slice(0, 8)}`}
                      >
                        <span className="session-indicator" />
                        <span className="session-name">
                          {session.title || `Session ${session.id.slice(0, 8)}`}
                        </span>
                        {session.hasUnread && <span className="session-unread-dot" />}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="preview-terminal-no-sessions">No terminal sessions</span>
                )}
                <button
                  className="preview-terminal-toggle"
                  onClick={handleToggleTerminalPosition}
                  title={`Move terminal to ${terminalPosition === 'right' ? 'left' : 'right'}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {terminalPosition === 'right' ? (
                      <path d="M11 19l-7-7 7-7M18 19V5" />
                    ) : (
                      <path d="M13 5l7 7-7 7M6 5v14" />
                    )}
                  </svg>
                </button>
                <button
                  className="preview-terminal-toggle"
                  onClick={handleRefreshPreviewTerminal}
                  title="Reconnect terminal"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1 2.13-9" />
                  </svg>
                </button>
                <button
                  className="preview-terminal-toggle"
                  onClick={handleToggleTerminalSplit}
                  title="Close terminal"
                >
                  ×
                </button>
              </div>
              <div className="preview-terminal-content">
                {selectedTerminalSession ? (
                  <TerminalChat
                    key={`${selectedTerminalSession}-${previewTerminalRefreshToken}`}
                    sessionId={selectedTerminalSession}
                    keybarOpen={false}
                    viewportHeight={null}
                    fontSize={fontSize}
                    webglEnabled={webglEnabled}
                    fitSignal={previewTerminalFitToken}
                    onUrlDetected={onUrlDetected || (() => {})}
                    usesTmux={activeSessions.find(s => s.id === selectedTerminalSession)?.usesTmux}
                    onRegisterImageUpload={() => {}}
                    onRegisterFocusTerminal={() => {}}
                    onActivityChange={() => {}}
                    onConnectionChange={() => {}}
                    onCwdChange={() => {}}
                    onScrollDirection={() => {}}
                  />
                ) : (
                  <div className="preview-empty">
                    <p>No terminal session selected</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Desktop DevTools Panel */}
      {showDevTools && (
        <div className={`preview-logs ${showDevTools ? 'expanded' : 'collapsed'}`}>
          <DevToolsPanel
            networkRequests={proxyLogs}
            consoleLogs={logs}
            storage={storageData}
            previewPort={previewPort}
            onClearNetwork={handleClearProxyLogs}
            onClearConsole={handleClearLogs}
            onUpdateStorage={handleUpdateStorage}
            onEvaluate={handleEvaluate}
          />
        </div>
      )}

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

          {/* Breadcrumb Path */}
          {elementPath.length > 0 && (
            <div className="inspector-breadcrumb">
              {elementPath.map((item, index) => (
                <span key={index} className="breadcrumb-item">
                  {index > 0 && <span className="breadcrumb-separator">›</span>}
                  <button
                    className="breadcrumb-btn"
                    onClick={() => {
                      const newEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
                      item.element.dispatchEvent(newEvent);
                    }}
                    title={item.selector}
                  >
                    {item.tag}
                  </button>
                </span>
              ))}
            </div>
          )}

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
          {/* Actions: Copy and Send to Terminal */}
          <div className="preview-inspector-actions">
            <div className="preview-inspector-btns">
              <button
                type="button"
                className={`preview-inspector-copy-btn${copyFeedback ? ' copied' : ''}`}
                onClick={handleCopyElementInfo}
                title="Copy element info to clipboard"
              >
                {copyFeedback ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                )}
                {copyFeedback ? 'Copied!' : 'Copy'}
              </button>
              {onSendToTerminal && (
                <button
                  type="button"
                  className="preview-inspector-terminal-btn"
                  onClick={handleCopyToTerminal}
                  title="Send element info to terminal"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                  Send to Terminal
                </button>
              )}
            </div>
          </div>
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

      {/* Keyboard Help Modal */}
      {showKeyboardHelp && (
        <div className="keyboard-help-modal" onClick={() => setShowKeyboardHelp(false)}>
          <div className="keyboard-help-content" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard Shortcuts</h3>
            <div className="keyboard-shortcuts">
              <div className="shortcut-group">
                <h4>Navigation</h4>
                <div className="shortcut"><kbd>⌘/Ctrl</kbd> + <kbd>I</kbd> <span>Toggle Inspector</span></div>
                <div className="shortcut"><kbd>⌘/Ctrl</kbd> + <kbd>K</kbd> <span>Toggle Terminal</span></div>
                <div className="shortcut"><kbd>⌘/Ctrl</kbd> + <kbd>R</kbd> <span>Refresh Preview</span></div>
                <div className="shortcut"><kbd>Esc</kbd> <span>Close Inspector/Logs</span></div>
              </div>
              <div className="shortcut-group">
                <h4>Sessions</h4>
                <div className="shortcut"><kbd>⌘/Ctrl</kbd> + <kbd>1-9</kbd> <span>Switch Terminal Session</span></div>
              </div>
              <div className="shortcut-group">
                <h4>Help</h4>
                <div className="shortcut"><kbd>?</kbd> <span>Show This Help</span></div>
              </div>
            </div>
            <button className="btn-primary" onClick={() => setShowKeyboardHelp(false)}>Close</button>
          </div>
        </div>
      )}

    </div>
  );
}
