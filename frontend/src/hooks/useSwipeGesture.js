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
    console.log('[Swipe] useEffect - container:', !!container, 'enabled:', enabled);
    if (!container) return;

    const handleTouchStart = (e) => {
      console.log('[Swipe] touchstart, enabled:', enabledRef.current);
      if (!enabledRef.current) return;

      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY
      };
      touchStartTimeRef.current = Date.now();
      swipeLockRef.current = null;
      console.log('[Swipe] start at:', touchStartRef.current);
    };

    const handleTouchMove = (e) => {
      if (!enabledRef.current || !touchStartRef.current) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (!swipeLockRef.current) {
        // Determine intent once user moves enough.
        if (absX > 10 || absY > 10) {
          swipeLockRef.current = absX > absY ? 'horizontal' : 'vertical';
          console.log('[Swipe] direction locked:', swipeLockRef.current, 'deltaX:', deltaX, 'deltaY:', deltaY);
        }
      }

      if (swipeLockRef.current === 'horizontal') {
        // Prevent vertical scroll when horizontal swipe is intended.
        e.preventDefault();
      }
    };

    const handleTouchEnd = (e) => {
      console.log('[Swipe] touchend, hasStart:', !!touchStartRef.current);
      if (!enabledRef.current || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      const deltaTime = Date.now() - touchStartTimeRef.current;

      // Reset refs
      touchStartRef.current = null;
      touchStartTimeRef.current = null;
      const swipeLock = swipeLockRef.current;
      swipeLockRef.current = null;

      console.log('[Swipe] end - deltaX:', deltaX, 'deltaY:', deltaY, 'time:', deltaTime, 'lock:', swipeLock);

      // Ignore vertical intent to preserve scroll behavior
      if (swipeLock === 'vertical') {
        console.log('[Swipe] ignored - vertical');
        return;
      }

      const absX = Math.abs(deltaX);
      const velocity = absX / deltaTime;

      // Check if it's a valid swipe
      const isQuickSwipe = deltaTime < MAX_SWIPE_TIME && absX > MIN_SWIPE_DISTANCE;
      const isSlowSwipe = velocity > MIN_VELOCITY && absX > MIN_SWIPE_DISTANCE;

      console.log('[Swipe] absX:', absX, 'velocity:', velocity, 'quick:', isQuickSwipe, 'slow:', isSlowSwipe);

      if (isQuickSwipe || isSlowSwipe) {
        if (deltaX < 0) {
          // Swiped left (go to next)
          console.log('[Swipe] TRIGGERING swipe LEFT');
          onSwipeLeftRef.current?.();
        } else {
          // Swiped right (go to previous)
          console.log('[Swipe] TRIGGERING swipe RIGHT');
          onSwipeRightRef.current?.();
        }
      } else {
        console.log('[Swipe] not enough distance/velocity');
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
  }, []);

  return { containerRef };
}
