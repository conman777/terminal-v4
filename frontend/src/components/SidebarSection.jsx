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
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z" />
          </svg>
        );
      case 'clock':
        return (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z" />
          </svg>
        );
      case 'folder-git':
        return (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
          </svg>
        );
      default:
        return (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
          </svg>
        );
    }
  };

  const itemCount = items.length;

  return (
    <div className="es-section">
      <div
        className={`es-section-header ${isExpanded ? 'expanded' : ''}`}
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
        <span className={`es-section-chevron ${isExpanded ? 'expanded' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="es-section-icon">{renderIcon()}</span>
        <span className="es-section-title">{title}</span>
        {itemCount > 0 && (
          <span className="es-section-count">{itemCount}</span>
        )}
        {loading && <span className="es-section-loader" />}
        {onAddFolder && (
          <button
            type="button"
            className="es-section-add"
            onClick={(e) => {
              e.stopPropagation();
              onAddFolder();
            }}
            title="Add folder to scan"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
      </div>

      {isExpanded && (
        <div className="es-section-body">
          {showSearch && items.length > 3 && (
            <div className="es-search">
              <svg className="es-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="es-search-input"
                placeholder="Filter projects..."
                value={inputValue}
                onChange={(e) => {
                  const value = e.target.value;
                  setInputValue(value);
                  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                  debounceTimerRef.current = setTimeout(() => {
                    setSearchQuery(value);
                  }, 200);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              {inputValue && (
                <button
                  className="es-search-clear"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInputValue('');
                    setSearchQuery('');
                    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                  }}
                  type="button"
                  aria-label="Clear search"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {loading && items.length === 0 ? (
            <div className="es-empty">
              <span className="es-empty-loader" />
              <span>Scanning folders...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="es-empty">No items</div>
          ) : filteredItems.length === 0 ? (
            <div className="es-empty">No matches for "{searchQuery}"</div>
          ) : (
            <div className="es-items">
              {filteredItems.map((item, index) => {
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
        .es-section {
          margin-bottom: 2px;
        }

        .es-section-header {
          height: 28px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          cursor: pointer;
          user-select: none;
          transition: background 0.12s ease;
          margin: 0 6px;
          border-radius: 4px;
          color: var(--text-muted, #71717a);
          gap: 0;
        }

        .es-section-header:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-secondary, #a1a1aa);
        }

        .es-section-chevron {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 16px;
          flex-shrink: 0;
          transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1);
          opacity: 0.5;
        }

        .es-section-chevron.expanded {
          transform: rotate(90deg);
        }

        .es-section-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 6px;
          color: var(--accent-primary, #f59e0b);
          opacity: 0.7;
        }

        .es-section-header:hover .es-section-icon {
          opacity: 0.9;
        }

        .es-section-title {
          font-size: 11px;
          font-weight: 650;
          flex: 1;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }

        .es-section-count {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-muted, #71717a);
          background: var(--bg-surface, #18181b);
          padding: 0 5px;
          height: 16px;
          line-height: 16px;
          border-radius: 8px;
          margin-right: 2px;
          opacity: 0.7;
        }

        .es-section-add {
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
          transition: all 0.12s ease;
        }

        .es-section-header:hover .es-section-add {
          opacity: 0.7;
        }

        .es-section-add:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
          opacity: 1;
        }

        .es-section-body {
          padding-bottom: 4px;
        }

        /* ── Search ── */
        .es-search {
          position: relative;
          margin: 4px 12px 6px;
        }

        .es-search-icon {
          position: absolute;
          left: 8px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted, #71717a);
          pointer-events: none;
          opacity: 0.6;
        }

        .es-search-input {
          width: 100%;
          height: 26px;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-subtle, #27272a);
          border-radius: 5px;
          padding: 0 26px 0 26px;
          color: var(--text-primary, #fafafa);
          font-size: 11px;
          outline: none;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }

        .es-search-input::placeholder {
          color: var(--text-muted, #71717a);
          opacity: 0.6;
        }

        .es-search-input:focus {
          border-color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.15);
        }

        .es-search-clear {
          position: absolute;
          right: 4px;
          top: 50%;
          transform: translateY(-50%);
          width: 18px;
          height: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          cursor: pointer;
          border-radius: 3px;
          transition: all 0.12s ease;
        }

        .es-search-clear:hover {
          background: var(--bg-elevated, #27272a);
          color: var(--text-primary, #fafafa);
        }

        /* ── Empty state ── */
        .es-empty {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 28px;
          font-size: 11px;
          color: var(--text-muted, #71717a);
          opacity: 0.7;
        }

        .es-items {
          display: flex;
          flex-direction: column;
        }

        /* ── Loader ── */
        .es-section-loader {
          width: 10px;
          height: 10px;
          border: 1.5px solid var(--border-subtle, #27272a);
          border-top-color: var(--accent-primary, #f59e0b);
          border-radius: 50%;
          animation: es-spin 0.7s linear infinite;
          margin-right: 4px;
          flex-shrink: 0;
        }

        .es-empty-loader {
          width: 12px;
          height: 12px;
          border: 1.5px solid var(--border-subtle, #27272a);
          border-top-color: var(--accent-primary, #f59e0b);
          border-radius: 50%;
          animation: es-spin 0.7s linear infinite;
          flex-shrink: 0;
        }

        @keyframes es-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
