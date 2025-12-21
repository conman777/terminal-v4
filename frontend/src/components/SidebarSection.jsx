import { useState } from 'react';
import SidebarItem from './SidebarItem';

export default function SidebarSection({
  title,
  icon,
  items,
  onSelect,
  onPin,
  onUnpin,
  pinnedFolders = [],
  currentPath,
  loading = false,
  showPinAction = true,
  defaultExpanded = true
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Normalize path for comparison
  const normalizePath = (p) => p?.toLowerCase().replace(/\/$/, '');
  const currentNormalized = normalizePath(currentPath);

  // Extract folder name from path
  const getFolderName = (path) => {
    if (!path) return '';
    const segments = path.replace(/\/$/, '').split(/[/\\]/);
    return segments[segments.length - 1] || path;
  };

  // Check if a path is pinned
  const isPinned = (path) => {
    return pinnedFolders.some(p => normalizePath(p) === normalizePath(path));
  };

  // Render icon based on type
  const renderIcon = () => {
    switch (icon) {
      case 'pin':
        return (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
          </svg>
        );
      case 'clock':
        return (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
          </svg>
        );
      case 'folder-git':
        return (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
          </svg>
        );
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
        );
    }
  };

  return (
    <div className="sidebar-section">
      <button
        className="sidebar-section-header"
        onClick={() => setIsExpanded(!isExpanded)}
        type="button"
      >
        <span className={`sidebar-section-chevron ${isExpanded ? 'expanded' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </span>
        <span className="sidebar-section-icon">{renderIcon()}</span>
        <span className="sidebar-section-title">{title}</span>
        {loading && <span className="sidebar-section-loader" />}
      </button>

      {isExpanded && (
        <div className="sidebar-section-content">
          {loading && items.length === 0 ? (
            <div className="sidebar-empty">Scanning...</div>
          ) : items.length === 0 ? (
            <div className="sidebar-empty">No items</div>
          ) : (
            items.map((item, index) => {
              // Handle both string paths and Project objects
              const path = typeof item === 'string' ? item : item.path;
              const name = typeof item === 'string' ? getFolderName(item) : item.name;
              const branch = typeof item === 'string' ? undefined : item.branch;

              return (
                <SidebarItem
                  key={path || index}
                  path={path}
                  name={name}
                  branch={branch}
                  isActive={normalizePath(path) === currentNormalized}
                  isPinned={isPinned(path)}
                  onSelect={onSelect}
                  onPin={onPin}
                  onUnpin={onUnpin}
                  showPinAction={showPinAction}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
