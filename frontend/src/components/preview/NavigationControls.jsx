import { useEffect } from 'react';

export function NavigationControls({
  onBack,
  onForward,
  onReload,
  canGoBack = false,
  canGoForward = false,
  isLoading = false
}) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Cmd+[ (Mac) or Ctrl+[ (Windows/Linux) for back
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        if (canGoBack) {
          onBack();
        }
      }
      // Cmd+] (Mac) or Ctrl+] (Windows/Linux) for forward
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        if (canGoForward) {
          onForward();
        }
      }
      // Cmd+R (Mac) or Ctrl+R (Windows/Linux) for reload
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        onReload();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack, onForward, onReload, canGoBack, canGoForward]);

  return (
    <div className="navigation-controls" style={{ display: 'flex', gap: '4px' }}>
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="preview-nav-btn"
        title="Go back (⌘[)"
        aria-label="Go back"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        className="preview-nav-btn"
        title="Go forward (⌘])"
        aria-label="Go forward"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      <button
        onClick={onReload}
        disabled={isLoading}
        className="preview-nav-btn"
        title="Reload (⌘R)"
        aria-label="Reload"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={isLoading ? 'rotating' : ''}
        >
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </button>
    </div>
  );
}
