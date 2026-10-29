import { useEffect, useRef, useState } from 'react';
import './WorkspacePanel.css';

export function WorkspacePanel({ kind, collapsed = false, expanded = false, forceSheet = false, covered = false, reserveSpace, onClose, onResize, children }) {
  const tools = kind === 'tools';
  const storageKey = `terminal-workspace-${kind}-width`;
  const defaultWidth = tools ? 540 : 256;
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return Number.isFinite(saved) && saved >= 208 ? saved : defaultWidth;
    } catch { return defaultWidth; }
  });
  const [availableWidth, setAvailableWidth] = useState(window.innerWidth);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  const root = useRef(null), drag = useRef(null);
  const sheet = tools && (forceSheet || narrow);
  const minimum = tools ? 360 : 208;
  const maximum = Math.max(minimum, Math.min(Math.floor(availableWidth * .7), availableWidth - (reserveSpace ?? (tools ? 360 : 640))));
  const width = Math.min(maximum, Math.max(minimum, preferredWidth));

  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const measure = () => {
      setAvailableWidth(root.current?.parentElement?.getBoundingClientRect().width || window.innerWidth);
      setNarrow(query.matches);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (root.current?.parentElement) observer?.observe(root.current.parentElement);
    query.addEventListener?.('change', measure);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); query.removeEventListener?.('change', measure); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(storageKey, String(preferredWidth)); } catch { /* Layout remains usable without preference storage. */ }
  }, [preferredWidth, storageKey]);
  useEffect(() => { onResize?.(); }, [width, expanded, collapsed, sheet, onResize]);

  useEffect(() => {
    const move = event => {
      if (!drag.current) return;
      event.preventDefault();
      const delta = (event.clientX - drag.current.x) * (tools ? -1 : 1);
      setPreferredWidth(Math.min(maximum, Math.max(minimum, drag.current.width + delta)));
    };
    const end = () => { drag.current = null; };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    return () => { end(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end); };
  }, [maximum, minimum, tools]);

  useEffect(() => {
    if (!sheet || covered || !root.current) return;
    const previous = [];
    for (let branch = root.current; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || sibling.classList.contains('workspace-panel-backdrop') || !(sibling instanceof HTMLElement)) continue;
        previous.push([sibling, sibling.hasAttribute('inert')]);
        sibling.setAttribute('inert', '');
      }
      if (branch.parentElement === document.body) break;
    }
    const focus = () => {
      if (root.current && (!root.current.contains(document.activeElement) || document.activeElement === root.current)) {
        const control = [...root.current.querySelectorAll('button:not(:disabled), input:not(:disabled), summary')].find(element => element.getClientRects().length);
        (control || root.current).focus();
      }
    };
    focus();
    const observer = new MutationObserver(focus);
    observer.observe(root.current, { childList: true, subtree: true });
    return () => { observer.disconnect(); for (const [element, wasInert] of previous) if (!wasInert) element.removeAttribute('inert'); };
  }, [sheet, covered]);

  function key(event) {
    if (!sheet || covered) return;
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose?.(); }
    if (event.key !== 'Tab') return;
    const elements = [...root.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')]
      .filter(element => element.getClientRects().length && !element.closest('[inert]'));
    const first = elements[0], last = elements.at(-1);
    if (!first) { event.preventDefault(); root.current.focus(); }
    else if (document.activeElement === root.current) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  return <>
    {sheet && !covered && <button className="workspace-panel-backdrop" type="button" tabIndex={-1} aria-label="Close browser backdrop" onClick={onClose} />}
    <div ref={root} className={`workspace-panel workspace-panel-${kind}${collapsed ? ' collapsed' : ''}${expanded ? ' expanded' : ''}${sheet ? ' sheet' : ''}`}
      style={{ '--workspace-panel-width': `${collapsed ? 48 : width}px` }} role={sheet && !covered ? 'dialog' : undefined} tabIndex={sheet && !covered ? -1 : undefined} aria-modal={sheet && !covered ? true : undefined} aria-label={sheet && !covered ? 'Browser panel' : undefined} onKeyDown={key}>
      {!collapsed && !expanded && !sheet && <div className="workspace-panel-resizer" role="separator" tabIndex={0} aria-label={tools ? 'Resize browser panel' : 'Resize navigation'} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width}
        onPointerDown={event => { event.preventDefault(); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onDoubleClick={() => setPreferredWidth(defaultWidth)}
        onKeyDown={event => {
          const delta = event.key === 'ArrowRight' ? (tools ? -24 : 24) : event.key === 'ArrowLeft' ? (tools ? 24 : -24) : 0;
          if (!delta && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          setPreferredWidth(event.key === 'Home' ? minimum : event.key === 'End' ? maximum : Math.min(maximum, Math.max(minimum, width + delta)));
        }} />}
      <div className="workspace-panel-content">{children}</div>
    </div>
  </>;
}
