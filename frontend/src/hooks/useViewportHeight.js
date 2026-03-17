import { useEffect, useRef, useState } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

function isEditableElementFocused() {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function readViewportMetrics() {
  if (typeof window === 'undefined') {
    return { height: 0, offsetTop: 0 };
  }

  const viewport = window.visualViewport;
  const rawHeight = viewport
    ? viewport.height
    : window.innerHeight;
  const rawOffsetTop = viewport?.offsetTop;
  const inputFocused = isEditableElementFocused();

  return {
    height: typeof rawHeight === 'number' && Number.isFinite(rawHeight) ? Math.max(0, Math.round(rawHeight)) : 0,
    offsetTop: inputFocused && typeof rawOffsetTop === 'number' && Number.isFinite(rawOffsetTop) ? Math.max(0, Math.round(rawOffsetTop)) : 0,
  };
}

function coerceViewportMetrics(nextMetrics, previousMetrics) {
  const height = nextMetrics.height > 0 ? nextMetrics.height : previousMetrics.height;
  const offsetTop = Math.max(0, nextMetrics.offsetTop);

  return { height, offsetTop };
}

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

    const updateMetrics = () => {
      if (!windowActiveRef.current) {
        return;
      }
      const nextMetrics = readViewportMetrics();
      setMetrics((previousMetrics) => {
        const normalizedMetrics = coerceViewportMetrics(nextMetrics, previousMetrics);

        if (
          normalizedMetrics.height !== previousMetrics.height
          || normalizedMetrics.offsetTop !== previousMetrics.offsetTop
        ) {
          return normalizedMetrics;
        }
        return previousMetrics;
      });
    };

    const isTouchLike = isTouchLikeDevice();
    const viewport = window.visualViewport;
    const hasVisualViewport = Boolean(viewport);
    const FAST_POLL_INTERVAL = 100;
    const FALLBACK_POLL_INTERVAL = 2000;
    const KEYBOARD_ANIMATION_DURATION = 450;

    const startFastPolling = () => {
      if (!isTouchLike || !windowActiveRef.current) return;

      updateMetrics();
      clearPollingTimers();

      pollIntervalIdRef.current = setInterval(updateMetrics, FAST_POLL_INTERVAL);

      slowdownTimeoutIdRef.current = setTimeout(() => {
        if (pollIntervalIdRef.current) {
          clearInterval(pollIntervalIdRef.current);
          pollIntervalIdRef.current = null;
        }
        if (!hasVisualViewport) {
          pollIntervalIdRef.current = setInterval(updateMetrics, FALLBACK_POLL_INTERVAL);
        }
      }, KEYBOARD_ANIMATION_DURATION);
    };

    const handleViewportChange = () => {
      updateMetrics();
      if (!isTouchLike || !windowActiveRef.current) {
        return;
      }
      if (settleTimeoutIdRef.current) {
        clearTimeout(settleTimeoutIdRef.current);
      }
      settleTimeoutIdRef.current = setTimeout(() => {
        settleTimeoutIdRef.current = null;
        updateMetrics();
      }, KEYBOARD_ANIMATION_DURATION);
    };

    updateMetrics();

    window.addEventListener('resize', handleViewportChange);

    if (viewport) {
      viewport.addEventListener('resize', handleViewportChange);
      viewport.addEventListener('scroll', handleViewportChange);
    }

    if (isTouchLike) {
      if (!hasVisualViewport && windowActiveRef.current) {
        pollIntervalIdRef.current = setInterval(updateMetrics, FALLBACK_POLL_INTERVAL);
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
      updateMetrics();
      if (isTouchLike && !hasVisualViewport && !pollIntervalIdRef.current) {
        pollIntervalIdRef.current = setInterval(updateMetrics, FALLBACK_POLL_INTERVAL);
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
