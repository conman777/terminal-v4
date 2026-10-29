import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useViewportMetrics } from '../hooks/useViewportHeight';
import './MobileModelSettings.css';
import './ModelSettingsPopover.css';

function ModelSettingsDialog({ providerLabel, mark, dialogLabel, pending, error, children, onClose, triggerRef }) {
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const viewport = useViewportMetrics();
  const [anchor, setAnchor] = useState(null);

  useLayoutEffect(() => {
    const measure = () => { const rect = triggerRef.current?.getBoundingClientRect(); if (rect) setAnchor(previous => previous?.top === rect.top && previous?.left === rect.left ? previous : { top: rect.top, left: rect.left }); };
    measure();
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    for (const target of [triggerRef.current?.closest('.layout'), triggerRef.current?.closest('.mobile-shell')]) {
      if (target) observer?.observe(target);
    }
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [viewport.height, viewport.width, viewport.offsetTop, viewport.offsetLeft, triggerRef]);

  useEffect(() => {
    const background = [...new Set([document.getElementById('root'), triggerRef.current?.closest('[role=dialog]')])].filter(Boolean);
    const previousInert = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      background.forEach((element, index) => { element.inert = previousInert[index]; });
    };
  }, []);

  const handleKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab') {
      const controls = [...panelRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  useEffect(() => {
    const handleUnfocusedKey = event => {
      if (!panelRef.current?.contains(event.target)) handleKeyDown(event);
    };
    document.addEventListener('keydown', handleUnfocusedKey);
    return () => document.removeEventListener('keydown', handleUnfocusedKey);
  }, [onClose]);

  const bottom = Math.max(12, viewport.height - ((anchor?.top ?? viewport.height) - viewport.offsetTop) + 8);

  return createPortal(
    <div className="mobile-model-backdrop model-settings-backdrop" style={{ top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height, paddingBottom: Math.min(bottom, Math.max(12, viewport.height - 220)), paddingLeft: Math.max(12, Math.min((anchor?.left || 0) - viewport.offsetLeft, viewport.width - Math.min(360, viewport.width - 24) - 12)) }}
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onKeyDown={handleKeyDown}>
      <section ref={panelRef} className="mobile-model-dialog model-settings-dialog" role="dialog" aria-modal="true" aria-label={dialogLabel} aria-busy={pending || undefined}>
        <header>
          <div className="mobile-model-dialog-heading"><span className="mobile-model-mark" aria-hidden="true">{mark}</span><h2>{providerLabel}</h2><span>Models</span></div>
          <button ref={closeRef} type="button" aria-label="Close model settings" onClick={onClose}>×</button>
        </header>
        <div className="mobile-model-dialog-body">
          {children}
          {error && <p role="alert" className="mobile-model-dialog-error">{error}</p>}
          {pending && <p role="status">Updating selection…</p>}
        </div>
      </section>
    </div>, document.body,
  );
}

export function ModelSettingsPopover({ value, modelLabel, providerLabel = 'Codex', mark = 'C', label = 'Model settings', dialogLabel = 'Conversation model settings', disabled = false, pending, error, className = '', triggerClassName = '', triggerTitle = 'Model, reasoning and speed', children }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const wasOpenRef = useRef(false);
  const close = () => {
    setOpen(false);
  };
  useEffect(() => {
    if (!open && wasOpenRef.current) triggerRef.current?.focus({ preventScroll: true });
    wasOpenRef.current = open;
  }, [open]);
  return (
    <div className={`agent-model-control model-settings-popover ${className}`}>
      <button ref={triggerRef} className={`model-settings-trigger ${triggerClassName}`} type="button" aria-label={label} disabled={disabled} title={triggerTitle}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="mobile-model-mark" aria-hidden="true">{mark}</span>
        <span>{modelLabel || value?.model || providerLabel}{value?.reasoning ? ` · ${value.reasoning === 'xhigh' ? 'Extra high' : value.reasoning.charAt(0).toUpperCase() + value.reasoning.slice(1)}` : ''}{value?.serviceTier === 'fast' ? ' · Fast' : ''}</span>
        <svg className="model-settings-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && <ModelSettingsDialog providerLabel={providerLabel} mark={mark} dialogLabel={dialogLabel} pending={pending} error={error} onClose={close} triggerRef={triggerRef}>{children}</ModelSettingsDialog>}
    </div>
  );
}
