import { useCallback, useRef } from 'react';

/**
 * Hook to track touch gestures and distinguish taps from scrolls.
 * Returns handlers and a ref to check if current touch has moved.
 */
export function useTouchGestures(isMobile, onTap) {
  const touchStateRef = useRef(null);

  const handleTouchStartCapture = useCallback((event) => {
    if (!isMobile) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    touchStateRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      moved: false
    };
  }, [isMobile]);

  const handleTouchMoveCapture = useCallback((event) => {
    const state = touchStateRef.current;
    if (!state) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    if (Math.abs(touch.clientX - state.x) > 8 || Math.abs(touch.clientY - state.y) > 8) {
      state.moved = true;
    }
  }, []);

  const handleTouchEndCapture = useCallback((event) => {
    if (!isMobile) return;
    const state = touchStateRef.current;
    touchStateRef.current = null;
    if (!state || state.moved) return;
    onTap?.(event);
  }, [isMobile, onTap]);

  const handleTouchCancelCapture = useCallback(() => {
    touchStateRef.current = null;
  }, []);

  return {
    touchStateRef,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleTouchEndCapture,
    handleTouchCancelCapture
  };
}
