import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';
import { extractPortFromUrl, getActivePortsInfo } from '../utils/previewUrl';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

const PreviewContext = createContext(null);
const PREVIEW_URL_KEY = 'terminal_preview_url';
const PREVIEW_SUBDOMAIN_BASE_KEY = 'terminal_preview_subdomain_base';
const PREVIEW_SUBDOMAIN_BASES_KEY = 'terminal_preview_subdomain_bases';
const PREVIEW_PROXY_HOSTS_KEY = 'terminal_preview_proxy_hosts';
const PREVIEW_PREFER_PATH_BASED_KEY = 'terminal_preview_prefer_path_based';
const PREVIEW_DEFAULT_MODE_KEY = 'terminal_preview_default_mode';
const PREVIEW_COOKIE_POLICY_KEY = 'terminal_preview_cookie_policy';
const PREVIEW_REWRITE_SCOPE_KEY = 'terminal_preview_rewrite_scope';

export function PreviewProvider({ children }) {
  function sanitizePreviewUrl(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      const parsed = new URL(value, window.location.origin);
      const isPreviewPath = parsed.pathname.startsWith('/preview/');
      const isApiPreview = parsed.pathname.startsWith('/api/preview');
      const isSameOrigin = parsed.origin === window.location.origin;
      const uiPort = window.location.port;
      const isLoopbackHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(parsed.hostname);
      if (isSameOrigin && !isPreviewPath && !isApiPreview) {
        return null;
      }
      if (uiPort && isLoopbackHost && parsed.port === uiPort && !isPreviewPath && !isApiPreview) {
        return null;
      }
    } catch {
      return value.trim() || null;
    }
    return value.trim() || null;
  }

  // Initialize from localStorage for immediate display
  const initialPreviewUrl = (() => {
    try {
      return sanitizePreviewUrl(localStorage.getItem(PREVIEW_URL_KEY)) || null;
    } catch {
      return null;
    }
  })();
  const [previewUrl, setPreviewUrl] = useState(initialPreviewUrl);
  const [showPreview, setShowPreview] = useState(false);
  const saveTimeoutRef = useRef(null);
  const lastSavedUrlRef = useRef(null);
  const initialFetchDoneRef = useRef(false);
  const previewUrlRef = useRef(previewUrl);
  const previewUrlSourceRef = useRef(initialPreviewUrl ? 'user' : 'auto');
  const listeningPortsRef = useRef(new Set());
  const lastPortsRefreshAtRef = useRef(0);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  const refreshListeningPorts = useCallback(async () => {
    try {
      const ports = await getActivePortsInfo();
      const listeningSet = new Set(ports.filter((portInfo) => portInfo.listening).map((portInfo) => portInfo.port));
      listeningPortsRef.current = listeningSet;
      lastPortsRefreshAtRef.current = Date.now();

      const currentUrl = previewUrlRef.current;
      if (currentUrl && previewUrlSourceRef.current === 'user') {
        const currentPort = extractPortFromUrl(currentUrl);
        if (currentPort && !listeningSet.has(currentPort)) {
          previewUrlSourceRef.current = 'auto';
          setPreviewUrl(null);
          try {
            localStorage.removeItem(PREVIEW_URL_KEY);
          } catch {}
        }
      }

      return true;
    } catch {
      return false;
    }
  }, []);

  // Fetch active ports on mount and periodically to:
  // 1. Validate the stored URL (clear if port is dead)
  // 2. Keep listeningPortsRef updated for auto-detection blocking
  useEffect(() => {
    let isMounted = true;
    let pollTimer = null;
    let windowActive = isWindowActive();
    const shouldPoll = showPreview || Boolean(previewUrl);

    const VISIBLE_INTERVAL_MS = 10000;
    const HIDDEN_INTERVAL_MS = 30000;
    const ERROR_INTERVAL_MS = 20000;

    const scheduleNextPoll = (succeeded = true) => {
      if (!isMounted || !shouldPoll) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      const baseDelay = windowActive ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS;
      const delay = succeeded ? baseDelay : ERROR_INTERVAL_MS;
      pollTimer = setTimeout(async () => {
        const ok = await fetchAndValidate();
        scheduleNextPoll(ok);
      }, delay);
    };

    const runNow = async () => {
      const ok = await refreshListeningPorts();
      if (!isMounted) return;
      scheduleNextPoll(ok);
    };

    const handleWindowActivityChange = (nextWindowActive) => {
      if (!isMounted) return;
      windowActive = nextWindowActive;
      if (windowActive) {
        void runNow();
      } else {
        scheduleNextPoll(true);
      }
    };

    if (shouldPoll) {
      void runNow();
    } else {
      void refreshListeningPorts();
    }
    const unsubscribeWindowActivity = subscribeWindowActivity(handleWindowActivityChange);

    return () => {
      isMounted = false;
      unsubscribeWindowActivity();
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [previewUrl, refreshListeningPorts, showPreview]);

  const setPreviewUrlWithSource = useCallback((nextUrl, source) => {
    const normalized = sanitizePreviewUrl(nextUrl) || null;
    const current = previewUrlRef.current || null;

    if (!normalized && typeof nextUrl === 'string' && nextUrl.trim()) {
      return;
    }

    if (normalized === current) return;

    // For auto-detected URLs, validate the new port is actually listening
    if (source === 'auto' && normalized) {
      const newPort = extractPortFromUrl(normalized);
      const isNewPortListening = newPort && listeningPortsRef.current.has(newPort);
      if (!isNewPortListening) {
        return; // Don't accept auto-detected URLs for non-listening ports
      }
    }

    // Only block auto-detection if:
    // 1. This is an auto-detected URL
    // 2. User previously set a URL manually
    // 3. Current URL exists
    // 4. Current URL's port is actually listening
    if (source === 'auto' && previewUrlSourceRef.current === 'user' && current) {
      const currentPort = extractPortFromUrl(current);
      const isCurrentPortListening = currentPort && listeningPortsRef.current.has(currentPort);
      if (isCurrentPortListening) {
        return; // Block auto-detection only if current port is alive
      }
      // Current port is not listening, allow auto-detection to override
    }

    previewUrlSourceRef.current = normalized ? source : 'auto';
    setPreviewUrl(normalized);
  }, []);

  // Fetch preview URL from server on mount - use it only if localStorage is empty
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await apiFetch('/api/settings');
        if (response.ok) {
          const data = await response.json();
          const hasLocal = !!previewUrlRef.current;
          // Prefer localStorage if it exists; use server only as a fallback.
          if (data.previewUrl && !hasLocal) {
            const sanitized = sanitizePreviewUrl(data.previewUrl);
            if (!sanitized) {
              setPreviewUrl(null);
              lastSavedUrlRef.current = null;
              previewUrlSourceRef.current = 'auto';
              try {
                localStorage.removeItem(PREVIEW_URL_KEY);
              } catch {}
              return;
            }
            previewUrlSourceRef.current = 'user';
            setPreviewUrl(sanitized);
            lastSavedUrlRef.current = sanitized;
            try {
              localStorage.setItem(PREVIEW_URL_KEY, sanitized);
            } catch {}
          } else if (!data.previewUrl && !hasLocal) {
            setPreviewUrl(null);
            lastSavedUrlRef.current = null;
            previewUrlSourceRef.current = 'auto';
            try {
              localStorage.removeItem(PREVIEW_URL_KEY);
            } catch {}
          }
        }
      } catch {
        // Ignore errors, use localStorage fallback
        lastSavedUrlRef.current = previewUrlRef.current;
      } finally {
        initialFetchDoneRef.current = true;
      }
    };
    fetchSettings();
  }, []);

  // Fetch preview proxy configuration (subdomain base) for URL generation
  useEffect(() => {
    const fetchPreviewConfig = async () => {
      try {
        const response = await apiFetch('/api/system/preview-config');
        if (!response.ok) return;
        const data = await response.json();
        if (data?.subdomainBase) {
          try {
            localStorage.setItem(PREVIEW_SUBDOMAIN_BASE_KEY, data.subdomainBase);
          } catch {}
        }
        if (Array.isArray(data?.subdomainBases)) {
          try {
            localStorage.setItem(PREVIEW_SUBDOMAIN_BASES_KEY, JSON.stringify(data.subdomainBases));
          } catch {}
        }
        if (Array.isArray(data?.proxyHosts)) {
          try {
            localStorage.setItem(PREVIEW_PROXY_HOSTS_KEY, JSON.stringify(data.proxyHosts));
          } catch {}
        }
        if (typeof data?.preferPathBased === 'boolean') {
          try {
            localStorage.setItem(PREVIEW_PREFER_PATH_BASED_KEY, data.preferPathBased ? 'true' : 'false');
          } catch {}
        }
        if (typeof data?.defaultMode === 'string') {
          try {
            localStorage.setItem(PREVIEW_DEFAULT_MODE_KEY, data.defaultMode);
          } catch {}
        }
        if (typeof data?.cookiePolicy === 'string') {
          try {
            localStorage.setItem(PREVIEW_COOKIE_POLICY_KEY, data.cookiePolicy);
          } catch {}
        }
        if (typeof data?.rewriteScope === 'string') {
          try {
            localStorage.setItem(PREVIEW_REWRITE_SCOPE_KEY, data.rewriteScope);
          } catch {}
        }
      } catch {
        // Ignore config fetch errors; default behavior applies
      }
    };
    fetchPreviewConfig();
  }, []);

  // Persist previewUrl to localStorage and server (debounced)
  useEffect(() => {
    // Save to localStorage immediately
    try {
      if (previewUrl) {
        localStorage.setItem(PREVIEW_URL_KEY, previewUrl);
      } else {
        localStorage.removeItem(PREVIEW_URL_KEY);
      }
    } catch {}

    // Don't save to server until initial fetch is done (to avoid overwriting server with stale localStorage)
    if (!initialFetchDoneRef.current) return;

    // Debounce server save
    if (previewUrl === lastSavedUrlRef.current) return;
    if (previewUrlSourceRef.current !== 'user') return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await apiFetch('/api/settings', {
          method: 'PATCH',
          body: { previewUrl: previewUrl || '' }
        });
        lastSavedUrlRef.current = previewUrl;
      } catch {
        // Ignore save errors
      }
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [previewUrl]);

  // Preview PiP mode state
  const [previewMode, setPreviewMode] = useState('docked'); // 'docked' | 'pip' | 'hidden'
  const [pipPosition, setPipPosition] = useState({ x: window.innerWidth - 420, y: 80 });
  const [pipSize, setPipSize] = useState({ width: 400, height: 300 });

  // Handle URL detection from terminal
  const handleUrlDetected = useCallback(async (url) => {
    const port = extractPortFromUrl(url);
    const shouldRefreshPorts = port
      && !listeningPortsRef.current.has(port)
      && Date.now() - lastPortsRefreshAtRef.current > 2000;

    if (shouldRefreshPorts) {
      await refreshListeningPorts();
    }
    setPreviewUrlWithSource(url, 'auto');
    // Don't auto-open preview - user can click the preview button to see it
  }, [refreshListeningPorts, setPreviewUrlWithSource]);

  // Close preview
  const handlePreviewClose = useCallback(() => {
    setShowPreview(false);
  }, []);

  // Change preview URL
  const handlePreviewUrlChange = useCallback((url) => {
    setPreviewUrlWithSource(url, 'user');
  }, [setPreviewUrlWithSource]);

  // Toggle preview visibility
  const togglePreview = useCallback(() => {
    setShowPreview(prev => !prev);
  }, []);

  // Open preview
  const openPreview = useCallback(() => {
    setShowPreview(true);
  }, []);

  // Close and reset preview
  const closePreview = useCallback(() => {
    setShowPreview(false);
  }, []);

  // Set preview mode
  const setMode = useCallback((mode) => {
    setPreviewMode(mode);
  }, []);

  // Update PiP position
  const updatePipPosition = useCallback((position) => {
    setPipPosition(position);
  }, []);

  // Update PiP size
  const updatePipSize = useCallback((size) => {
    setPipSize(size);
  }, []);

  const value = {
    // State
    previewUrl,
    showPreview,
    previewMode,
    pipPosition,
    pipSize,

    // Actions
    handleUrlDetected,
    handlePreviewClose,
    handlePreviewUrlChange,
    togglePreview,
    openPreview,
    closePreview,
    setMode,
    updatePipPosition,
    updatePipSize,
    setShowPreview
  };

  return (
    <PreviewContext.Provider value={value}>
      {children}
    </PreviewContext.Provider>
  );
}

export function usePreview() {
  const context = useContext(PreviewContext);
  if (!context) {
    throw new Error('usePreview must be used within a PreviewProvider');
  }
  return context;
}
