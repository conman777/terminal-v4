import { useCallback, useRef } from 'react';

/**
 * Hook to track touch gestures and distinguish taps from scrolls.
 * Returns handlers and a ref to check if current touch has moved.
 */
export function useTouchGestures(isMobile, onTap, options = {}) {
  const touchStateRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const { onLongPress, onMove, longPressMs = 500 } = options || {};

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchStartCapture = useCallback((event) => {
    if (!isMobile) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    touchStateRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      x: touch.clientX,
      y: touch.clientY,
      moved: false,
      longPressFired: false
    };
    clearLongPressTimer();
    if (onLongPress) {
      longPressTimerRef.current = setTimeout(() => {
        const state = touchStateRef.current;
        if (!state || state.moved) return;
        state.longPressFired = true;
        onLongPress();
      }, longPressMs);
    }
  }, [clearLongPressTimer, isMobile, longPressMs, onLongPress]);

  const handleTouchMoveCapture = useCallback((event) => {
    const state = touchStateRef.current;
    if (!state) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    if (Math.abs(touch.clientX - state.startX) > 8 || Math.abs(touch.clientY - state.startY) > 8) {
      state.moved = true;
      clearLongPressTimer();
    }
    const deltaX = touch.clientX - state.x;
    const deltaY = touch.clientY - state.y;
    if (onMove) {
      onMove({ deltaX, deltaY, event, state });
    }
    state.x = touch.clientX;
    state.y = touch.clientY;
  }, [clearLongPressTimer, onMove]);

  const handleTouchEndCapture = useCallback((event) => {
    if (!isMobile) return;
    const state = touchStateRef.current;
    touchStateRef.current = null;
    clearLongPressTimer();
    if (!state || state.moved || state.longPressFired) return;
    onTap?.(event);
  }, [clearLongPressTimer, isMobile, onTap]);

  const handleTouchCancelCapture = useCallback(() => {
    touchStateRef.current = null;
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  return {
    touchStateRef,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleTouchCancelCapture
  };
}
