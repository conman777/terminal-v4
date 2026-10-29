import { useCallback, useEffect, useRef, useState } from 'react';

const HOLD_MS = 450;
const MOVE_TOLERANCE = 10;
const CLICK_GUARD_MS = 500;

export function useTouchReorder({ onDrop, holdMs = HOLD_MS }) {
  const [armedId, setArmedId] = useState(null);
  const [mark, setMark] = useState(null);
  const gesture = useRef(null);
  const timer = useRef(null);
  const clickGuard = useRef(0);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const clearTimer = useCallback(() => { clearTimeout(timer.current); timer.current = null; }, []);
  const arm = useCallback(id => { clearTimer(); gesture.current = null; setArmedId(id); }, [clearTimer]);
  const disarm = useCallback(() => { clearTimer(); gesture.current = null; setArmedId(null); setMark(null); }, [clearTimer]);
  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (armedId === null) return undefined;
    const holdScroll = event => { if (gesture.current?.active) event.preventDefault(); };
    document.addEventListener('touchmove', holdScroll, { passive: false });
    return () => document.removeEventListener('touchmove', holdScroll);
  }, [armedId]);

  const bind = useCallback((id, siblings) => ({
    onTouchStart: event => {
      const point = event.touches?.[0];
      if (!point || event.touches.length > 1) return;
      clearTimer();
      gesture.current = { id, siblings, x: point.clientX, y: point.clientY, active: false };
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!gesture.current) return;
        gesture.current.active = true;
        setArmedId(id);
        navigator.vibrate?.(10);
      }, holdMs);
    },
    onTouchMove: event => {
      const current = gesture.current;
      const point = event.touches?.[0];
      if (!current || !point) return;
      if (!current.active) {
        if (Math.abs(point.clientX - current.x) > MOVE_TOLERANCE || Math.abs(point.clientY - current.y) > MOVE_TOLERANCE) { clearTimer(); gesture.current = null; }
        return;
      }
      const row = document.elementFromPoint?.(point.clientX, point.clientY)?.closest?.('[data-reorder-id]');
      const targetId = row?.dataset.reorderId;
      if (!row || targetId === current.id || !current.siblings.includes(targetId)) { setMark(null); return; }
      const rect = row.getBoundingClientRect();
      const after = point.clientY > rect.top + rect.height / 2;
      setMark(previous => (previous?.id === targetId && previous.after === after ? previous : { id: targetId, after }));
    },
    onTouchEnd: event => {
      clearTimer();
      const current = gesture.current;
      gesture.current = null;
      if (!current?.active) return;
      clickGuard.current = Date.now() + CLICK_GUARD_MS;
      event.preventDefault?.();
      const point = event.changedTouches?.[0];
      let drop = null;
      if (point) {
        const row = document.elementFromPoint?.(point.clientX, point.clientY)?.closest?.('[data-reorder-id]');
        const targetId = row?.dataset.reorderId;
        if (row && targetId !== current.id && current.siblings.includes(targetId)) {
          const rect = row.getBoundingClientRect();
          drop = { targetId, after: point.clientY > rect.top + rect.height / 2 };
        }
      }
      setMark(null);
      if (drop) { setArmedId(null); onDropRef.current(current.id, drop.targetId, drop.after); }
    },
    onTouchCancel: () => { clearTimer(); gesture.current = null; setMark(null); },
    onClickCapture: event => {
      if (Date.now() < clickGuard.current) { event.preventDefault(); event.stopPropagation(); }
    },
    onContextMenu: event => event.preventDefault(),
  }), [clearTimer, holdMs]);

  return { armedId, mark, bind, arm, disarm };
}
