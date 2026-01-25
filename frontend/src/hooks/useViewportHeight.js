import { useEffect, useState, useRef } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';

// Track the real visible viewport height so mobile layouts can react to browser chrome and keyboards.
export function useViewportHeight() {
  const [height, setHeight] = useState(() => {
    if (typeof window === 'undefined') {
      return 0;
    }
    const viewport = window.visualViewport;
    return Math.round(viewport ? viewport.height : window.innerHeight);
  });

  const lastHeightRef = useRef(height);
  // Timer refs to prevent memory leaks in event handler closures
  const pollIntervalIdRef = useRef(null);
  const slowdownTimeoutIdRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateHeight = () => {
      const viewport = window.visualViewport;
      const nextHeight = Math.round(viewport ? viewport.height : window.innerHeight);

      // CRITICAL: Use callback form for atomic check-and-set to prevent race conditions
      // during rapid height changes (e.g., iOS keyboard animation)
      setHeight((prevHeight) => {
        if (nextHeight !== prevHeight) {
          lastHeightRef.current = nextHeight;
          return nextHeight;
        }
        return prevHeight;
      });
    };

    updateHeight();

    window.addEventListener('resize', updateHeight);

    const viewport = window.visualViewport;
    if (viewport) {
      // Listen for both resize and scroll - iOS fires scroll when keyboard opens
      viewport.addEventListener('resize', updateHeight);
      viewport.addEventListener('scroll', updateHeight);
    }

    const isTouchLike = isTouchLikeDevice();

    // Dynamic polling for mobile - faster during keyboard animations
    // iOS keyboard typically takes ~350ms to animate, poll fast during this time
    const FAST_POLL_INTERVAL = 100;   // Poll every 100ms during keyboard animation
    const SLOW_POLL_INTERVAL = 500;   // Poll every 500ms otherwise
    const KEYBOARD_ANIMATION_DURATION = 400;  // Wait 400ms before slowing down

    const startFastPolling = () => {
      if (!isTouchLike) return;
      // Immediately check height on focus change
      updateHeight();

      // Clear any existing timers via refs
      if (slowdownTimeoutIdRef.current) {
        clearTimeout(slowdownTimeoutIdRef.current);
        slowdownTimeoutIdRef.current = null;
      }
      if (pollIntervalIdRef.current) {
        clearInterval(pollIntervalIdRef.current);
        pollIntervalIdRef.current = null;
      }

      // Start fast polling
      pollIntervalIdRef.current = setInterval(updateHeight, FAST_POLL_INTERVAL);

      // Slow down after keyboard animation completes
      slowdownTimeoutIdRef.current = setTimeout(() => {
        if (pollIntervalIdRef.current) {
          clearInterval(pollIntervalIdRef.current);
          pollIntervalIdRef.current = null;
        }
        pollIntervalIdRef.current = setInterval(updateHeight, SLOW_POLL_INTERVAL);
      }, KEYBOARD_ANIMATION_DURATION);
    };

    // Start with slow polling on mobile
    if (isTouchLike) {
      pollIntervalIdRef.current = setInterval(updateHeight, SLOW_POLL_INTERVAL);
      // Switch to fast polling on focus changes (keyboard appearing/disappearing)
      window.addEventListener('focusin', startFastPolling);
      window.addEventListener('focusout', startFastPolling);
    }

    return () => {
      // Clean up event listeners
      window.removeEventListener('resize', updateHeight);
      if (isTouchLike) {
        window.removeEventListener('focusin', startFastPolling);
        window.removeEventListener('focusout', startFastPolling);
      }
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }

      // CRITICAL: Clean up timers using refs to prevent memory leaks
      if (pollIntervalIdRef.current) {
        clearInterval(pollIntervalIdRef.current);
        pollIntervalIdRef.current = null;
      }
      if (slowdownTimeoutIdRef.current) {
        clearTimeout(slowdownTimeoutIdRef.current);
        slowdownTimeoutIdRef.current = null;
      }
    };
  }, []);

  return height;
}
