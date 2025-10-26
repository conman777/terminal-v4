import { useEffect } from 'react';

export function MobileDrawer({ isOpen, onClose, onCreateSession, onOpenSettings }) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  return (
    <>
      <div className={`mobile-drawer-overlay${isOpen ? ' open' : ''}`} onClick={onClose}></div>
      <div className={`mobile-drawer${isOpen ? ' open' : ''}`}>
        <div className="mobile-drawer-header">
          <h2>Menu</h2>
          <button className="mobile-drawer-close" onClick={onClose} aria-label="Close menu">
            ×
          </button>
        </div>
        <div className="mobile-drawer-content">
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onCreateSession();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">+</span>
            New Session
          </button>
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">⚙</span>
            Settings
          </button>
        </div>
      </div>
    </>
  );
}
