import { useState, useRef, useEffect } from 'react';

export function Dropdown({ 
  trigger, 
  items, 
  align = 'right', 
  className = '',
  closeOnSelect = true 
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('pointerdown', handleClickOutside);
    }
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isOpen]);

  const toggleDropdown = () => setIsOpen(!isOpen);

  return (
    <div className={`dropdown-container ${className}`} ref={dropdownRef}>
      <div className="dropdown-trigger" onClick={toggleDropdown}>
        {trigger}
      </div>
      
      {isOpen && (
        <div className={`dropdown-menu align-${align}`}>
          {items.map((item, index) => {
            if (item.separator) {
              return <div key={`sep-${index}`} className="dropdown-separator" />;
            }
            
            return (
              <button
                key={index}
                className={`dropdown-item ${item.className || ''} ${item.danger ? 'danger' : ''} ${item.active ? 'active' : ''}`}
                onClick={(e) => {
                  item.onClick(e);
                  if (closeOnSelect) setIsOpen(false);
                }}
                disabled={item.disabled}
                title={item.title}
                type="button"
              >
                {item.icon && <span className="dropdown-item-icon">{item.icon}</span>}
                <span className="dropdown-item-label">{item.label}</span>
                {item.badge && <span className="dropdown-item-badge">{item.badge}</span>}
              </button>
            );
          })}
        </div>
      )}

      <style jsx>{`
        .dropdown-container {
          position: relative;
          display: inline-block;
        }

        .dropdown-trigger {
          cursor: pointer;
          display: flex;
          align-items: center;
        }

        .dropdown-menu {
          position: absolute;
          top: calc(100% + 8px);
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          border-radius: 8px;
          min-width: 180px;
          box-shadow: var(--shadow-lg);
          z-index: 2000;
          max-height: min(60vh, 340px);
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 6px;
          animation: dropdownFadeIn 0.2s ease-out;
        }

        @keyframes dropdownFadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .dropdown-menu.align-right {
          right: 0;
        }

        .dropdown-menu.align-left {
          left: 0;
        }

        .dropdown-item {
          width: 100%;
          display: flex;
          align-items: center;
          padding: 8px 12px;
          border: none;
          background: transparent;
          color: var(--text-primary, #fafafa);
          font-size: 13px;
          text-align: left;
          cursor: pointer;
          border-radius: 4px;
          transition: background 0.15s ease;
          gap: 10px;
        }

        .dropdown-item:hover:not(:disabled) {
          background: var(--bg-elevated, #1e1e21);
        }

        .dropdown-item.active {
          color: var(--accent-primary, #f59e0b);
          background: var(--accent-primary-dim);
        }

        .dropdown-item.danger {
          color: var(--error, #f43f5e);
        }

        .dropdown-item.danger:hover:not(:disabled) {
          background: rgba(244, 63, 94, 0.1);
        }

        .dropdown-item:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .dropdown-item-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.8;
        }

        .dropdown-item-label {
          flex: 1;
        }

        .dropdown-item-badge {
          font-size: 10px;
          background: var(--bg-elevated, #1e1e21);
          padding: 2px 6px;
          border-radius: 10px;
          color: var(--text-muted, #71717a);
        }

        .dropdown-separator {
          height: 1px;
          background: var(--border-subtle, #1e1e21);
          margin: 6px 0;
        }

        @media (max-width: 768px) {
          .dropdown-item {
            min-height: 44px;
            padding: 10px 12px;
          }
        }
      `}</style>
    </div>
  );
}
