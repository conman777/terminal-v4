import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function ImageLightbox({ src, alt, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const handleKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return createPortal(
    <div className="md-lightbox" onKeyDown={handleKeyDown} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="md-lightbox-panel" role="dialog" aria-modal="true" aria-label={alt ? `Image: ${alt}` : 'Image preview'} ref={dialog}>
        <div className="md-lightbox-bar">
          <a href={src} target="_blank" rel="noopener noreferrer">Open original</a>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <img src={src} alt={alt} decoding="async" referrerPolicy="no-referrer" />
        {alt && <p>{alt}</p>}
      </div>
    </div>,
    document.body
  );
}
