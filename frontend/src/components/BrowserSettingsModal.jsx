import './UtilityDialogs.css';
import { BrowserSettings } from './settings/BrowserSettings';
import { useLayoutEffect, useRef, useId } from 'react';

/**
 * BrowserSettingsModal - Modal wrapper for browser settings
 */
export function BrowserSettingsModal({ isOpen, onClose }) {
  const dialog = useRef(null);
  const close = useRef(null);
  const titleId = useId();
  useLayoutEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement;
    close.current.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [isOpen]);
  function keyDown(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const fields = [...dialog.current.querySelectorAll('button, input, textarea, summary')].filter(element => {
      if (element.matches(':disabled')) return false;
      const details = element.closest('details:not([open])');
      return !details || element === details.querySelector('summary');
    });
    const first = fields[0], last = fields.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={dialog} className="modal-content modal-content-wide ui-utility-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={keyDown} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id={titleId}>Browser Settings</h2>
          <button ref={close} className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <BrowserSettings />
        </div>
      </div>
    </div>
  );
}

export default BrowserSettingsModal;
