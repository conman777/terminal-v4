import { useRef, useEffect, useCallback } from 'react';

// Swipe detection thresholds
const MIN_SWIPE_DISTANCE = 50;  // Minimum pixels to count as swipe
const MAX_SWIPE_TIME = 300;     // Max ms for quick swipe
const MIN_VELOCITY = 0.3;       // Minimum pixels/ms for slower swipes

export function useSwipeGesture({ onSwipeLeft, onSwipeRight, enabled = true }) {
  const containerRef = useRef(null);
  const touchStartRef = useRef(null);
  const touchStartTimeRef = useRef(null);
  const swipeLockRef = useRef(null); // 'horizontal' | 'vertical' | null

  // Store callbacks in refs to avoid re-attaching listeners
  const onSwipeLeftRef = useRef(onSwipeLeft);
  const onSwipeRightRef = useRef(onSwipeRight);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onSwipeLeftRef.current = onSwipeLeft;
    onSwipeRightRef.current = onSwipeRight;
    enabledRef.current = enabled;
  }, [onSwipeLeft, onSwipeRight, enabled]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleTouchStart = (e) => {
      if (!enabledRef.current) return;

      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY
      };
      touchStartTimeRef.current = Date.now();
      swipeLockRef.current = null;
    };

    const handleTouchMove = (e) => {
      if (!enabledRef.current || !touchStartRef.current) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!swipeLockRef.current) {
        // Determine intent once user moves enough, bias toward vertical to preserve scrolling.
        if (absX > 12 || absY > 12) {
          swipeLockRef.current = absX > absY + 6 ? 'horizontal' : 'vertical';
        }
      }

      if (swipeLockRef.current === 'horizontal') {
        // Prevent vertical scroll when horizontal swipe is strongly intended.
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e) => {
      if (!enabledRef.current || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaTime = Date.now() - touchStartTimeRef.current;

      // Reset refs
      touchStartRef.current = null;
      touchStartTimeRef.current = null;
      const swipeLock = swipeLockRef.current;
      swipeLockRef.current = null;

      // Ignore vertical intent to preserve scroll behavior
      if (swipeLock === 'vertical') {
        return;
      }

      const absX = Math.abs(deltaX);
      const velocity = absX / deltaTime;

      // Check if it's a valid swipe
      const isQuickSwipe = deltaTime < MAX_SWIPE_TIME && absX > MIN_SWIPE_DISTANCE;
      const isSlowSwipe = velocity > MIN_VELOCITY && absX > MIN_SWIPE_DISTANCE;

      if (isQuickSwipe || isSlowSwipe) {
        if (deltaX < 0) {
          // Swiped left (go to next)
          onSwipeLeftRef.current?.();
        } else {
          // Swiped right (go to previous)
          onSwipeRightRef.current?.();
        }
      }
    };

    // Use capture phase to get events before children can stop propagation
    container.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    container.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', handleTouchEnd, { capture: true, passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart, { capture: true });
      container.removeEventListener('touchmove', handleTouchMove, { capture: true });
      container.removeEventListener('touchend', handleTouchEnd, { capture: true });
    };
  }, [enabled]);

  return { containerRef };
}
