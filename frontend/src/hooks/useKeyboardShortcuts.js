import { useEffect, useCallback, useRef } from 'react';

/**
 * Global keyboard shortcuts for desktop.
 *
 * Shortcuts:
 * - Cmd+B: Toggle sidebar
 * - Cmd+P: Toggle preview
 * - Cmd+\: Toggle full-screen terminal
 * - Cmd+1-8: Focus pane 1-8
 * - Cmd+T: New terminal
 * - Cmd+W: Close current terminal
 * - Escape: Exit full-screen mode
 */
export function useKeyboardShortcuts({
  onToggleSidebar,
  onTogglePreview,
  onToggleFullScreen,
  onFocusPane,
  onNewTerminal,
  onCloseTerminal,
  onExitFullScreen,
  isFullScreen,
  paneCount = 1,
  enabled = true
}) {
  const handlersRef = useRef({
    onToggleSidebar,
    onTogglePreview,
    onToggleFullScreen,
    onFocusPane,
    onNewTerminal,
    onCloseTerminal,
    onExitFullScreen
  });

  // Keep handlers up to date
  useEffect(() => {
    handlersRef.current = {
      onToggleSidebar,
      onTogglePreview,
      onToggleFullScreen,
      onFocusPane,
      onNewTerminal,
      onCloseTerminal,
      onExitFullScreen
    };
  });

  const handleKeyDown = useCallback((e) => {
    // Don't trigger shortcuts when typing in inputs
    const target = e.target;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      // Allow Escape even in inputs
      if (e.key !== 'Escape') {
        return;
      }
    }

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

    // Escape - exit full screen
    if (e.key === 'Escape' && isFullScreen) {
      e.preventDefault();
      handlersRef.current.onExitFullScreen?.();
      return;
    }

    // Cmd+B - toggle sidebar
    if (cmdOrCtrl && e.key === 'b') {
      e.preventDefault();
      handlersRef.current.onToggleSidebar?.();
      return;
    }

    // Cmd+P - toggle preview (override browser print)
    if (cmdOrCtrl && e.key === 'p') {
      e.preventDefault();
      handlersRef.current.onTogglePreview?.();
      return;
    }

    // Cmd+\ - toggle full screen
    if (cmdOrCtrl && e.key === '\\') {
      e.preventDefault();
      handlersRef.current.onToggleFullScreen?.();
      return;
    }

    // Cmd+T - new terminal
    if (cmdOrCtrl && e.key === 't') {
      e.preventDefault();
      handlersRef.current.onNewTerminal?.();
      return;
    }

    // Cmd+W - close current terminal
    if (cmdOrCtrl && e.key === 'w') {
      e.preventDefault();
      handlersRef.current.onCloseTerminal?.();
      return;
    }

    // Cmd+1-8 - focus pane
    if (cmdOrCtrl && e.key >= '1' && e.key <= '8') {
      const paneIndex = parseInt(e.key, 10) - 1;
      if (paneIndex < paneCount) {
        e.preventDefault();
        handlersRef.current.onFocusPane?.(paneIndex);
      }
      return;
    }
  }, [isFullScreen, paneCount]);

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown, enabled]);
}
