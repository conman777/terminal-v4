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
      className={`es-item ${isActive ? 'active' : ''}`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={path}
    >
      <span className="es-item-icon">
        {branch ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </span>

      <span className="es-item-name">{name}</span>

      {branch && (
        <span className="es-item-branch">{branch}</span>
      )}

      {showPinAction && (isHovered || isPinned) && (
        <div className="es-item-actions" onClick={e => e.stopPropagation()}>
          <button
            className={`es-item-pin ${isPinned ? 'pinned' : ''}`}
            onClick={handlePinClick}
            title={isPinned ? 'Unpin' : 'Pin'}
            type="button"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
            </svg>
          </button>
        </div>
      )}

      <style jsx>{`
        .es-item {
          height: 28px;
          display: flex;
          align-items: center;
          padding: 0 10px 0 26px;
          cursor: pointer;
          user-select: none;
          transition: all 0.12s ease;
          color: var(--text-secondary, #a1a1aa);
          position: relative;
          gap: 8px;
        }

        .es-item:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .es-item.active {
          background: var(--accent-primary-dim);
          color: var(--accent-primary, #f59e0b);
        }

        .es-item.active::before {
          content: '';
          position: absolute;
          left: 0;
          top: 4px;
          bottom: 4px;
          width: 2px;
          background: var(--accent-primary, #f59e0b);
          border-radius: 0 1px 1px 0;
        }

        .es-item-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.5;
          flex-shrink: 0;
        }

        .es-item.active .es-item-icon {
          opacity: 0.9;
        }

        .es-item:hover .es-item-icon {
          opacity: 0.7;
        }

        .es-item-name {
          font-size: 12.5px;
          font-weight: 500;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }

        .es-item-branch {
          font-size: 10px;
          font-weight: 500;
          background: var(--bg-elevated, #27272a);
          padding: 1px 5px;
          border-radius: 3px;
          color: var(--text-muted, #71717a);
          max-width: 72px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .es-item.active .es-item-branch {
          background: rgba(245, 158, 11, 0.15);
          color: var(--accent-primary, #f59e0b);
        }

        .es-item-actions {
          display: flex;
          align-items: center;
          opacity: 0;
          transition: opacity 0.12s ease;
        }

        .es-item:hover .es-item-actions {
          opacity: 1;
        }

        .es-item-pin {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 3px;
          cursor: pointer;
          transition: all 0.12s ease;
        }

        .es-item-pin:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .es-item-pin.pinned {
          color: var(--accent-primary, #f59e0b);
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
