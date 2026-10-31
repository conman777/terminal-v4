import { useRef } from 'react';
import './PaneSeparator.css';

export function PaneSeparator({ orientation = 'vertical', label, value, min, max, step, largeStep, format = String, onChange, measure, onDragChange, reverseKeyboard = false }) {
  const dragging = useRef(false);
  const horizontalKeys = orientation === 'vertical';
  const grow = horizontalKeys ? (reverseKeyboard ? 'ArrowLeft' : 'ArrowRight') : (reverseKeyboard ? 'ArrowDown' : 'ArrowUp');
  const shrink = horizontalKeys ? (reverseKeyboard ? 'ArrowRight' : 'ArrowLeft') : (reverseKeyboard ? 'ArrowUp' : 'ArrowDown');

  function onKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const jump = event.shiftKey ? largeStep : step;
    const next = { [grow]: value + jump, [shrink]: value - jump, PageUp: value + largeStep, PageDown: value - largeStep, Home: min, End: max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
  }
  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onDragChange?.(true);
  }
  function onPointerMove(event) {
    if (!dragging.current) return;
    const next = measure(event);
    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
  }
  function endDrag(event) {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onDragChange?.(false);
  }

  return <div role="separator" tabIndex={0} className={`pane-separator pane-separator-${orientation}`}
    aria-orientation={orientation} aria-label={label}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={format(value)}
    onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} />;
}
