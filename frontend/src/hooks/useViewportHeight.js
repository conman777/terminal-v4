import { useEffect, useState, useRef } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

function readViewportMetrics() {
  if (typeof window === 'undefined') {
    return { height: 0, offsetTop: 0 };
  }

  const viewport = window.visualViewport;
  return {
    height: Math.round(viewport ? viewport.height : window.innerHeight),
    offsetTop: Math.round(viewport?.offsetTop || 0),
  };
}

// Track the real visible viewport so mobile layouts can react to browser chrome and keyboards.
export function useViewportMetrics() {
  const [metrics, setMetrics] = useState(() => readViewportMetrics());

  const pollIntervalIdRef = useRef(null);
  const slowdownTimeoutIdRef = useRef(null);
  const settleTimeoutIdRef = useRef(null);
  const windowActiveRef = useRef(isWindowActive());

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
      if (settleTimeoutIdRef.current) {
        clearTimeout(settleTimeoutIdRef.current);
        settleTimeoutIdRef.current = null;
      }
    };

    const updateHeight = () => {
      if (!windowActiveRef.current) {
        return;
      }
      const nextMetrics = readViewportMetrics();

      setMetrics((previousMetrics) => {
        if (
          nextMetrics.height !== previousMetrics.height
          || nextMetrics.offsetTop !== previousMetrics.offsetTop
        ) {
          return nextMetrics;
        }
        return previousMetrics;
      });
    };

    const isTouchLike = isTouchLikeDevice();
    const viewport = window.visualViewport;
    const hasVisualViewport = Boolean(viewport);

    // Short burst polling keeps keyboard transitions smooth on mobile while
    // avoiding continuous background timers on devices with visualViewport support.
    const FAST_POLL_INTERVAL = 100;
    const FALLBACK_POLL_INTERVAL = 2000;
    const KEYBOARD_ANIMATION_DURATION = 450;

    const startFastPolling = () => {
      if (!isTouchLike || !windowActiveRef.current) return;

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

    const handleViewportChange = () => {
      updateHeight();
      if (!isTouchLike || !windowActiveRef.current) {
        return;
      }
      if (settleTimeoutIdRef.current) {
        clearTimeout(settleTimeoutIdRef.current);
      }
      settleTimeoutIdRef.current = setTimeout(() => {
        settleTimeoutIdRef.current = null;
        updateHeight();
      }, KEYBOARD_ANIMATION_DURATION);
    };

    updateHeight();

    window.addEventListener('resize', handleViewportChange);

    if (viewport) {
      // Listen for both resize and scroll - mobile browsers can use either while
      // opening or dismissing the keyboard.
      viewport.addEventListener('resize', handleViewportChange);
      viewport.addEventListener('scroll', handleViewportChange);
    }

    if (isTouchLike) {
      if (!hasVisualViewport && windowActiveRef.current) {
        pollIntervalIdRef.current = setInterval(updateHeight, FALLBACK_POLL_INTERVAL);
      }
      window.addEventListener('focusin', startFastPolling);
      window.addEventListener('focusout', startFastPolling);
      window.addEventListener('orientationchange', startFastPolling);
    }

    const unsubscribeWindowActivity = subscribeWindowActivity((active) => {
      windowActiveRef.current = active;
      if (!active) {
        clearPollingTimers();
        return;
      }
      updateHeight();
      if (isTouchLike && !hasVisualViewport && !pollIntervalIdRef.current) {
        pollIntervalIdRef.current = setInterval(updateHeight, FALLBACK_POLL_INTERVAL);
      }
    });

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      if (isTouchLike) {
        window.removeEventListener('focusin', startFastPolling);
        window.removeEventListener('focusout', startFastPolling);
        window.removeEventListener('orientationchange', startFastPolling);
      }
      if (viewport) {
        viewport.removeEventListener('resize', handleViewportChange);
        viewport.removeEventListener('scroll', handleViewportChange);
      }
      unsubscribeWindowActivity();
      clearPollingTimers();
    };
  }, []);

  return metrics;
}

export function useViewportHeight() {
  return useViewportMetrics().height;
}
