import { cloneElement, isValidElement, useState, useRef, useEffect } from 'react';

export function Dropdown({
  trigger,
  items,
  align = 'right',
  direction = 'down',
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

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger, {
        onClick: (event) => {
          trigger.props.onClick?.(event);
          toggleDropdown();
        },
        'aria-expanded': isOpen ? 'true' : 'false'
      })
    : trigger;

  return (
    <div className={`dropdown-container ${className}`} ref={dropdownRef}>
      {isValidElement(triggerElement) ? (
        triggerElement
      ) : (
        <div className="dropdown-trigger" onClick={toggleDropdown}>
          {triggerElement}
        </div>
      )}
      
      {isOpen && (
        <div className={`dropdown-menu align-${align} dir-${direction}`}>
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

      <style>{`
        .dropdown-container {
          position: relative;
          display: inline-block;
        }

        .dropdown-trigger {
          cursor: pointer;
          display: flex;
          align-items: center;
        }

        .dropdown-menu.dir-up {
          top: auto;
          bottom: calc(100% + 4px);
        }

        .dropdown-menu {
          position: absolute;
          top: calc(100% + 4px);
          background: var(--bg-surface, #1c1814);
          border: 1px solid var(--border-subtle, #2a241c);
          border-radius: var(--radius-md, 10px);
          min-width: 170px;
          z-index: 2000;
          max-height: min(60vh, 340px);
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 4px;
          font-family: var(--font-ui);
          box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.5));
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
          padding: 5px 10px;
          border: none;
          background: transparent;
          color: var(--text-secondary, #d5cab4);
          font-family: inherit;
          font-size: 11px;
          text-align: left;
          cursor: pointer;
          transition: color 0.1s ease, background 0.1s ease;
          gap: 8px;
          border-radius: var(--radius-sm, 6px);
        }

        .dropdown-item:hover:not(:disabled) {
          background: var(--bg-hover, #2f2920);
          color: var(--text-primary, #f4eee3);
        }

        .dropdown-item.active {
          color: var(--accent-primary-light, #fbbf24);
          background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
        }

        .dropdown-item.danger {
          color: var(--error, #fb3654);
        }

        .dropdown-item.danger:hover:not(:disabled) {
          background: rgba(251, 54, 84, 0.1);
        }

        .dropdown-item:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }

        .dropdown-item-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.5;
        }

        .dropdown-item-label {
          flex: 1;
        }

        .dropdown-item-badge {
          font-family: inherit;
          font-size: 10px;
          color: var(--text-muted, #8c8172);
        }

        .dropdown-separator {
          height: 1px;
          background: var(--border-subtle, #2a241c);
          margin: 4px 0;
        }

        @media (max-width: 768px) {
          .dropdown-item {
            min-height: 40px;
            padding: 8px 10px;
          }
        }
      `}</style>
    </div>
  );
}
