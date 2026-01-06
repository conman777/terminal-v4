import { createContext, useContext, useState, useCallback } from 'react';

const PreviewContext = createContext(null);

export function PreviewProvider({ children }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  // Preview PiP mode state
  const [previewMode, setPreviewMode] = useState('docked'); // 'docked' | 'pip' | 'hidden'
  const [pipPosition, setPipPosition] = useState({ x: window.innerWidth - 420, y: 80 });
  const [pipSize, setPipSize] = useState({ width: 400, height: 300 });

  // Handle URL detection from terminal
  const handleUrlDetected = useCallback((url) => {
    setPreviewUrl(url);
    // Don't auto-open preview - user can click the preview button to see it
  }, []);

  // Close preview
  const handlePreviewClose = useCallback(() => {
    setShowPreview(false);
  }, []);

  // Change preview URL
  const handlePreviewUrlChange = useCallback((url) => {
    setPreviewUrl(url);
  }, []);

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
