import './MobileUI.css';

export function MobileViewTabs({ mobileView, onViewChange, previewUrl }) {
  // Only show view tabs when there's a preview URL
  if (!previewUrl) {
    return null;
  }

  return (
    <div className="mobile-view-tabs mobile-ui" role="group" aria-label="Mobile view">
      <button
        type="button"
        className={`mobile-view-tab${mobileView === 'terminal' ? ' active' : ''}`}
        aria-pressed={mobileView === 'terminal'}
        onClick={() => onViewChange?.('terminal')}
      >
        Terminal
      </button>
      <button
        type="button"
        className={`mobile-view-tab${mobileView === 'preview' ? ' active' : ''}`}
        aria-pressed={mobileView === 'preview'}
        onClick={() => onViewChange?.('preview')}
      >
        Preview
      </button>
    </div>
  );
}
