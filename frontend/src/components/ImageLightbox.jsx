import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function ImageLightbox({ items, initialIndex, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const { src, alt } = items[index];
  const navigate = delta => { setIndex(value => Math.max(0, Math.min(items.length - 1, value + delta))); setZoom(1); };
  const dialog = useRef(null);
  const swipeStart = useRef(null);
  const onTouchStart = event => { swipeStart.current = event.touches.length === 1 && zoom === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; };
  const onTouchEnd = event => {
    const start = swipeStart.current;
    swipeStart.current = null;
    const end = event.changedTouches[0];
    if (!start || !end) return;
    const dx = end.clientX - start.x;
    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(end.clientY - start.y) * 1.5) navigate(dx < 0 ? 1 : -1);
  };
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  const handleKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !(zoom > 1 && event.target.classList.contains('md-lightbox-viewport'))) { event.preventDefault(); event.stopPropagation(); navigate(event.key === 'ArrowLeft' ? -1 : 1); return; }
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
        <div className="md-lightbox-controls">
          {items.length > 1 && <><button type="button" onClick={() => navigate(-1)} aria-disabled={index === 0}>Previous image</button><span aria-live="polite">{index + 1} of {items.length}</span><button type="button" onClick={() => navigate(1)} aria-disabled={index === items.length - 1}>Next image</button></>}
          <button type="button" onClick={() => setZoom(value => Math.max(1, value - 0.5))} aria-disabled={zoom === 1}>Zoom out</button>
          <span aria-live="polite">{zoom * 100}%</span>
          <button type="button" onClick={() => setZoom(value => Math.min(3, value + 0.5))} aria-disabled={zoom === 3}>Zoom in</button>
        </div>
        <div className="md-lightbox-viewport" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={() => { swipeStart.current = null; }} tabIndex={zoom > 1 ? 0 : undefined} aria-label={zoom > 1 ? 'Zoomed image, scroll to pan' : undefined}>
          <img src={src} alt={alt} decoding="async" referrerPolicy="no-referrer" style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: 'none', maxHeight: 'none' } : undefined} />
        </div>
        {alt && <p>{alt}</p>}
      </div>
    </div>,
    document.body
  );
}
