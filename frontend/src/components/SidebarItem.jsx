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
      className={`sidebar-item ${isActive ? 'active' : ''}`}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={path}
    >
      <span className="sidebar-item-icon">
        {branch ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
        )}
      </span>

      <span className="sidebar-item-name">{name}</span>

      {branch && (
        <span className="project-badge">{branch}</span>
      )}

      {showPinAction && (isHovered || isPinned) && (
        <div className="sidebar-item-actions">
          <button
            className={`sidebar-pin-btn ${isPinned ? 'pinned' : ''}`}
            onClick={handlePinClick}
            title={isPinned ? 'Unpin folder' : 'Pin folder'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
