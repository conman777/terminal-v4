import { useEffect, useRef } from 'react';
import './ContextMenu.css';

/**
 * Reusable right-click context menu component.
 */
export function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const trigger = document.activeElement;
    const menu = menuRef.current;
    menu?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      if (trigger?.isConnected && (document.activeElement === document.body || menu?.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  const handleNavigation = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const actions = [...menuRef.current.querySelectorAll('button:not(:disabled)')];
    if (!actions.length) return;
    event.preventDefault();
    const current = actions.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + actions.length) % actions.length;
    actions[next].focus();
  };

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
    const viewport = window.visualViewport;
    const positionMenu = () => {
      if (!menuRef.current) return;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const inset = 8;
      menuRef.current.style.maxHeight = `${Math.max(0, viewportHeight - inset * 2)}px`;
      menuRef.current.style.maxWidth = `${Math.max(0, viewportWidth - inset * 2)}px`;
      const rect = menuRef.current.getBoundingClientRect();

      const minX = viewportLeft + inset;
      const minY = viewportTop + inset;
      const maxX = viewportLeft + viewportWidth - rect.width - inset;
      const maxY = viewportTop + viewportHeight - rect.height - inset;

      const adjustedX = Math.min(Math.max(x, minX), Math.max(minX, maxX));
      const adjustedY = Math.min(Math.max(y, minY), Math.max(minY, maxY));

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    viewport?.addEventListener('resize', positionMenu);
    viewport?.addEventListener('scroll', positionMenu);
    return () => {
      window.removeEventListener('resize', positionMenu);
      viewport?.removeEventListener('resize', positionMenu);
      viewport?.removeEventListener('scroll', positionMenu);
    };
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="group"
      aria-label="Context actions"
      onKeyDown={handleNavigation}
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
