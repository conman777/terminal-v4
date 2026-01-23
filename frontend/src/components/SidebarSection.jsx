import { useState, useMemo, useRef, useEffect } from 'react';
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
  defaultExpanded = true,
  showSearch = false,
  onAddFolder = null
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [searchQuery, setSearchQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const debounceTimerRef = useRef(null);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

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

  // Filter items based on search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase();
    return items.filter((item) => {
      const name = typeof item === 'string' ? getFolderName(item) : item.name;
      const path = typeof item === 'string' ? item : item.path;
      const branch = typeof item === 'string' ? '' : (item.branch || '');
      return (
        name.toLowerCase().includes(query) ||
        path.toLowerCase().includes(query) ||
        branch.toLowerCase().includes(query)
      );
    });
  }, [items, searchQuery]);

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
    <div className="sidebar-section-modern">
      <div
        className={`sidebar-section-header-modern ${isExpanded ? 'expanded' : ''}`}
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsExpanded(!isExpanded);
          }
        }}
      >
        <span className={`sidebar-section-chevron-modern ${isExpanded ? 'expanded' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="sidebar-section-icon-modern">{renderIcon()}</span>
        <span className="sidebar-section-title-modern">{title}</span>
        {loading && <span className="sidebar-section-loader-modern" />}
        {onAddFolder && (
          <button
            type="button"
            className="sidebar-section-add-modern"
            onClick={(e) => {
              e.stopPropagation();
              onAddFolder();
            }}
            title="Add folder to scan"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="sidebar-section-content-modern">
          {showSearch && items.length > 0 && (
            <div className="sidebar-search-modern">
              <svg className="sidebar-search-icon-modern" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="sidebar-search-input-modern"
                placeholder="Search..."
                value={inputValue}
                onChange={(e) => {
                  const value = e.target.value;
                  setInputValue(value);
                  // Debounce actual search by 250ms
                  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                  debounceTimerRef.current = setTimeout(() => {
                    setSearchQuery(value);
                  }, 250);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              {inputValue && (
                <button
                  className="sidebar-search-clear-modern"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInputValue('');
                    setSearchQuery('');
                    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                  }}
                  type="button"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
          )}
          {loading && items.length === 0 ? (
            <div className="sidebar-empty-modern">Scanning...</div>
          ) : items.length === 0 ? (
            <div className="sidebar-empty-modern">No items</div>
          ) : filteredItems.length === 0 ? (
            <div className="sidebar-empty-modern">No matches for "{searchQuery}"</div>
          ) : (
            <div className="sidebar-items-list-modern">
              {filteredItems.map((item, index) => {
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
              })}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .sidebar-section-modern {
          margin-bottom: 4px;
        }

        .sidebar-section-header-modern {
          height: 32px;
          display: flex;
          align-items: center;
          padding: 0 8px;
          cursor: pointer;
          user-select: none;
          transition: background 0.15s ease;
          border-radius: 4px;
          margin: 2px 6px;
          color: var(--text-secondary, #a1a1aa);
        }

        .sidebar-section-header-modern:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .sidebar-section-chevron-modern {
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          margin-right: 4px;
          opacity: 0.5;
        }

        .sidebar-section-chevron-modern.expanded {
          transform: rotate(90deg);
        }

        .sidebar-section-icon-modern {
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 8px;
          opacity: 0.8;
          color: var(--accent-primary, #f59e0b);
        }

        .sidebar-section-title-modern {
          font-size: 12px;
          font-weight: 600;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sidebar-section-add-modern {
          width: 20px;
          height: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 4px;
          cursor: pointer;
          opacity: 0;
          transition: all 0.15s ease;
        }

        .sidebar-section-header-modern:hover .sidebar-section-add-modern {
          opacity: 1;
        }

        .sidebar-section-add-modern:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        .sidebar-section-content-modern {
          padding-bottom: 8px;
        }

        .sidebar-search-modern {
          position: relative;
          margin: 4px 10px 8px;
        }

        .sidebar-search-icon-modern {
          position: absolute;
          left: 8px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted, #71717a);
          pointer-events: none;
        }

        .sidebar-search-input-modern {
          width: 100%;
          height: 28px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          border-radius: 4px;
          padding: 0 28px 0 28px;
          color: var(--text-primary, #fafafa);
          font-size: 12px;
          outline: none;
          transition: border-color 0.2s ease;
        }

        .sidebar-search-input-modern:focus {
          border-color: var(--accent-primary, #f59e0b);
        }

        .sidebar-search-clear-modern {
          position: absolute;
          right: 8px;
          top: 50%;
          transform: translateY(-50%);
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          cursor: pointer;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .sidebar-empty-modern {
          padding: 8px 24px;
          font-size: 11px;
          color: var(--text-muted, #71717a);
          font-style: italic;
        }

        .sidebar-items-list-modern {
          display: flex;
          flex-direction: column;
        }

        .sidebar-section-loader-modern {
          width: 12px;
          height: 12px;
          border: 1.5px solid var(--accent-primary-dim);
          border-top-color: var(--accent-primary);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-right: 8px;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
