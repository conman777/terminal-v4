import { useEffect, useRef } from 'react';

/**
 * Reusable right-click context menu component.
 */
export function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);

  // Close on outside click or escape
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const inset = 8;

      const minX = viewportLeft + inset;
      const minY = viewportTop + inset;
      const maxX = viewportLeft + viewportWidth - rect.width - inset;
      const maxY = viewportTop + viewportHeight - rect.height - inset;

      const adjustedX = Math.min(Math.max(x, minX), Math.max(minX, maxX));
      const adjustedY = Math.min(Math.max(y, minY), Math.max(minY, maxY));

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={index} className="context-menu-separator" />;
        }

        return (
          <button
            key={index}
            type="button"
            className={`context-menu-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            disabled={item.disabled}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && (
              <span className="context-menu-shortcut">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
