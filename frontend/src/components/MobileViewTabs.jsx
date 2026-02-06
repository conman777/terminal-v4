export function MobileViewTabs({ mobileView, onViewChange, previewUrl }) {
  // Only show view tabs when there's a preview URL
  if (!previewUrl) {
    return null;
  }

  return (
    <div className="mobile-view-tabs">
      <button
        type="button"
        className={`mobile-view-tab${mobileView === 'terminal' ? ' active' : ''}`}
        onClick={() => onViewChange?.('terminal')}
      >
        Terminal
      </button>
      <button
        type="button"
        className={`mobile-view-tab${mobileView === 'preview' ? ' active' : ''}`}
        onClick={() => onViewChange?.('preview')}
      >
        Preview
      </button>
    </div>
  );
}
