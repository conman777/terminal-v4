import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { toPreviewUrl, toPathPreviewFallbackUrl, withAuthToken, extractPortFromUrl } from '../utils/previewUrl';
import { getAccessToken } from '../utils/auth';
import { apiFetch } from '../utils/api';
import { isWebContainerSupported } from '../utils/webcontainer';
import { TerminalChat } from './TerminalChat';
import { StyleEditor } from './StyleEditor';
import { DevToolsPanel } from './devtools/DevToolsPanel';
import { WebContainerPreview } from './WebContainerPreview';
import { PreviewUrlBar } from './preview/PreviewUrlBar';
import { PreviewInspector } from './preview/PreviewInspector';

// Format timestamp for log display
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

const PREVIEW_STORAGE_KEY = 'terminal_preview_storage_v1';
const PREVIEW_STORAGE_MAX_BYTES = 200 * 1024;
const MOBILE_SPLIT_ENABLED_KEY = 'preview_mobile_split_enabled_v1';
const MOBILE_VIEW_MODE_KEY = 'preview_mobile_view_mode_v1';
const MOBILE_SPLIT_HEIGHT_KEY = 'preview_mobile_split_height_v1';
const MOBILE_SPLIT_SESSION_KEY = 'preview_mobile_split_session_v1';
const DEVTOOLS_HEIGHT_KEY = 'preview_devtools_height_v1';
const DEVTOOLS_VISIBLE_KEY = 'preview_devtools_visible_v1';
const PREVIEW_CHROME_COMPACT_KEY = 'preview_compact_chrome_v1';
const PREVIEW_DESKTOP_MOBILE_VIEW_KEY = 'preview_desktop_mobile_view_v1';
const DESKTOP_BROWSER_SPLIT_DEFAULT = 68;
const GENERIC_RUNTIME_PROCESSES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'deno']);

function isFrontendCandidatePort(portInfo, previewPort) {
  if (!portInfo?.listening) return false;
  if (portInfo.port === previewPort) return true;
  // Ignore common system service ports unless explicitly selected.
  if (portInfo.port < 1024) return false;
  // Exclude system services identified by the probe (postgres, redis, chrome, etc).
  if (portInfo.probeStatus === 'excluded-process') return false;
  if (portInfo.frontendLikely === true || portInfo.previewable === true) return true;
  if (portInfo.reachable === true && portInfo.common) return true;
  // If we have no process/cwd metadata, this is usually noisy/system traffic.
  if (!portInfo.process && !portInfo.cwd) return false;
  return true;
}

function getPortAppKey(portInfo) {
  if (portInfo?.cwd && typeof portInfo.cwd === 'string') {
    return `cwd:${portInfo.cwd.toLowerCase()}`;
  }
  if (portInfo?.process && typeof portInfo.process === 'string') {
    const normalizedProcess = portInfo.process.trim().toLowerCase();
    if (!GENERIC_RUNTIME_PROCESSES.has(normalizedProcess)) {
      return `proc:${normalizedProcess}`;
    }
  }
  return `port:${portInfo?.port}`;
}

function normalizePreviewUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value.trim();
  }
}

function formatElementForTerminal(element) {
  if (!element || typeof element !== 'object') return '';
  const selector = element.fullSelector || element.selector || '';
  const parts = [];
  if (selector) parts.push(`Element: ${selector}`);
  if (element.rect) {
    parts.push(`Size: ${element.rect.width}x${element.rect.height}px`);
  }
  if (element.className) {
    parts.push(`Classes: ${element.className}`);
  }

  let openingTag = '';
  if (typeof element.outerHTML === 'string' && element.outerHTML.length > 0) {
    const match = element.outerHTML.match(/^<[^>]+>/);
    openingTag = match ? match[0] : '';
  }
  if (!openingTag && element.tagName) {
    openingTag = `<${element.tagName}`;
    if (element.id) openingTag += ` id="${element.id}"`;
    if (element.className) openingTag += ` class="${element.className}"`;
    openingTag += '>';
  }
  if (openingTag) {
    parts.push(`HTML: ${openingTag}`);
  }

  return parts.join(' | ');
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

function classifyPreviewMode(iframeSrc, useWebContainer) {
  if (useWebContainer) {
    return {
      id: 'webcontainer',
      label: 'WebContainer',
      limited: false,
      title: 'WebContainer preview',
      description: 'Runs in browser WebContainer mode instead of proxy mode.'
    };
  }
  if (!iframeSrc) {
    return {
      id: 'none',
      label: 'No Preview',
      limited: false,
      title: 'No preview loaded',
      description: null
    };
  }
  try {
    const parsed = new URL(iframeSrc, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    const host = (parsed.hostname || '').toLowerCase();
    if (/^preview-\d+\./i.test(host)) {
      return {
        id: 'subdomain',
        label: 'Interactive',
        limited: false,
        title: 'Interactive preview (subdomain)',
        description: 'Full preview mode via subdomain proxy.'
      };
    }
    if (/^\/preview\/\d+(\/|$)/.test(parsed.pathname || '')) {
      return {
        id: 'path-compat',
        label: 'Compatibility',
        limited: true,
        title: 'Compatibility preview (path-based)',
        description: 'Limited compatibility mode for simple pages.'
      };
    }
    if ((parsed.pathname || '').startsWith('/api/proxy-external')) {
      return {
        id: 'external-proxy',
        label: 'External',
        limited: true,
        title: 'External proxy preview',
        description: 'External URL routed through V4 proxy.'
      };
    }
    return {
      id: 'direct',
      label: 'Direct',
      limited: true,
      title: 'Direct iframe URL',
      description: 'Preview is using a direct iframe URL.'
    };
  } catch {
    return {
      id: 'unknown',
      label: 'Unknown',
      limited: true,
      title: 'Unknown preview mode',
      description: null
    };
  }
}

export function PreviewPanel({ url, onClose, onUrlChange, projectInfo, onStartProject, onSendToTerminal, onSendToClaudeCode, activeSessions = [], activeSessionId, sessionActivity = {}, onSessionBusyChange, fontSize = 14, webglEnabled, onUrlDetected, mainTerminalMinimized = false, onToggleMainTerminal, showStatusLabels = false }) {
  const isMobile = useMobileDetect();
  const uiPort = useMemo(() => {
    if (typeof window === 'undefined') return 3020;
    const parsed = Number.parseInt(window.location.port || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3020;
  }, []);
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
  const [showDevTools, setShowDevTools] = useState(() => {
    if (isMobile) return false;
    try {
      const stored = localStorage.getItem(DEVTOOLS_VISIBLE_KEY);
      if (stored === null) return false;
      return stored === 'true';
    } catch {
      return false;
    }
  });
  const [compactChrome, setCompactChrome] = useState(() => {
    if (isMobile) return false;
    try {
      const stored = localStorage.getItem(PREVIEW_CHROME_COMPACT_KEY);
      if (stored === null) return true;
      return stored === 'true';
    } catch {
      return true;
    }
  });
  const [desktopMobileView, setDesktopMobileView] = useState(() => {
    if (isMobile) return false;
    try {
      const stored = localStorage.getItem(PREVIEW_DESKTOP_MOBILE_VIEW_KEY);
      if (stored === null) return false;
      return stored === 'true';
    } catch {
      return false;
    }
  });
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showMobileToolsMenu, setShowMobileToolsMenu] = useState(false);
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
  const [mobilePortSearch, setMobilePortSearch] = useState('');
  const [previewTerminalFitToken, setPreviewTerminalFitToken] = useState(0);
  // WebContainer mode state
  const [useWebContainer, setUseWebContainer] = useState(false);
  const [webContainerSupported, setWebContainerSupported] = useState(null);
  const [webContainerStatus, setWebContainerStatus] = useState(null);
  const [compatibilityFallbackPrompt, setCompatibilityFallbackPrompt] = useState(null);
  const [compatibilityModeReason, setCompatibilityModeReason] = useState(null);
  const iframeRef = useRef(null);
  const subdomainFallbackAttemptedRef = useRef(new Set());
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
      if (!stored) return DESKTOP_BROWSER_SPLIT_DEFAULT;
      const parsed = parseInt(stored, 10);
      // Validate range (10-90%)
      if (isNaN(parsed) || parsed < 10 || parsed > 90) return DESKTOP_BROWSER_SPLIT_DEFAULT;
      return parsed;
    } catch {
      return DESKTOP_BROWSER_SPLIT_DEFAULT;
    }
  });
  const [devToolsHeight, setDevToolsHeight] = useState(() => {
    try {
      const stored = Number.parseInt(localStorage.getItem(DEVTOOLS_HEIGHT_KEY) || '', 10);
      if (!Number.isFinite(stored)) return 220;
      if (stored < 140 || stored > 900) return 220;
      return stored;
    } catch {
      return 220;
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
  const [selectedTerminalSession, setSelectedTerminalSession] = useState(() => {
    try {
      return localStorage.getItem(MOBILE_SPLIT_SESSION_KEY);
    } catch {
      return null;
    }
  });
  const hasInitializedRef = useRef(false);
  const [previewTerminalRefreshToken, setPreviewTerminalRefreshToken] = useState(0);
  const handleRefreshPreviewTerminal = useCallback(() => {
    setPreviewTerminalRefreshToken(v => v + 1);
  }, []);
  const [isDraggingBrowserSplit, setIsDraggingBrowserSplit] = useState(false);
  const [isDraggingDevTools, setIsDraggingDevTools] = useState(false);
  const previewPanelRef = useRef(null);
  const browserSplitRef = useRef(null);
  const previewTerminalSectionRef = useRef(null);
  const devToolsDragStartYRef = useRef(0);
  const devToolsDragStartHeightRef = useRef(0);
  const resizeRafRef = useRef(null);
  const focusPreviewTerminalRef = useRef(null);
  const mobileChromeTimerRef = useRef(null);
  const mobileSplitModeRef = useRef(null);
  const mobileToolsMenuRef = useRef(null);
  const mobileFooterRef = useRef(null);
  const [terminalControlSize, setTerminalControlSize] = useState(() => {
    const base = Number.isFinite(fontSize) ? fontSize : 14;
    return Math.max(28, Math.min(42, Math.round(base * 2.2)));
  });
  const [terminalAlignedWidth, setTerminalAlignedWidth] = useState(null);

  // Mobile view mode state ('preview' | 'split' | 'terminal')
  const [mobileViewMode, setMobileViewMode] = useState(() => {
    try {
      const stored = localStorage.getItem(MOBILE_VIEW_MODE_KEY);
      if (stored === 'preview' || stored === 'split' || stored === 'terminal') return stored;
      // Migration from old boolean key
      if (localStorage.getItem(MOBILE_SPLIT_ENABLED_KEY) === 'true') return 'split';
      return 'preview';
    } catch { return 'preview'; }
  });
  const mobileSplitEnabled = mobileViewMode === 'split';
  const [mobileSplitHeight, setMobileSplitHeight] = useState(() => {
    try {
      const stored = Number.parseFloat(localStorage.getItem(MOBILE_SPLIT_HEIGHT_KEY) || '');
      return Number.isFinite(stored) ? stored : 320;
    } catch {
      return 320;
    }
  });
  const mobileModeInitializedRef = useRef(false);
  const [isDraggingMobileSplit, setIsDraggingMobileSplit] = useState(false);
  const mobileSplitStartY = useRef(0);
  const mobileSplitStartHeight = useRef(0);
  const mobileSplitRafRef = useRef(null);
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState(0);
  const [mobileFooterHeight, setMobileFooterHeight] = useState(68);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);

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
    // Prevent viewing V4 in its own preview panel.
    if (cleanUrl) {
      try {
        const parsed = new URL(cleanUrl, window.location.origin);
        const hostMatch = parsed.hostname.match(/preview-(\d+)\./);
        const pathMatch = parsed.pathname.match(/^\/preview\/(\d+)(\/|$)/);
        const hostPort = parsed.port ? parseInt(parsed.port, 10) : null;
        const previewPort = hostMatch ? parseInt(hostMatch[1], 10) : (pathMatch ? parseInt(pathMatch[1], 10) : null);
        const isLocalUiHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname);
        if (previewPort === uiPort || (isLocalUiHost && hostPort === uiPort && !pathMatch && !hostMatch)) {
          if (import.meta.env.DEV) {
            console.warn(`[Preview] Cannot view V4 (port ${uiPort}) in its own preview panel`);
          }
          return null;
        }
      } catch {
        // Ignore parse failures, let toPreviewUrl handle
      }
    }
    const result = toPreviewUrl(cleanUrl);
    if (import.meta.env.DEV) {
      console.log('[Preview] URL conversion:', url, '->', result);
    }
    return result;
  }, [uiPort, url]);
  const [iframeSrc, setIframeSrc] = useState(baseIframeSrc);
  const baseIframeSrcRef = useRef(baseIframeSrc);
  const iframeSrcRef = useRef(iframeSrc);
  useEffect(() => { baseIframeSrcRef.current = baseIframeSrc; }, [baseIframeSrc]);
  useEffect(() => { iframeSrcRef.current = iframeSrc; }, [iframeSrc]);
  useEffect(() => {
    subdomainFallbackAttemptedRef.current.clear();
    setCompatibilityFallbackPrompt(null);
    setCompatibilityModeReason(null);
  }, [baseIframeSrc]);

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

  const previewModeInfo = useMemo(() => classifyPreviewMode(iframeSrc, useWebContainer), [iframeSrc, useWebContainer]);
  const compatibilityModeNotice = useMemo(() => {
    if (previewModeInfo.id !== 'path-compat') return null;
    if (compatibilityModeReason === 'fallback-error') {
      return 'Compatibility mode is active because interactive preview failed. Links, auth, and HMR may still break for some apps.';
    }
    return 'Compatibility mode (path-based preview) is best-effort. Use Interactive mode or Open in New Tab for auth and complex SPA flows.';
  }, [previewModeInfo.id, compatibilityModeReason]);

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
      const currentIframeSrc = iframeSrcRef.current || baseIframeSrc;
      const token = getAccessToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      await fetch(`/api/preview/${previewPort}/cookies`, { method: 'DELETE', headers });

      // Only update state if iframe src hasn't changed during the async operation
      if (currentIframeSrc === (iframeSrcRef.current || baseIframeSrcRef.current)) {
        setHasCookies(false);
        // Refresh the preview to apply cleared cookies
        if (currentIframeSrc) {
          setIsLoading(true);
          setError(null);
          setLogs([]);
          setProxyLogs([]);
          const cacheBuster = `_cb=${Date.now()}`;
          const separator = currentIframeSrc.includes('?') ? '&' : '?';
          setIframeSrc(`${currentIframeSrc}${separator}${cacheBuster}`);
        }
      }
    } catch (err) {
      console.error('Failed to clear cookies:', err);
    }
  }, [previewPort, baseIframeSrc]);

  const handleClearCache = useCallback(async () => {
    try {
      const token = getAccessToken();
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      // Clear server-side cookies and proxy logs in parallel
      const clearPromises = [];
      if (previewPort) {
        clearPromises.push(
          fetch(`/api/preview/${previewPort}/cookies`, { method: 'DELETE', headers }).catch(() => {}),
          fetch(`/api/preview/${previewPort}/proxy-logs`, { method: 'DELETE', headers }).catch(() => {})
        );
      }
      await Promise.all(clearPromises);

      // Tell the iframe to clear its localStorage and sessionStorage
      if (iframeRef.current?.contentWindow) {
        try {
          iframeRef.current.contentWindow.postMessage({ type: 'preview-clear-storage' }, '*');
        } catch {
          // Cross-origin - can't access iframe storage directly
        }
      }

      setHasCookies(false);

      // Force hard reload with cache buster
      const refreshTarget = iframeSrcRef.current || baseIframeSrc;
      if (refreshTarget) {
        setIsLoading(true);
        setError(null);
        setLogs([]);
        setProxyLogs([]);
        const cacheBuster = `_cb=${Date.now()}`;
        const separator = refreshTarget.includes('?') ? '&' : '?';
        setIframeSrc(`${refreshTarget}${separator}${cacheBuster}`);
      }
    } catch (err) {
      console.error('Failed to clear cache:', err);
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

  useEffect(() => {
    if (!showPortDropdown || !isDocumentVisible) return;
    let disposed = false;
    const refreshActivePorts = async () => {
      try {
        const token = getAccessToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/preview/active-ports', { headers });
        if (!res.ok || disposed) return;
        const data = await res.json();
        if (disposed) return;
        setActivePorts(data.ports || []);
      } catch {
        // Ignore fetch errors while opening dropdown.
      }
    };
    void refreshActivePorts();
    return () => {
      disposed = true;
    };
  }, [isDocumentVisible, showPortDropdown]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showPortDropdown) return;
    const handleClickOutside = (e) => {
      if (portDropdownRef.current && !portDropdownRef.current.contains(e.target)) {
        setShowPortDropdown(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [showPortDropdown]);

  useEffect(() => {
    if (!showToolsMenu) return;
    const handleClickOutside = (e) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(e.target)) {
        setShowToolsMenu(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [showToolsMenu]);

  const handleSelectPort = useCallback((port) => {
    const newUrl = `http://localhost:${port}`;
    setInputUrl(newUrl);
    setShowPortDropdown(false);
    setMobilePortSearch('');
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

  const sendElementToActiveTerminal = useCallback(async (element) => {
    const text = formatElementForTerminal(element);
    if (!text) return;

    const hasPreviewTerminal = browserSplitEnabled || mobileSplitEnabled;
    const targetSessionId = hasPreviewTerminal
      ? (selectedTerminalSession || activeSessions?.[0]?.id || null)
      : null;

    if (targetSessionId) {
      try {
        await apiFetch(`/api/terminal/${targetSessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: text })
        });
        return;
      } catch (error) {
        console.error('Failed to send to terminal', error);
      }
    }

    if (onSendToTerminal) {
      onSendToTerminal(text);
    }
  }, [activeSessions, browserSplitEnabled, mobileSplitEnabled, onSendToTerminal, selectedTerminalSession]);

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
        const element = event.data.element;
        setSelectedElement(element || null);
        setShowEditInput(false);
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
        if (event.data.element) {
          void sendElementToActiveTerminal(event.data.element);
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [inspectMode, onUrlChange, previewPort, sendElementToActiveTerminal, url]);

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
          fetch(`/api/preview/${previewPort}/logs`, { method: 'DELETE', headers }),
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

    // Toggle inspector at runtime without reloading the preview app.
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-inspect-mode', enabled: newMode }, '*');
    }
  }, [inspectMode]);

  const handleClearSelection = useCallback(() => {
    setSelectedElement(null);
    setShowEditInput(false);
    setShowStyleEditor(false);
    setEditDescription('');
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage({ type: 'preview-clear-selection' }, '*');
    }
  }, []);

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
    await sendElementToActiveTerminal(selectedElement);
  }, [selectedElement, sendElementToActiveTerminal]);

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
    if (!selectedElement) return;
    const dispatch = onSendToClaudeCode || onSendToTerminal;
    if (!dispatch) return;

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
    dispatch(context);
  }, [selectedElement, onSendToClaudeCode, onSendToTerminal, handleStyleRevert]);

  useEffect(() => {
    setInputUrl(url || '');
    lastSyncedUrlRef.current = normalizePreviewUrl(url || '');
  }, [url]);

  const handleLoad = useCallback(() => {
    // Escape guard: if a local preview navigates to a same-origin path outside
    // /preview/:port (e.g. "/signup"), the iframe will render Terminal V4's SPA
    // instead of the target app. Detect and re-wrap the path back into preview.
    if (previewPort && iframeRef.current?.contentWindow && typeof window !== 'undefined') {
      try {
        const frameLocation = iframeRef.current.contentWindow.location;
        if (frameLocation.origin === window.location.origin) {
          const expectedPrefix = `/preview/${previewPort}`;
          const pathname = frameLocation.pathname || '/';
          const inPreviewPath = (
            pathname === expectedPrefix
            || pathname.startsWith(`${expectedPrefix}/`)
          );
          if (!inPreviewPath) {
            const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
            const escapedUrl = `${expectedPrefix}${normalizedPath}${frameLocation.search || ''}${frameLocation.hash || ''}`;
            console.warn('[Preview] Path preview escaped into Terminal V4 route, re-wrapping:', pathname);
            setIsLoading(true);
            setError(null);
            setIframeSrc(escapedUrl);
            return;
          }
        }
      } catch {
        // Cross-origin iframe (subdomain preview) or transient navigation — ignore.
      }
    }
    setCompatibilityFallbackPrompt(null);
    setIsLoading(false);
    setError(null);
  }, [previewPort]);

  // Fallback: if iframe doesn't fire onLoad within 5s, show it anyway
  // (some apps like Next.js dev mode may delay the load event)
  useEffect(() => {
    if (!isLoading || !iframeSrc) return;
    const timeout = setTimeout(() => {
      if (isLoading) {
        if (import.meta.env.DEV) {
          console.log('[Preview] Load timeout - showing iframe anyway');
        }
        setIsLoading(false);
      }
    }, 5000);
    return () => clearTimeout(timeout);
  }, [isLoading, iframeSrc]);

  const handleUseCompatibilityMode = useCallback(() => {
    if (!compatibilityFallbackPrompt) return;
    subdomainFallbackAttemptedRef.current.add(compatibilityFallbackPrompt.sourceUrl);
    setCompatibilityModeReason('fallback-error');
    setCompatibilityFallbackPrompt(null);
    setIsLoading(true);
    setError(null);
    setIframeSrc(compatibilityFallbackPrompt.fallbackUrl);
  }, [compatibilityFallbackPrompt]);

  const handleError = useCallback(() => {
    const sourceUrl = baseIframeSrcRef.current || iframeSrc;
    const fallbackUrl = toPathPreviewFallbackUrl(sourceUrl);
    if (fallbackUrl && fallbackUrl !== iframeSrc) {
      const attempted = subdomainFallbackAttemptedRef.current;
      if (!attempted.has(sourceUrl)) {
        setCompatibilityFallbackPrompt({ sourceUrl, fallbackUrl });
        setIsLoading(false);
        setError('Interactive preview failed to load. You can retry, use Compatibility mode (limited), or open in a new tab.');
        return;
      }
    }
    setCompatibilityFallbackPrompt(null);
    setIsLoading(false);
    setError('Failed to load page. The server may not be running or CORS may be blocking the request.');
  }, [iframeSrc]);

  const handleRefresh = useCallback(() => {
    const refreshTarget = iframeSrc || baseIframeSrc;
    if (refreshTarget) {
      setIsLoading(true);
      setError(null);
      setCompatibilityFallbackPrompt(null);
      setLogs([]);
      try {
        const parsed = new URL(refreshTarget, window.location.origin);
        if (inspectMode) parsed.searchParams.set('__inspect', '1');
        parsed.searchParams.set('_cb', Date.now().toString());
        setIframeSrc(parsed.toString());
      } catch {
        const cacheBuster = `_cb=${Date.now()}`;
        const separator = refreshTarget.includes('?') ? '&' : '?';
        const inspectParam = inspectMode ? '__inspect=1&' : '';
        setIframeSrc(`${refreshTarget}${separator}${inspectParam}${cacheBuster}`);
      }
    }
  }, [baseIframeSrc, iframeSrc, inspectMode]);

  const handleUrlSubmit = useCallback((e) => {
    e.preventDefault();
    if (inputUrl && onUrlChange) {
      onUrlChange(inputUrl);
    }
    setShowUrlInput(false);
  }, [inputUrl, onUrlChange]);

  const handleOpenExternal = useCallback(() => {
    let targetUrl = (typeof url === 'string' && url.trim()) ? url.trim() : (baseIframeSrc || iframeSrc);
    if (!targetUrl) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(targetUrl) && /^[^/\s]+:\d+(?:\/|\?|#|$)/.test(targetUrl)) {
      targetUrl = `http://${targetUrl}`;
    }
    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }, [baseIframeSrc, iframeSrc, url]);

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
    // setHistoryStack is outer to access stack length, setHistoryIndex is inner to return new index
    setHistoryStack(currentStack => {
      setHistoryIndex(currentIndex => {
        if (currentIndex < currentStack.length - 1) {
          const nextIndex = currentIndex + 1;
          const nextUrl = currentStack[nextIndex];
          if (onUrlChange && nextUrl) {
            requestAnimationFrame(() => {
              onUrlChange(nextUrl);
            });
          }
          return nextIndex;
        }
        return currentIndex;
      });
      return currentStack;
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

  const handleCopyPreviewDebugInfo = useCallback(() => {
    const isMobileViewport = typeof window !== 'undefined' ? window.innerWidth <= 768 : null;
    const payload = {
      timestamp: new Date().toISOString(),
      view: {
        isMobile,
        isMobileViewport,
        window: typeof window !== 'undefined' ? {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio
        } : null,
        visualViewport: typeof window !== 'undefined' && window.visualViewport ? {
          width: window.visualViewport.width,
          height: window.visualViewport.height,
          offsetTop: window.visualViewport.offsetTop,
          offsetLeft: window.visualViewport.offsetLeft
        } : null
      },
      preview: {
        url,
        inputUrl,
        iframeSrc,
        displayUrl,
        previewPort,
        isLoading,
        error,
        showUrlInput,
        showPortDropdown,
        showLogs,
        inspectMode,
        selectedElement: selectedElement?.selector || null
      },
      mobile: {
        mobileChromeHidden,
        mobileKeyboardInset,
        mobileSplitEnabled,
        mobileSplitHeight: Math.round(mobileSplitHeight),
        mobileOverlayHeight: Math.round(mobileOverlayHeight),
        mobileTerminalVisible
      },
      desktop: {
        browserSplitEnabled,
        browserSplitPosition,
        terminalPosition,
        showDevTools,
        devToolsHeight,
        compactChrome
      },
      logs: {
        client: logs.length,
        proxy: proxyLogs.length,
        server: processLogs.length,
        filtered: filteredLogs.length,
        errors: errorLogs.length,
        filter: logFilter,
        search: logSearch
      },
      ports: {
        total: activePorts.length,
        listening: activePorts.filter((port) => port.listening).length,
        current: previewPort,
        sample: activePorts
          .filter((port) => port.listening)
          .slice(0, 20)
          .map(({ port, process, cwd }) => ({ port, process: process || null, cwd: cwd || null }))
      },
      sessions: {
        total: activeSessions.length,
        selectedTerminalSession,
        sessions: activeSessions.slice(0, 10).map(({ id, title, usesTmux: tmux }) => ({
          id,
          title: title || null,
          usesTmux: Boolean(tmux)
        }))
      }
    };

    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.error('Failed to copy preview debug info:', err);
      });
      return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Failed to copy preview debug info:', err);
    } finally {
      document.body.removeChild(textArea);
    }
  }, [
    activePorts,
    activeSessions,
    browserSplitEnabled,
    browserSplitPosition,
    compactChrome,
    devToolsHeight,
    displayUrl,
    error,
    errorLogs.length,
    filteredLogs.length,
    iframeSrc,
    inputUrl,
    inspectMode,
    isLoading,
    isMobile,
    logFilter,
    logSearch,
    logs.length,
    mobileChromeHidden,
    mobileKeyboardInset,
    mobileSplitEnabled,
    mobileSplitHeight,
    previewPort,
    processLogs.length,
    proxyLogs.length,
    selectedElement?.selector,
    selectedTerminalSession,
    showDevTools,
    showLogs,
    showPortDropdown,
    showUrlInput,
    terminalPosition,
    url
  ]);

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

  const handleSetDesktopLayout = useCallback((mode) => {
    if (mode === 'preview') {
      setBrowserSplitEnabled(false);
      setShowDevTools(false);
      return;
    }
    if (mode === 'split') {
      setBrowserSplitEnabled(true);
      setShowDevTools(false);
      setBrowserSplitPosition((position) => {
        const next = Math.max(position, DESKTOP_BROWSER_SPLIT_DEFAULT);
        try {
          localStorage.setItem('browser_split_position_v1', String(Math.round(next)));
        } catch {
          // Ignore localStorage persistence failures
        }
        return next;
      });
      return;
    }
    if (mode === 'debug') {
      setBrowserSplitEnabled(true);
      setShowDevTools(true);
      setBrowserSplitPosition((position) => {
        // Keep terminal wide enough in debug mode so wrapped logs/prompts stay readable.
        const next = Math.min(Math.max(position, 52), 60);
        try {
          localStorage.setItem('browser_split_position_v1', String(Math.round(next)));
        } catch {
          // Ignore localStorage persistence failures
        }
        return next;
      });
      setDevToolsHeight((height) => Math.max(height, 190));
    }
  }, []);

  const handleToggleDevTools = useCallback(() => {
    setShowDevTools((prev) => !prev);
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isMobile) return;
    if (!showDevTools) return;
    const rafId = requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => cancelAnimationFrame(rafId);
  }, [devToolsHeight, isMobile, showDevTools]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isMobile) return;
    try {
      localStorage.setItem(DEVTOOLS_VISIBLE_KEY, String(showDevTools));
      localStorage.setItem(PREVIEW_CHROME_COMPACT_KEY, String(compactChrome));
      localStorage.setItem(PREVIEW_DESKTOP_MOBILE_VIEW_KEY, String(desktopMobileView));
    } catch {
      // Ignore localStorage persistence failures
    }
  }, [compactChrome, desktopMobileView, isMobile, showDevTools]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isMobile) return;
    try {
      localStorage.setItem(DEVTOOLS_HEIGHT_KEY, String(Math.round(devToolsHeight)));
    } catch {
      // Ignore localStorage persistence failures
    }
  }, [devToolsHeight, isMobile]);

  useEffect(() => {
    if (isMobile) return;
    if (!browserSplitEnabled) return;
    const rafId = requestAnimationFrame(() => {
      setPreviewTerminalFitToken((token) => token + 1);
    });
    return () => cancelAnimationFrame(rafId);
  }, [browserSplitEnabled, compactChrome, devToolsHeight, isMobile, showDevTools]);

  const handleDevToolsResizeMouseDown = useCallback((event) => {
    event.preventDefault();
    devToolsDragStartYRef.current = event.clientY;
    devToolsDragStartHeightRef.current = devToolsHeight;
    setIsDraggingDevTools(true);
  }, [devToolsHeight]);

  const handleDevToolsResizeTouchStart = useCallback((event) => {
    const touch = event.touches[0];
    if (!touch) return;
    devToolsDragStartYRef.current = touch.clientY;
    devToolsDragStartHeightRef.current = devToolsHeight;
    setIsDraggingDevTools(true);
  }, [devToolsHeight]);

  useEffect(() => {
    if (!isDraggingDevTools) return;

    const handleMouseMove = (event) => {
      const delta = devToolsDragStartYRef.current - event.clientY;
      const maxHeight = Math.floor(window.innerHeight * 0.7);
      const nextHeight = Math.min(Math.max(devToolsDragStartHeightRef.current + delta, 140), maxHeight);
      setDevToolsHeight(nextHeight);
    };

    const handleTouchMove = (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      const delta = devToolsDragStartYRef.current - touch.clientY;
      const maxHeight = Math.floor(window.innerHeight * 0.7);
      const nextHeight = Math.min(Math.max(devToolsDragStartHeightRef.current + delta, 140), maxHeight);
      setDevToolsHeight(nextHeight);
    };

    const handleEnd = () => {
      setIsDraggingDevTools(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleEnd);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDraggingDevTools]);

  const getMobileSplitBounds = useCallback(() => {
    const viewportHeight = getViewportHeight();
    const minHeight = 180;
    const maxHeight = Math.max(minHeight, viewportHeight * 0.75);
    return { minHeight, maxHeight, viewportHeight };
  }, [getViewportHeight]);

  const clampMobileSplitHeight = useCallback((nextHeight) => {
    const { minHeight, maxHeight } = getMobileSplitBounds();
    return Math.min(Math.max(nextHeight, minHeight), maxHeight);
  }, [getMobileSplitBounds]);

  const getMobileSplitSnapPoints = useCallback(() => {
    const { viewportHeight } = getMobileSplitBounds();
    const peek = clampMobileSplitHeight(Math.max(200, viewportHeight * 0.28));
    const half = clampMobileSplitHeight(viewportHeight * 0.45);
    const expanded = clampMobileSplitHeight(viewportHeight * 0.65);
    return [peek, half, expanded];
  }, [clampMobileSplitHeight, getMobileSplitBounds]);

  const snapMobileSplitHeight = useCallback((height) => {
    const clamped = clampMobileSplitHeight(height);
    const snapPoints = getMobileSplitSnapPoints();
    return snapPoints.reduce((closest, point) => (
      Math.abs(point - clamped) < Math.abs(closest - clamped) ? point : closest
    ), snapPoints[0]);
  }, [clampMobileSplitHeight, getMobileSplitSnapPoints]);

  const scheduleMobileChromeHide = useCallback(() => {
    // No-op: auto-hide removed — chrome visibility is driven by mobileViewMode
  }, []);

  const revealMobileChrome = useCallback(() => {
    // No-op: chrome visibility is driven by mobileViewMode
  }, []);

  // Mobile view mode handler
  const handleSetMobileViewMode = useCallback((mode) => {
    setMobileViewMode(mode);
    try { localStorage.setItem(MOBILE_VIEW_MODE_KEY, mode); } catch {}
    if (mode === 'split') setMobileSplitHeight(h => clampMobileSplitHeight(h));
    if (mode !== 'terminal') setShowMobileToolsMenu(false);
    // Keep view mode controls accessible when switching between mobile layouts.
    setShowLogs(false);
    // Exit inspect if switching to terminal — use handleToggleInspect so the iframe
    // is also reloaded without __inspect=1 (just setInspectMode(false) would update
    // the button but leave the inspector script running in the iframe).
    if (mode === 'terminal' && inspectMode) handleToggleInspect();
    // Trigger terminal refit when entering terminal mode
    if (mode === 'terminal' || mode === 'split') setPreviewTerminalFitToken(t => t + 1);
  }, [clampMobileSplitHeight, handleToggleInspect, inspectMode]);

  // Toggle between preview/split (keeps Cmd+K shortcut working)
  const handleToggleMobileSplit = useCallback(() => {
    handleSetMobileViewMode(mobileViewMode === 'split' ? 'preview' : 'split');
  }, [handleSetMobileViewMode, mobileViewMode]);

  const beginMobileSplitDrag = useCallback((clientY, mode) => {
    mobileSplitModeRef.current = mode;
    mobileSplitStartY.current = clientY;
    mobileSplitStartHeight.current = mobileSplitHeight;
    setIsDraggingMobileSplit(true);
  }, [mobileSplitHeight]);

  const handleMobileSplitTouchStart = useCallback((e) => {
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();
    beginMobileSplitDrag(e.touches[0].clientY, 'touch');
  }, [beginMobileSplitDrag]);

  const handleMobileSplitPointerDown = useCallback((e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    beginMobileSplitDrag(e.clientY, 'pointer');
  }, [beginMobileSplitDrag]);

  const handleMobileSplitDragMove = useCallback((clientY) => {
    if (!isDraggingMobileSplit) return;
    if (mobileSplitRafRef.current !== null) return;
    mobileSplitRafRef.current = requestAnimationFrame(() => {
      mobileSplitRafRef.current = null;
      const deltaY = mobileSplitStartY.current - clientY;
      const nextHeight = mobileSplitStartHeight.current + deltaY;
      setMobileSplitHeight(clampMobileSplitHeight(nextHeight));
    });
  }, [clampMobileSplitHeight, isDraggingMobileSplit]);

  const handleMobileSplitTouchMove = useCallback((e) => {
    if (!isDraggingMobileSplit || mobileSplitModeRef.current !== 'touch') return;
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();
    handleMobileSplitDragMove(e.touches[0].clientY);
  }, [handleMobileSplitDragMove, isDraggingMobileSplit]);

  const handleMobileSplitPointerMove = useCallback((e) => {
    if (!isDraggingMobileSplit || mobileSplitModeRef.current !== 'pointer') return;
    e.preventDefault();
    handleMobileSplitDragMove(e.clientY);
  }, [handleMobileSplitDragMove, isDraggingMobileSplit]);

  const endMobileSplitDrag = useCallback(() => {
    if (!isDraggingMobileSplit) return;
    if (mobileSplitRafRef.current !== null) {
      cancelAnimationFrame(mobileSplitRafRef.current);
      mobileSplitRafRef.current = null;
    }
    setMobileSplitHeight((height) => snapMobileSplitHeight(height));
    mobileSplitModeRef.current = null;
    setIsDraggingMobileSplit(false);
  }, [isDraggingMobileSplit, snapMobileSplitHeight]);

  // Add drag event listeners for mobile split drag
  useEffect(() => {
    if (!isDraggingMobileSplit) return;
    document.addEventListener('touchmove', handleMobileSplitTouchMove, { passive: false });
    document.addEventListener('touchend', endMobileSplitDrag);
    document.addEventListener('touchcancel', endMobileSplitDrag);
    document.addEventListener('pointermove', handleMobileSplitPointerMove, { passive: false });
    document.addEventListener('pointerup', endMobileSplitDrag);
    document.addEventListener('pointercancel', endMobileSplitDrag);
    return () => {
      document.removeEventListener('touchmove', handleMobileSplitTouchMove);
      document.removeEventListener('touchend', endMobileSplitDrag);
      document.removeEventListener('touchcancel', endMobileSplitDrag);
      document.removeEventListener('pointermove', handleMobileSplitPointerMove);
      document.removeEventListener('pointerup', endMobileSplitDrag);
      document.removeEventListener('pointercancel', endMobileSplitDrag);
    };
  }, [endMobileSplitDrag, handleMobileSplitPointerMove, handleMobileSplitTouchMove, isDraggingMobileSplit]);


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
  }, [activeSessionId, activeSessions, selectedTerminalSession]);

  useEffect(() => {
    if (!isMobile) return;
    if (!activeSessions || activeSessions.length === 0) {
      // Auto-switch to preview when last session closes
      if (mobileViewMode !== 'preview') {
        setMobileViewMode('preview');
        try { localStorage.setItem(MOBILE_VIEW_MODE_KEY, 'preview'); } catch {}
      }
      return;
    }
    setMobileSplitHeight((height) => clampMobileSplitHeight(height));
  }, [activeSessions, clampMobileSplitHeight, isMobile, mobileViewMode]);

  useEffect(() => {
    if (!isMobile || mobileModeInitializedRef.current) return;
    mobileModeInitializedRef.current = true;
    if (!url && mobileViewMode !== 'preview') {
      setMobileViewMode('preview');
      try {
        localStorage.setItem(MOBILE_VIEW_MODE_KEY, 'preview');
      } catch {
        // Ignore localStorage failures
      }
    }
  }, [isMobile, mobileViewMode, url]);

  useEffect(() => {
    if (!isMobile) return;
    try {
      localStorage.setItem(MOBILE_VIEW_MODE_KEY, mobileViewMode);
      localStorage.setItem(MOBILE_SPLIT_HEIGHT_KEY, String(Math.round(clampMobileSplitHeight(mobileSplitHeight))));
      if (selectedTerminalSession) {
        localStorage.setItem(MOBILE_SPLIT_SESSION_KEY, selectedTerminalSession);
      }
    } catch {
      // Ignore localStorage persistence failures on restricted browsers
    }
  }, [clampMobileSplitHeight, isMobile, mobileViewMode, mobileSplitHeight, selectedTerminalSession]);

  useEffect(() => {
    if (!isMobile) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboardInset = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      setMobileKeyboardInset(Math.round(inset));
    };
    updateKeyboardInset();
    viewport.addEventListener('resize', updateKeyboardInset);
    viewport.addEventListener('scroll', updateKeyboardInset);
    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset);
      viewport.removeEventListener('scroll', updateKeyboardInset);
    };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;

    let frameId = null;
    const updateFooterHeight = () => {
      const measured = mobileFooterRef.current?.getBoundingClientRect().height || 0;
      const nextHeight = Math.max(48, Math.round(measured || 68));
      setMobileFooterHeight((previous) => (previous === nextHeight ? previous : nextHeight));
    };
    const scheduleFooterHeightUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        updateFooterHeight();
      });
    };

    scheduleFooterHeightUpdate();
    window.addEventListener('resize', scheduleFooterHeightUpdate);

    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', scheduleFooterHeightUpdate);
      viewport.addEventListener('scroll', scheduleFooterHeightUpdate);
    }

    let observer = null;
    if (typeof ResizeObserver !== 'undefined' && mobileFooterRef.current) {
      observer = new ResizeObserver(scheduleFooterHeightUpdate);
      observer.observe(mobileFooterRef.current);
    }

    return () => {
      window.removeEventListener('resize', scheduleFooterHeightUpdate);
      if (viewport) {
        viewport.removeEventListener('resize', scheduleFooterHeightUpdate);
        viewport.removeEventListener('scroll', scheduleFooterHeightUpdate);
      }
      if (observer) {
        observer.disconnect();
      }
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile || mobileViewMode !== 'terminal') return;
    if (showPortDropdown) {
      setShowPortDropdown(false);
      setMobilePortSearch('');
    }
    if (showUrlInput) {
      setShowUrlInput(false);
    }
  }, [isMobile, mobileViewMode, showPortDropdown, showUrlInput]);

  useEffect(() => {
    if (!isMobile) return;
    // Chrome is only hidden in terminal mode
    setMobileChromeHidden(mobileViewMode === 'terminal');
    if (mobileChromeTimerRef.current) {
      clearTimeout(mobileChromeTimerRef.current);
      mobileChromeTimerRef.current = null;
    }
  }, [isMobile, mobileViewMode]);

  useEffect(() => {
    return () => {
      if (mobileChromeTimerRef.current) {
        clearTimeout(mobileChromeTimerRef.current);
        mobileChromeTimerRef.current = null;
      }
    };
  }, []);

  // Click-outside handler for mobile tools menu
  useEffect(() => {
    if (!showMobileToolsMenu) return;
    const handleClickOutside = (e) => {
      if (mobileToolsMenuRef.current && !mobileToolsMenuRef.current.contains(e.target)) {
        setShowMobileToolsMenu(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [showMobileToolsMenu]);

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
    // On mobile, avoid auto-opening the logs sheet because it can mask mode controls.
    if (!isMobile && errorLogs.length > 0 && !showLogs) {
      setShowLogs(true);
    }
  }, [errorLogs.length, isMobile, showLogs]);

  const mobileViewportHeight = getViewportHeight();
  const mobileSplitMaxHeight = Math.max(180, mobileViewportHeight * 0.75);
  const mobileTerminalVisible = Boolean(mobileViewMode === 'split' && activeSessions && activeSessions.length > 0);
  const mobileOverlayHeight = Math.min(mobileSplitHeight, mobileSplitMaxHeight);
  const projectFolderScope = useMemo(() => {
    const cwd = projectInfo?.cwd;
    if (!cwd || typeof cwd !== 'string') return '';
    const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/').filter(Boolean);
    return (parts[parts.length - 1] || '').toLowerCase();
  }, [projectInfo?.cwd]);
  const sessionFolderScopes = useMemo(() => {
    const scopes = new Set();
    for (const session of activeSessions || []) {
      const pathCandidate = session?.thread?.projectPath || session?.groupPath || session?.cwd;
      if (!pathCandidate || typeof pathCandidate !== 'string') continue;
      const normalized = pathCandidate.replace(/\\/g, '/').replace(/\/+$/, '');
      const parts = normalized.split('/').filter(Boolean);
      const scope = (parts[parts.length - 1] || '').toLowerCase();
      if (scope) scopes.add(scope);
    }
    return scopes;
  }, [activeSessions]);
  const currentPreviewPortCandidate = useMemo(() => {
    return previewPort || extractPortFromUrl(inputUrl);
  }, [inputUrl, previewPort]);
  const currentPreviewCwdScope = useMemo(() => {
    if (!currentPreviewPortCandidate) return '';
    const currentPort = activePorts.find((portInfo) => portInfo.port === currentPreviewPortCandidate);
    const cwd = currentPort?.cwd;
    if (!cwd || typeof cwd !== 'string') return '';
    return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }, [activePorts, currentPreviewPortCandidate]);
  const scopedFolderScopes = useMemo(() => {
    const scopes = new Set(sessionFolderScopes);
    if (projectFolderScope) scopes.add(projectFolderScope);
    if (currentPreviewCwdScope) scopes.add(currentPreviewCwdScope);
    return scopes;
  }, [currentPreviewCwdScope, projectFolderScope, sessionFolderScopes]);
  const scopedActivePorts = useMemo(() => {
    if (scopedFolderScopes.size === 0) return activePorts;
    const matches = activePorts.filter((portInfo) => {
      if (currentPreviewPortCandidate && portInfo.port === currentPreviewPortCandidate) return true;
      if (!portInfo?.cwd || typeof portInfo.cwd !== 'string') return false;
      const normalized = portInfo.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      return scopedFolderScopes.has(normalized);
    });
    return matches.length > 0 ? matches : activePorts;
  }, [activePorts, currentPreviewPortCandidate, scopedFolderScopes]);
  const isProjectScopedPort = useCallback((portInfo) => {
    if (!projectFolderScope || !portInfo?.cwd || typeof portInfo.cwd !== 'string') return false;
    const normalized = portInfo.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalized === projectFolderScope || normalized.endsWith(`/${projectFolderScope}`);
  }, [projectFolderScope]);
  const rankPort = useCallback((portInfo) => {
    let score = 0;
    if (!portInfo?.listening) score += 10000;
    if (portInfo?.port === previewPort) score -= 1000;
    if (isProjectScopedPort(portInfo)) score -= 250;
    if (portInfo?.frontendLikely === true || portInfo?.previewable === true) score -= 200;
    if (portInfo?.reachable === true) score -= 120;
    if (portInfo?.previewed) score -= 60;
    if (portInfo?.common) score -= 30;
    if (portInfo?.probeStatus === 'excluded-process') score += 40;
    if (portInfo?.probeStatus === 'timeout') score += 20;
    return score;
  }, [isProjectScopedPort, previewPort]);
  const rankedActivePorts = useMemo(() => {
    return [...scopedActivePorts].sort((a, b) => {
      const delta = rankPort(a) - rankPort(b);
      if (delta !== 0) return delta;
      return a.port - b.port;
    });
  }, [rankPort, scopedActivePorts]);
  const frontendCandidatePorts = useMemo(() => {
    return rankedActivePorts.filter((portInfo) => isFrontendCandidatePort(portInfo, previewPort));
  }, [previewPort, rankedActivePorts]);
  const uniqueFrontendPorts = useMemo(() => {
    const bestByApp = new Map();
    for (const portInfo of frontendCandidatePorts) {
      const key = getPortAppKey(portInfo);
      const existing = bestByApp.get(key);
      if (!existing) {
        bestByApp.set(key, portInfo);
        continue;
      }
      const currentRank = rankPort(portInfo);
      const existingRank = rankPort(existing);
      if (currentRank < existingRank || (currentRank === existingRank && portInfo.port < existing.port)) {
        bestByApp.set(key, portInfo);
      }
    }
    return Array.from(bestByApp.values()).sort((a, b) => {
      const delta = rankPort(a) - rankPort(b);
      if (delta !== 0) return delta;
      return a.port - b.port;
    });
  }, [frontendCandidatePorts, rankPort]);
  const mobileListeningPorts = useMemo(() => {
    return uniqueFrontendPorts;
  }, [uniqueFrontendPorts]);
  const desktopVisiblePorts = useMemo(() => {
    return uniqueFrontendPorts;
  }, [uniqueFrontendPorts]);
  const mobileVisiblePorts = useMemo(() => {
    const query = mobilePortSearch.trim().toLowerCase();
    if (!query) return mobileListeningPorts;
    return mobileListeningPorts.filter(({ port, process, cwd }) => {
      const processText = (process || '').toLowerCase();
      const cwdText = (cwd || '').toLowerCase();
      return (
        String(port).includes(query) ||
        processText.includes(query) ||
        cwdText.includes(query)
      );
    });
  }, [mobileListeningPorts, mobilePortSearch]);
  const desktopLayoutMode = showDevTools ? 'debug' : (browserSplitEnabled ? 'split' : 'preview');
  const desktopMobileViewportActive = desktopMobileView && Boolean(iframeSrc) && !useWebContainer;
  const totalLogCount = logs.length + proxyLogs.length + processLogs.length;
  const previewTerminalFontSize = useMemo(() => {
    const base = Number.isFinite(fontSize) ? fontSize : 14;
    return base;
  }, [fontSize]);
  const desktopPanelStyle = useMemo(() => ({
    '--preview-header-btn-size': `${terminalControlSize}px`,
    '--preview-terminal-control-size': `${terminalControlSize}px`,
  }), [terminalControlSize]);
  const mobilePanelStyle = {
    '--mobile-keyboard-inset': `${mobileKeyboardInset}px`,
    '--mobile-footer-height': `${mobileFooterHeight}px`,
    '--mobile-terminal-sheet-height': `${Math.round(mobileOverlayHeight)}px`
  };

  useEffect(() => {
    if (isMobile) return;

    const baseSize = Math.max(28, Math.min(42, Math.round((Number.isFinite(fontSize) ? fontSize : 14) * 2.2)));
    const panel = previewPanelRef.current;
    const section = previewTerminalSectionRef.current;
    if (!browserSplitEnabled || !panel || !section || typeof ResizeObserver === 'undefined') {
      setTerminalControlSize((prev) => (prev === baseSize ? prev : baseSize));
      setTerminalAlignedWidth(null);
      return;
    }

    const minWidth = 300;
    const maxWidth = 760;
    const headerRightPadding = compactChrome ? 6 : 8;
    const update = () => {
      const sectionRect = section.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const width = sectionRect.width;
      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, width));
      const widthScale = 0.9 + ((clampedWidth - minWidth) / (maxWidth - minWidth)) * 0.2;
      const nextSize = Math.max(26, Math.min(44, Math.round(baseSize * widthScale)));
      setTerminalControlSize((prev) => (prev === nextSize ? prev : nextSize));
      const rightZoneWidth = terminalPosition === 'right'
        ? (panelRect.right - headerRightPadding) - sectionRect.left
        : (panelRect.right - headerRightPadding) - sectionRect.right;
      const nextWidth = Math.max(0, Math.round(rightZoneWidth));
      setTerminalAlignedWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(section);
    return () => observer.disconnect();
  }, [browserSplitEnabled, compactChrome, fontSize, isMobile, terminalPosition]);

  // Mobile layout
  if (isMobile) {
    return (
      <div
        className={`preview-panel preview-panel-mobile mode-${mobileViewMode}${mobileChromeHidden ? ' chrome-hidden' : ''}`}
        style={mobilePanelStyle}
      >
        {/* Iframe content (hidden in terminal mode) */}
        {mobileViewMode !== 'terminal' && (
        <div
          className="preview-content-mobile"
          style={mobileTerminalVisible ? {
            height: `calc(100% - ${mobileOverlayHeight}px)`
          } : undefined}
        >
          {!iframeSrc ? (
            <div className="preview-empty">
              {url && (url.includes(`:${uiPort}`) || url.includes(`preview-${uiPort}`)) ? (
                <>
                  <div className="preview-empty-icon">{'\u{1F6AB}'}</div>
                  <h3>Cannot Preview V4</h3>
                  <p>V4 (port {uiPort}) cannot be viewed in its own preview panel to prevent infinite recursion.</p>
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
              <div className="preview-error-actions">
                <button type="button" className="btn-primary" onClick={handleRefresh}>
                  Try Again
                </button>
                {compatibilityFallbackPrompt && (
                  <button type="button" className="btn-secondary" onClick={handleUseCompatibilityMode}>
                    Use Compatibility Mode
                  </button>
                )}
                <button type="button" className="btn-secondary" onClick={handleOpenExternal} disabled={!iframeSrc}>
                  Open in New Tab
                </button>
              </div>
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
        )}

        {/* Unified mobile terminal — one TerminalChat instance for both split and terminal modes */}
        {(mobileViewMode === 'split' || mobileViewMode === 'terminal') && activeSessions && activeSessions.length > 0 && (
          <div
            className={
              mobileViewMode === 'terminal'
                ? 'preview-mobile-terminal-fullscreen'
                : `preview-mobile-terminal${isDraggingMobileSplit ? ' dragging' : ''}${mobileTerminalVisible ? ' open' : ' hidden'}`
            }
            style={mobileViewMode === 'split' ? { height: `${mobileOverlayHeight}px` } : undefined}
            aria-hidden={mobileViewMode === 'split' && !mobileTerminalVisible}
            onTransitionEnd={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.propertyName === 'transform' || event.propertyName === 'height' || event.propertyName === 'bottom') {
                setPreviewTerminalFitToken((token) => token + 1);
              }
            }}
          >
            {/* Drag handle (split mode only) */}
            {mobileViewMode === 'split' && (
              <div
                className="preview-mobile-terminal-handle"
                onTouchStart={handleMobileSplitTouchStart}
                onPointerDown={handleMobileSplitPointerDown}
              >
                <div className="preview-mobile-terminal-handle-bar" />
              </div>
            )}

            {/* Session switcher */}
            <div className="preview-mobile-terminal-header">
              <div className="preview-mobile-terminal-sessions">
                {activeSessions.map(session => (
                  (() => {
                    const isActive = selectedTerminalSession === session.id;
                    const activityState = sessionActivity?.[session.id];
                    const backendBusy = typeof session?.isBusy === 'boolean'
                      ? session.isBusy
                      : Boolean(activityState?.isBusy);
                    const isBusy = isActive ? backendBusy : false;
                    const statusClass = isBusy ? 'busy' : 'idle';
                    return (
                  <button
                    key={session.id}
                    className={`preview-mobile-session-chip ${isActive ? 'active' : ''}${isBusy ? ' busy' : ''}`}
                    onClick={() => setSelectedTerminalSession(session.id)}
                    type="button"
                  >
                    <span className={`session-indicator ${statusClass}`} />
                    <span className="session-name">
                      {session.title || `Session ${session.id.slice(0, 8)}`}
                    </span>
                    {showStatusLabels && (
                      <span className={`session-status-label ${statusClass}`} aria-hidden="true">
                        {isBusy ? 'Busy' : 'Idle'}
                      </span>
                    )}
                  </button>
                    );
                  })()
                ))}
              </div>
              <button
                className="preview-mobile-terminal-btn preview-mobile-terminal-btn-reconnect"
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
                className="preview-mobile-terminal-btn preview-mobile-terminal-btn-focus"
                onClick={() => focusPreviewTerminalRef.current?.()}
                type="button"
                aria-label="Focus terminal input"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
                </svg>
              </button>
              {mobileViewMode === 'split' && (
                <button
                  className="preview-mobile-terminal-btn preview-mobile-terminal-btn-close"
                  onClick={handleToggleMobileSplit}
                  type="button"
                  aria-label="Close terminal"
                >
                  ×
                </button>
              )}
            </div>

            {/* Terminal content */}
            <div className="preview-mobile-terminal-content">
              {selectedTerminalSession ? (
                <TerminalChat
                  key={`${selectedTerminalSession}-${previewTerminalRefreshToken}`}
                  surface={isMobile ? 'mobile' : 'desktop'}
                  sessionId={selectedTerminalSession}
                  keybarOpen={false}
                  viewportHeight={null}
                  fontSize={fontSize}
                  webglEnabled={webglEnabled}
                  isPrimary={mainTerminalMinimized}
                  fitSignal={previewTerminalFitToken}
                  onUrlDetected={onUrlDetected || (() => {})}
                  usesTmux={activeSessions.find(s => s.id === selectedTerminalSession)?.usesTmux}
                  onRegisterImageUpload={() => {}}
                  onRegisterHistoryPanel={() => {}}
                  onRegisterFocusTerminal={(focusFn) => { focusPreviewTerminalRef.current = focusFn; }}
                  onActivityChange={(isBusy) => onSessionBusyChange?.(selectedTerminalSession, isBusy)}
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

        {/* Floating URL bar at top (hidden in terminal mode) */}
        <div className={`preview-floating-url${mobileViewMode === 'terminal' ? ' hidden' : ''}`}>
          {/* Port selector button */}
          <button
            type="button"
            className={`preview-floating-btn preview-port-btn-mobile ${showPortDropdown ? 'active' : ''}`}
            onClick={() => {
              setShowPortDropdown((prev) => {
                if (prev) setMobilePortSearch('');
                return !prev;
              });
            }}
            aria-label="Select port"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8" />
              <path d="M12 17v4" />
            </svg>
            {mobileListeningPorts.length > 0 && (
              <span className="preview-port-badge-mobile">{mobileListeningPorts.length}</span>
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
          {previewModeInfo.id !== 'none' && (
            <span
              className={`preview-mobile-mode-chip${previewModeInfo.limited ? ' limited' : ''}${previewModeInfo.id === 'subdomain' ? ' interactive' : ''}`}
              title={previewModeInfo.title || undefined}
            >
              {previewModeInfo.label}
            </span>
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
                onClick={() => {
                  setShowPortDropdown(false);
                  setMobilePortSearch('');
                }}
                aria-label="Close"
              >
                {'\u00D7'}
              </button>
            </div>
            {mobileListeningPorts.length === 0 ? (
              <div className="preview-port-sheet-empty">No frontend ports found</div>
            ) : (
              <>
                <div className="preview-port-sheet-toolbar">
                  <input
                    type="text"
                    className="preview-port-sheet-search"
                    placeholder="Filter by port, process, folder..."
                    value={mobilePortSearch}
                    onChange={(event) => setMobilePortSearch(event.target.value)}
                    aria-label="Filter active ports"
                  />
                </div>
                <div className="preview-port-sheet-list">
                  {mobileVisiblePorts.length === 0 && (
                    <div className="preview-port-sheet-empty">No matches for "{mobilePortSearch}"</div>
                  )}
                  {mobileVisiblePorts.map(({ port, process, cwd }) => (
                  <button
                    key={port}
                    type="button"
                    className={`preview-port-sheet-item ${port === previewPort ? 'current' : ''}`}
                    onClick={() => handleSelectPort(port)}
                  >
                    <span className="preview-port-sheet-number">:{port}</span>
                    {(cwd || process) && (
                      <span className="preview-port-sheet-process" title={`${process || ''} ${cwd || ''}`.trim()}>
                        {process || cwd}
                      </span>
                    )}
                    <span className="preview-port-sheet-status">
                      <span className="preview-port-dot listening" title="Listening" />
                    </span>
                  </button>
                ))}
                </div>
              </>
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
            <button
              type="button"
              className="preview-console-clear"
              onClick={(e) => { e.stopPropagation(); handleCopyPreviewDebugInfo(); }}
              title="Copy preview debug snapshot"
            >
              Debug
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

        {/* Footer with segmented control + overflow */}
        <div className="preview-mobile-footer" ref={mobileFooterRef}>
          <div className="preview-mobile-segmented" role="tablist">
            <div
              className="preview-mobile-segmented-indicator"
              style={{ transform: `translateX(${mobileViewMode === 'preview' ? 0 : mobileViewMode === 'split' ? 100 : 200}%)` }}
            />
            <button
              className={`preview-mobile-segmented-btn${mobileViewMode === 'preview' ? ' active' : ''}`}
              onClick={() => handleSetMobileViewMode('preview')}
              role="tab"
              aria-selected={mobileViewMode === 'preview'}
              type="button"
            >Preview</button>
            <button
              className={`preview-mobile-segmented-btn${mobileViewMode === 'split' ? ' active' : ''}`}
              onClick={() => handleSetMobileViewMode('split')}
              disabled={!activeSessions?.length}
              role="tab"
              aria-selected={mobileViewMode === 'split'}
              type="button"
            >Split</button>
            <button
              className={`preview-mobile-segmented-btn${mobileViewMode === 'terminal' ? ' active' : ''}`}
              onClick={() => handleSetMobileViewMode('terminal')}
              disabled={!activeSessions?.length}
              role="tab"
              aria-selected={mobileViewMode === 'terminal'}
              type="button"
            >Terminal</button>
          </div>
          <button
            className="preview-mobile-overflow-btn"
            onClick={() => setShowMobileToolsMenu(prev => !prev)}
            aria-label="More tools"
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
            {totalLogCount > 0 && <span className="preview-log-badge">{totalLogCount}</span>}
          </button>
        </div>

        {/* Tools bottom sheet */}
        {showMobileToolsMenu && (
          <div className="preview-mobile-tools-sheet" ref={mobileToolsMenuRef}>
            <div className="preview-mobile-tools-sheet-header">
              <span>Tools</span>
              <button
                type="button"
                className="preview-mobile-tools-sheet-close"
                onClick={() => setShowMobileToolsMenu(false)}
                aria-label="Close"
              >{'\u00D7'}</button>
            </div>
            <div className="preview-mobile-tools-sheet-items">
              <button
                type="button"
                className={`preview-mobile-tools-item${inspectMode ? ' active' : ''}`}
                onClick={() => { handleToggleInspect(); setShowMobileToolsMenu(false); }}
                disabled={!iframeSrc}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                  <path d="M13 13l6 6" />
                </svg>
                <span>Inspect Element</span>
              </button>
              <button
                type="button"
                className="preview-mobile-tools-item"
                onClick={() => { handleOpenExternal(); setShowMobileToolsMenu(false); }}
                disabled={!iframeSrc}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span>Open in New Tab</span>
              </button>
              <button
                type="button"
                className={`preview-mobile-tools-item${showLogs ? ' active' : ''}`}
                onClick={() => { setShowLogs(!showLogs); setShowMobileToolsMenu(false); }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <span>Console</span>
                {totalLogCount > 0 && <span className="preview-mobile-tools-count">{totalLogCount}</span>}
              </button>
              {previewPort && hasCookies && (
                <button
                  type="button"
                  className="preview-mobile-tools-item"
                  onClick={() => { handleClearCookies(); setShowMobileToolsMenu(false); }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 12h8" />
                    <circle cx="12" cy="12" r="3" fill="currentColor" />
                  </svg>
                  <span>Clear Cookies</span>
                </button>
              )}
              <button
                type="button"
                className="preview-mobile-tools-item"
                onClick={() => { handleClearCache(); setShowMobileToolsMenu(false); }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
                <span>Clear Cache</span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Desktop layout
  return (
    <div ref={previewPanelRef} className={`preview-panel${compactChrome ? ' compact-chrome' : ''}`} style={desktopPanelStyle}>
      <PreviewUrlBar
        inputUrl={inputUrl}
        onInputUrlChange={setInputUrl}
        activePorts={desktopVisiblePorts}
        previewPort={previewPort}
        showPortDropdown={showPortDropdown}
        onTogglePortDropdown={() => setShowPortDropdown(!showPortDropdown)}
        portDropdownRef={portDropdownRef}
        onSelectPort={handleSelectPort}
        onUrlSubmit={handleUrlSubmit}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        historyIndex={historyIndex}
        historyStackLength={historyStack.length}
        isLoading={isLoading}
        iframeSrc={iframeSrc}
        browserSplitEnabled={browserSplitEnabled}
        onToggleTerminalSplit={handleToggleTerminalSplit}
        desktopLayoutMode={desktopLayoutMode}
        onSetDesktopLayout={handleSetDesktopLayout}
        mobileViewportEnabled={desktopMobileView}
        onToggleMobileViewport={() => setDesktopMobileView((prev) => !prev)}
        useWebContainer={useWebContainer}
        showDevTools={showDevTools}
        onToggleDevTools={handleToggleDevTools}
        compactChrome={compactChrome}
        onToggleCompactChrome={() => setCompactChrome((prev) => !prev)}
        logCount={totalLogCount}
        showToolsMenu={showToolsMenu}
        onToggleToolsMenu={() => setShowToolsMenu(prev => !prev)}
        toolsMenuRef={toolsMenuRef}
        inspectMode={inspectMode}
        onToggleInspect={handleToggleInspect}
        webContainerSupported={webContainerSupported}
        onToggleWebContainer={() => setUseWebContainer(!useWebContainer)}
        onOpenExternal={handleOpenExternal}
        hasCookies={hasCookies}
        onClearCookies={handleClearCookies}
        onClearCache={handleClearCache}
        previewModeInfo={previewModeInfo}
        compatibilityModeNotice={compatibilityModeNotice}
        mainTerminalMinimized={mainTerminalMinimized}
        onToggleMainTerminal={onToggleMainTerminal}
        alignTerminalControls={browserSplitEnabled}
        terminalAlignedWidth={terminalAlignedWidth}
        onClose={onClose}
      />

      <div
        ref={browserSplitRef}
        className={`preview-content-wrapper${isDraggingBrowserSplit || isDraggingDevTools ? ' dragging' : ''}${terminalPosition === 'left' ? ' terminal-left' : ''}`}
      >
        <div
          className="preview-iframe-section"
          style={browserSplitEnabled ? { flex: `0 0 ${browserSplitPosition}%` } : { flex: 1 }}
        >
          <div className={`preview-content${desktopMobileViewportActive ? ' mobile-emulation' : ''}`}>
            {!iframeSrc ? (
              <div className="preview-empty">
                {url && (url.includes(`:${uiPort}`) || url.includes(`preview-${uiPort}`)) ? (
                  <>
                    <div className="preview-empty-icon">{'\u{1F6AB}'}</div>
                    <h3>Cannot Preview V4</h3>
                    <p>V4 (port {uiPort}) cannot be viewed in its own preview panel to prevent infinite recursion.</p>
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
                    {uniqueFrontendPorts.length > 0 && (
                      <div className="preview-empty-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => {
                            const firstPort = uniqueFrontendPorts[0]?.port;
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
                <div className="preview-error-actions">
                  <button type="button" className="btn-primary" onClick={handleRefresh}>
                    Try Again
                  </button>
                  {compatibilityFallbackPrompt && (
                    <button type="button" className="btn-secondary" onClick={handleUseCompatibilityMode}>
                      Use Compatibility Mode
                    </button>
                  )}
                  <button type="button" className="btn-secondary" onClick={handleOpenExternal} disabled={!iframeSrc}>
                    Open in New Tab
                  </button>
                </div>
              </div>
            ) : useWebContainer ? (
              <WebContainerPreview
                projectPath={projectInfo?.cwd}
                startCommand={projectInfo?.startCommand || 'npm run dev'}
                onStatusChange={(status, message) => setWebContainerStatus({ status, message })}
                onServerReady={(url, port) => {
                  if (import.meta.env.DEV) {
                    console.log('[WebContainer] Server ready:', url, port);
                  }
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
            <div className="preview-terminal-section" ref={previewTerminalSectionRef}>
              <div className="preview-terminal-header">
                {activeSessions && activeSessions.length > 0 ? (
                  <div className="preview-session-switcher">
                    {activeSessions.map(session => (
                      (() => {
                        const isActive = selectedTerminalSession === session.id;
                        const activityState = sessionActivity?.[session.id];
                        const backendBusy = typeof session?.isBusy === 'boolean'
                          ? session.isBusy
                          : Boolean(activityState?.isBusy);
                        const isBusy = isActive ? backendBusy : false;
                        const statusClass = isBusy ? 'busy' : 'idle';
                        return (
                      <button
                        key={session.id}
                        className={`preview-session-btn ${isActive ? 'active' : ''}${isBusy ? ' busy' : ''}`}
                        onClick={() => setSelectedTerminalSession(session.id)}
                        title={session.title || `Session ${session.id.slice(0, 8)}`}
                      >
                        <span className={`session-indicator ${statusClass}`} />
                        <span className="session-name">
                          {session.title || `Session ${session.id.slice(0, 8)}`}
                        </span>
                        {showStatusLabels && (
                          <span className={`session-status-label ${statusClass}`} aria-hidden="true">
                            {isBusy ? 'Busy' : 'Idle'}
                          </span>
                        )}
                      </button>
                        );
                      })()
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
                  surface={isMobile ? 'mobile' : 'desktop'}
                  sessionId={selectedTerminalSession}
                    keybarOpen={false}
                    viewportHeight={null}
                    fontSize={previewTerminalFontSize}
                  webglEnabled={webglEnabled}
                  isPrimary={mainTerminalMinimized}
                  syncPtySize
                  fitSignal={previewTerminalFitToken}
                    onUrlDetected={onUrlDetected || (() => {})}
                    usesTmux={activeSessions.find(s => s.id === selectedTerminalSession)?.usesTmux}
                    onRegisterImageUpload={() => {}}
                    onRegisterFocusTerminal={(focusFn) => { focusPreviewTerminalRef.current = focusFn; }}
                    onActivityChange={(isBusy) => onSessionBusyChange?.(selectedTerminalSession, isBusy)}
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
        <div
          className={`preview-logs expanded${isDraggingDevTools ? ' dragging' : ''}`}
          style={{ height: `${Math.round(devToolsHeight)}px` }}
        >
          <div
            className="preview-logs-resize-handle"
            onMouseDown={handleDevToolsResizeMouseDown}
            onTouchStart={handleDevToolsResizeTouchStart}
            onDoubleClick={() => setDevToolsHeight(280)}
            title="Resize DevTools"
          >
            <span className="preview-logs-resize-label">Drag to resize DevTools</span>
          </div>
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
      <PreviewInspector
        selectedElement={selectedElement}
        elementPath={elementPath}
        copyFeedback={copyFeedback}
        showStyleEditor={showStyleEditor}
        onClearSelection={handleClearSelection}
        onCopyElementInfo={handleCopyElementInfo}
        onCopyToTerminal={handleCopyToTerminal}
        onStylePreview={handleStylePreview}
        onStyleApply={handleStyleApply}
        onStyleRevert={handleStyleRevert}
        onSendToTerminal={onSendToTerminal}
      />

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
