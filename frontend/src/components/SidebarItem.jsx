import { useState } from 'react';

export default function SidebarItem({
  path,
  name,
  branch,
  isActive,
  isPinned,
  onSelect,
  onPin,
  onUnpin,
  showPinAction = true
}) {
  const [isHovered, setIsHovered] = useState(false);

  const handleClick = () => {
    onSelect(path);
  };

  const handlePinClick = (e) => {
    e.stopPropagation();
    if (isPinned && onUnpin) {
      onUnpin(path);
    } else if (!isPinned && onPin) {
      onPin(path);
    }
  };

  return (
    <div
      className={`sidebar-item-modern ${isActive ? 'active' : ''}`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={path}
    >
      <span className="sidebar-item-icon-modern">
        {branch ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </span>

      <span className="sidebar-item-name-modern">{name}</span>

      {branch && (
        <span className="sidebar-item-badge-modern">{branch}</span>
      )}

      {showPinAction && (isHovered || isPinned) && (
        <div className="sidebar-item-actions-modern" onClick={e => e.stopPropagation()}>
          <button
            className={`sidebar-item-pin-btn-modern ${isPinned ? 'pinned' : ''}`}
            onClick={handlePinClick}
            title={isPinned ? 'Unpin' : 'Pin'}
            type="button"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" />
              <path d="M16.5 9.4 7 14.9" />
              <polyline points="3.2 6.9 12 12 20.8 6.9" />
              <path d="M12 22V12" />
            </svg>
          </button>
        </div>
      )}

      <style jsx>{`
        .sidebar-item-modern {
          height: 30px;
          display: flex;
          align-items: center;
          padding: 0 12px;
          padding-left: 28px;
          cursor: pointer;
          user-select: none;
          transition: all 0.15s ease;
          color: var(--text-secondary, #a1a1aa);
          position: relative;
          gap: 10px;
        }

        .sidebar-item-modern:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .sidebar-item-modern.active {
          background: var(--accent-primary-dim);
          color: var(--accent-primary, #f59e0b);
        }

        .sidebar-item-modern.active::before {
          content: '';
          position: absolute;
          left: 0;
          top: 4px;
          bottom: 4px;
          width: 3px;
          background: var(--accent-primary, #f59e0b);
          border-radius: 0 2px 2px 0;
          box-shadow: var(--shadow-glow);
        }

        .sidebar-item-icon-modern {
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.6;
          flex-shrink: 0;
        }

        .sidebar-item-modern.active .sidebar-item-icon-modern {
          opacity: 1;
        }

        .sidebar-item-name-modern {
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }

        .sidebar-item-badge-modern {
          font-size: 10px;
          background: var(--bg-elevated, #27272a);
          padding: 1px 6px;
          border-radius: 10px;
          color: var(--text-muted, #71717a);
          max-width: 80px;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sidebar-item-actions-modern {
          display: flex;
          align-items: center;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.15s ease;
        }

        .sidebar-item-modern:hover .sidebar-item-actions-modern {
          opacity: 1;
        }

        .sidebar-item-pin-btn-modern {
          width: 22px;
          height: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .sidebar-item-pin-btn-modern:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .sidebar-item-pin-btn-modern.pinned {
          color: var(--accent-primary, #f59e0b);
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
