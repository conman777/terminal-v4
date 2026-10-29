import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { getPaneIds, getPaneTreeGeometry, paneTreeFromLegacy, resizePaneTree } from '../utils/paneTree';

const MAX_PANES = 8;
const RetainedTerminalPane = memo(TerminalPane);

function ariaPercent(value) {
  return Math.round(value * 1000000) / 1000000;
}

export function SplitPaneContainer({
  layout,
  paneLayout,
  onPaneResize,
  onPaneSessionSelect,
  onPaneSplit,
  onPaneClose,
  onPaneFocus,
  onPaneFullscreen,
  fullscreenPaneId,
  currentDesktopId,
  ...paneProps
}) {
  const legacyRoot = useMemo(() => paneTreeFromLegacy(layout), [layout]);
  const sourceRoot = paneLayout?.root || legacyRoot;
  const [localLayout, setLocalLayout] = useState(null);
  const root = localLayout?.source === sourceRoot && localLayout.desktopId === currentDesktopId ? localLayout.root : sourceRoot;
  const activePaneId = paneLayout?.activePaneId || layout?.activePaneId;
  const paneIds = getPaneIds(root);
  const selectedFullscreenPaneId = paneIds.includes(fullscreenPaneId) ? fullscreenPaneId : null;
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const hostOrder = useRef([]);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const geometry = getPaneTreeGeometry(root, dimensions.width, dimensions.height);
  // Keep DOM order independent of tree order so moving a split cannot blur an existing terminal.
  hostOrder.current = [...hostOrder.current.filter(id => paneIds.includes(id)), ...paneIds.filter(id => !hostOrder.current.includes(id))];
  const topology = JSON.stringify([currentDesktopId, selectedFullscreenPaneId, geometry.dividers.map(({ path, direction, paneIds: ids }) => [path, direction, ids])]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      setDimensions(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  resizeRef.current = (divider, value) => {
    if (!divider.pairSize) return;
    const bounded = Math.max(divider.min, Math.min(divider.max, value));
    const sizes = [...divider.sizes];
    const pairShare = sizes[divider.index] + sizes[divider.index + 1];
    sizes[divider.index] = pairShare * bounded / 100;
    sizes[divider.index + 1] = pairShare * (100 - bounded) / 100;
    const nextRoot = resizePaneTree(root, divider.path, sizes, divider.paneIds);
    if (nextRoot === root) return;
    setLocalLayout({ source: sourceRoot, desktopId: currentDesktopId, root: nextRoot });
    onPaneResize?.(divider.path, sizes, divider.paneIds);
  };

  useEffect(() => {
    const stop = event => {
      const drag = dragRef.current;
      if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
      dragRef.current = null;
      if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    };
    const move = event => {
      const drag = dragRef.current;
      if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
      event.preventDefault();
      const coordinate = drag.divider.direction === 'horizontal' ? event.clientX : event.clientY;
      resizeRef.current(drag.divider, drag.divider.value + (coordinate - drag.coordinate) / drag.divider.pairSize * 100);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      stop();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, [topology, dimensions.width, dimensions.height]);

  return (
    <div
      ref={containerRef}
      className={`split-pane-container tree-layout${selectedFullscreenPaneId ? ' fullscreen' : ''}`}
      style={{ position: 'relative', display: 'block', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
    >
      {hostOrder.current.map(id => {
        const { pane, rect } = geometry.leaves.find(leaf => leaf.pane.id === id);
        const hidden = Boolean(selectedFullscreenPaneId && pane.id !== selectedFullscreenPaneId);
        return (
          <div
            key={pane.id}
            data-pane-host={pane.id}
            style={{ position: 'absolute', display: hidden ? 'none' : 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0,
              ...(selectedFullscreenPaneId ? { inset: 0 } : rect) }}
            inert={hidden ? '' : undefined}
            aria-hidden={hidden || undefined}
          >
            <RetainedTerminalPane
              {...paneProps}
              pane={pane}
              currentDesktopId={currentDesktopId}
              isActive={pane.id === (selectedFullscreenPaneId || activePaneId)}
              isFullscreen={pane.id === selectedFullscreenPaneId}
              canSplit={paneIds.length < MAX_PANES}
              canClose={paneIds.length > 1}
              onSessionSelect={onPaneSessionSelect}
              onSplit={onPaneSplit}
              onClose={onPaneClose}
              onFocus={onPaneFocus}
              onFullscreen={onPaneFullscreen}
            />
          </div>
        );
      })}
      {!selectedFullscreenPaneId && geometry.dividers.map((divider, ordinal) => {
        const horizontal = divider.direction === 'horizontal';
        return <div
          key={`divider-${divider.path.join('-')}-${divider.index}`}
          role="separator"
          tabIndex={0}
          data-pane-resize-handle=""
          aria-label={`Resize panes ${horizontal ? 'left and right' : 'up and down'} ${ordinal + 1}`}
          aria-orientation={horizontal ? 'vertical' : 'horizontal'}
          aria-valuemin={ariaPercent(divider.min)}
          aria-valuemax={ariaPercent(divider.max)}
          aria-valuenow={ariaPercent(divider.value)}
          aria-valuetext={`${ariaPercent(divider.value)}% of adjacent panes`}
          title="Drag to resize. Arrow keys: 5%, Shift: 10%, Home/End: limits, Enter: equal panes."
          style={{ position: 'absolute', ...divider.rect, zIndex: 1, cursor: horizontal ? 'col-resize' : 'row-resize',
            touchAction: 'none', userSelect: 'none', background: 'var(--border-subtle)' }}
          onPointerDown={event => {
            if (event.button !== 0 || event.isPrimary === false || !divider.pairSize) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragRef.current = { divider, coordinate: horizontal ? event.clientX : event.clientY,
              pointerId: event.pointerId, target: event.currentTarget };
          }}
          onLostPointerCapture={() => { dragRef.current = null; }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Tab') return;
            event.preventDefault();
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const step = event.shiftKey ? 10 : 5;
            if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) resizeRef.current(divider, divider.value + step);
            else if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) resizeRef.current(divider, divider.value - step);
            else if (event.key === 'Home') resizeRef.current(divider, divider.min);
            else if (event.key === 'End') resizeRef.current(divider, divider.max);
            else if (event.key === 'Enter') resizeRef.current(divider, 50);
          }}
          onKeyUp={event => event.stopPropagation()}
        />;
      })}
    </div>
  );
}
