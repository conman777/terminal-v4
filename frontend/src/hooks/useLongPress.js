import { useRef, useCallback } from 'react';

const LONG_PRESS_DELAY = 500;  // ms to trigger long press
const MOVE_THRESHOLD = 10;     // pixels - cancel if finger moves more than this

export function useLongPress(onLongPress, delay = LONG_PRESS_DELAY) {
  const timeoutRef = useRef(null);
  const touchStartRef = useRef(null);
  const triggeredRef = useRef(false);

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY
    };
    triggeredRef.current = false;

    clear();
    timeoutRef.current = setTimeout(() => {
      triggeredRef.current = true;
      onLongPress?.({
        x: touchStartRef.current.x,
        y: touchStartRef.current.y
      });
    }, delay);
  }, [onLongPress, delay, clear]);

  const onTouchMove = useCallback((e) => {
    if (!touchStartRef.current) return;

    const touch = e.touches[0];
    const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
    const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);

    // Cancel long press if finger moved too much
    if (deltaX > MOVE_THRESHOLD || deltaY > MOVE_THRESHOLD) {
      clear();
    }
  }, [clear]);

  const onTouchEnd = useCallback((e) => {
    clear();

    // If long press was triggered, prevent the click event
    if (triggeredRef.current) {
      e.preventDefault();
      triggeredRef.current = false;
    }

    touchStartRef.current = null;
  }, [clear]);

  // Also handle mouse for testing on desktop
  const onContextMenu = useCallback((e) => {
    // Prevent default context menu on mobile
    e.preventDefault();
  }, []);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onContextMenu
  };
}
