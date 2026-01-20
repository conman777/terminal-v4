import { BrowserSettings } from './settings/BrowserSettings';

/**
 * BrowserSettingsModal - Modal wrapper for browser settings
 */
export function BrowserSettingsModal({ isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Browser Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          <BrowserSettings />
        </div>
      </div>
    </div>
  );
}

export default BrowserSettingsModal;
