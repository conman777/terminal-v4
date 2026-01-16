import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';

const PreviewContext = createContext(null);
const PREVIEW_URL_KEY = 'terminal_preview_url';

export function PreviewProvider({ children }) {
  // Initialize from localStorage for immediate display
  const initialPreviewUrl = (() => {
    try {
      return localStorage.getItem(PREVIEW_URL_KEY) || null;
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

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  const setPreviewUrlWithSource = useCallback((nextUrl, source) => {
    const normalized = nextUrl || null;
    const current = previewUrlRef.current || null;
    if (normalized === current) return;
    if (source === 'auto' && previewUrlSourceRef.current === 'user' && current) {
      return;
    }
    previewUrlSourceRef.current = source;
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
            previewUrlSourceRef.current = 'user';
            setPreviewUrl(data.previewUrl);
            lastSavedUrlRef.current = data.previewUrl;
            try {
              localStorage.setItem(PREVIEW_URL_KEY, data.previewUrl);
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
  const handleUrlDetected = useCallback((url) => {
    setPreviewUrlWithSource(url, 'auto');
    // Don't auto-open preview - user can click the preview button to see it
  }, [setPreviewUrlWithSource]);

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
