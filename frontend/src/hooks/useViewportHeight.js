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

  const pollIntervalIdRef = useRef(null);
  const slowdownTimeoutIdRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const clearPollingTimers = () => {
      if (pollIntervalIdRef.current) {
        clearInterval(pollIntervalIdRef.current);
        pollIntervalIdRef.current = null;
      }
      if (slowdownTimeoutIdRef.current) {
        clearTimeout(slowdownTimeoutIdRef.current);
        slowdownTimeoutIdRef.current = null;
      }
    };

    const updateHeight = () => {
      const viewport = window.visualViewport;
      const nextHeight = Math.round(viewport ? viewport.height : window.innerHeight);

      setHeight((prevHeight) => {
        if (nextHeight !== prevHeight) {
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
    const hasVisualViewport = Boolean(viewport);

    // Short burst polling keeps keyboard transitions smooth on mobile while
    // avoiding continuous background timers on devices with visualViewport support.
    const FAST_POLL_INTERVAL = 100;
    const FALLBACK_POLL_INTERVAL = 2000;
    const KEYBOARD_ANIMATION_DURATION = 450;

    const startFastPolling = () => {
      if (!isTouchLike) return;

      updateHeight();
      clearPollingTimers();

      pollIntervalIdRef.current = setInterval(updateHeight, FAST_POLL_INTERVAL);

      slowdownTimeoutIdRef.current = setTimeout(() => {
        if (pollIntervalIdRef.current) {
          clearInterval(pollIntervalIdRef.current);
          pollIntervalIdRef.current = null;
        }
        if (!hasVisualViewport) {
          pollIntervalIdRef.current = setInterval(updateHeight, FALLBACK_POLL_INTERVAL);
        }
      }, KEYBOARD_ANIMATION_DURATION);
    };

    if (isTouchLike) {
      if (!hasVisualViewport) {
        pollIntervalIdRef.current = setInterval(updateHeight, FALLBACK_POLL_INTERVAL);
      }
      window.addEventListener('focusin', startFastPolling);
      window.addEventListener('focusout', startFastPolling);
      window.addEventListener('orientationchange', startFastPolling);
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (isTouchLike) {
        window.removeEventListener('focusin', startFastPolling);
        window.removeEventListener('focusout', startFastPolling);
        window.removeEventListener('orientationchange', startFastPolling);
      }
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
      clearPollingTimers();
    };
  }, []);

  return height;
}
