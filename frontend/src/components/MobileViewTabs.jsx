export function MobileViewTabs({ mobileView, onViewChange, previewUrl }) {
  // Only show view tabs when there's a preview URL
  if (!previewUrl) {
    return null;
  }

  return (
    <div className="mobile-view-tabs">
      <button
        type="button"
        className={`view-tab${mobileView === 'terminal' ? ' active' : ''}`}
        onClick={() => onViewChange?.('terminal')}
      >
        Terminal
      </button>
      <button
        type="button"
        className={`view-tab${mobileView === 'preview' ? ' active' : ''}`}
        onClick={() => onViewChange?.('preview')}
      >
        Preview
      </button>

      <style jsx>{`
        .mobile-view-tabs {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 4px;
        }

        .view-tab {
          flex: 1;
          height: 38px;
          min-height: 38px;
          padding: 0 16px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          border-radius: 18px;
          color: var(--text-secondary, #a1a1aa);
          font-size: 14px;
          font-weight: 600;
          white-space: nowrap;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
        }

        .view-tab:active {
          transform: scale(0.98);
        }

        .view-tab.active {
          background: var(--accent-primary-dim);
          border-color: var(--accent-primary, #f59e0b);
          color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 10px var(--accent-primary-dim);
        }
      `}</style>
    </div>
  );
}
