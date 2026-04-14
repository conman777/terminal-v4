import { useEffect, useRef, useState } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

function isEditableElementFocused() {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function readViewportSnapshot() {
  if (typeof window === 'undefined') {
    return {
      height: 0,
      layoutHeight: 0,
      width: 0,
      layoutWidth: 0,
      offsetTop: 0,
      offsetLeft: 0,
      inputFocused: false
    };
  }

  const viewport = window.visualViewport;
  const rawHeight = viewport
    ? viewport.height
    : window.innerHeight;
  const rawWidth = viewport
    ? viewport.width
    : window.innerWidth;
  const layoutHeight = typeof window.innerHeight === 'number' && Number.isFinite(window.innerHeight)
    ? Math.max(0, Math.round(window.innerHeight))
    : 0;
  const layoutWidth = typeof window.innerWidth === 'number' && Number.isFinite(window.innerWidth)
    ? Math.max(0, Math.round(window.innerWidth))
    : 0;
  const rawOffsetTop = viewport?.offsetTop;
  const rawOffsetLeft = viewport?.offsetLeft;
  const inputFocused = isEditableElementFocused();

  return {
    height: typeof rawHeight === 'number' && Number.isFinite(rawHeight) ? Math.max(0, Math.round(rawHeight)) : 0,
    layoutHeight,
    width: typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? Math.max(0, Math.round(rawWidth)) : 0,
    layoutWidth,
    offsetTop: typeof rawOffsetTop === 'number' && Number.isFinite(rawOffsetTop) ? Math.max(0, Math.round(rawOffsetTop)) : 0,
    offsetLeft: typeof rawOffsetLeft === 'number' && Number.isFinite(rawOffsetLeft) ? Math.max(0, Math.round(rawOffsetLeft)) : 0,
    inputFocused,
  };
}

function coerceViewportMetrics(nextSnapshot, previousMetrics, wasEditableFocused, preserveLayoutViewport) {
  const visualHeight = nextSnapshot.height > 0 ? nextSnapshot.height : previousMetrics.height;
  const layoutHeight = nextSnapshot.layoutHeight > 0 ? nextSnapshot.layoutHeight : visualHeight;
  const visualWidth = nextSnapshot.width > 0 ? nextSnapshot.width : previousMetrics.width;
  const layoutWidth = nextSnapshot.layoutWidth > 0 ? nextSnapshot.layoutWidth : visualWidth;
  const keyboardWasOpen = wasEditableFocused || previousMetrics.offsetTop > 0;
  const keyboardDismissed = previousMetrics.offsetTop > 0 && nextSnapshot.offsetTop === 0;
  const shouldRestoreLayoutViewport = (
    (!nextSnapshot.inputFocused && keyboardWasOpen)
    || keyboardDismissed
  )
    && visualHeight > 0
    && layoutHeight > visualHeight;
  const shouldKeepPreservedLayoutViewport = preserveLayoutViewport
    && !nextSnapshot.inputFocused
    && layoutHeight > visualHeight;
  const height = shouldRestoreLayoutViewport || shouldKeepPreservedLayoutViewport ? layoutHeight : visualHeight;
  const shouldUseVisualWidth = nextSnapshot.inputFocused || nextSnapshot.offsetLeft > 0;
  const width = shouldUseVisualWidth ? visualWidth : layoutWidth;
  const offsetTop = nextSnapshot.inputFocused ? Math.max(0, nextSnapshot.offsetTop) : 0;
  const offsetLeft = shouldUseVisualWidth ? Math.max(0, nextSnapshot.offsetLeft) : 0;
  const nextPreserveLayoutViewport = !nextSnapshot.inputFocused
    && layoutHeight > visualHeight
    && (shouldRestoreLayoutViewport || shouldKeepPreservedLayoutViewport);

  return {
    height,
    width,
    offsetTop,
    offsetLeft,
    preserveLayoutViewport: nextPreserveLayoutViewport
  };
}

export function useViewportMetrics() {
  const [metrics, setMetrics] = useState(() => {
    const initialMetrics = coerceViewportMetrics(
      readViewportSnapshot(),
      { height: 0, width: 0, offsetTop: 0, offsetLeft: 0 },
      false,
      false,
    );
    return {
      height: initialMetrics.height,
      width: initialMetrics.width,
      offsetTop: initialMetrics.offsetTop,
      offsetLeft: initialMetrics.offsetLeft
    };
  });
  const pollIntervalIdRef = useRef(null);
  const pollIntervalMsRef = useRef(null);
  const slowdownTimeoutIdRef = useRef(null);
  const settleTimeoutIdRef = useRef(null);
  const windowActiveRef = useRef(isWindowActive());
  const editableFocusRef = useRef(isEditableElementFocused());
  const preserveLayoutViewportRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const clearPollInterval = () => {
      if (pollIntervalIdRef.current) {
        clearInterval(pollIntervalIdRef.current);
        pollIntervalIdRef.current = null;
        pollIntervalMsRef.current = null;
      }
    };

    const clearPollingTimers = () => {
      clearPollInterval();
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
      const nextSnapshot = readViewportSnapshot();
      const wasEditableFocused = editableFocusRef.current;
      editableFocusRef.current = nextSnapshot.inputFocused;
      setMetrics((previousMetrics) => {
        const normalizedMetrics = coerceViewportMetrics(
          nextSnapshot,
          previousMetrics,
          wasEditableFocused,
          preserveLayoutViewportRef.current,
        );
        preserveLayoutViewportRef.current = normalizedMetrics.preserveLayoutViewport;

        if (
          normalizedMetrics.height !== previousMetrics.height
          || normalizedMetrics.width !== previousMetrics.width
          || normalizedMetrics.offsetTop !== previousMetrics.offsetTop
          || normalizedMetrics.offsetLeft !== previousMetrics.offsetLeft
        ) {
          return {
            height: normalizedMetrics.height,
            width: normalizedMetrics.width,
            offsetTop: normalizedMetrics.offsetTop,
            offsetLeft: normalizedMetrics.offsetLeft,
          };
        }
        return previousMetrics;
      });
    };

    const isTouchLike = isTouchLikeDevice();
    const viewport = window.visualViewport;
    const hasVisualViewport = Boolean(viewport);
    const FAST_POLL_INTERVAL = 100;
    const ACTIVE_EDIT_POLL_INTERVAL = 250;
    const FALLBACK_POLL_INTERVAL = 2000;
    const KEYBOARD_ANIMATION_DURATION = 450;

    const startPolling = (intervalMs) => {
      if (pollIntervalMsRef.current === intervalMs && pollIntervalIdRef.current) {
        return;
      }
      clearPollInterval();
      pollIntervalIdRef.current = setInterval(updateMetrics, intervalMs);
      pollIntervalMsRef.current = intervalMs;
    };

    const syncPollingMode = () => {
      if (!isTouchLike || !windowActiveRef.current) {
        clearPollInterval();
        return;
      }

      if (editableFocusRef.current || preserveLayoutViewportRef.current) {
        startPolling(ACTIVE_EDIT_POLL_INTERVAL);
        return;
      }

      if (!hasVisualViewport) {
        startPolling(FALLBACK_POLL_INTERVAL);
        return;
      }

      clearPollInterval();
    };

    const startFastPolling = () => {
      if (!isTouchLike || !windowActiveRef.current) return;

      updateMetrics();
      if (settleTimeoutIdRef.current) {
        clearTimeout(settleTimeoutIdRef.current);
        settleTimeoutIdRef.current = null;
      }
      if (slowdownTimeoutIdRef.current) {
        clearTimeout(slowdownTimeoutIdRef.current);
        slowdownTimeoutIdRef.current = null;
      }

      startPolling(FAST_POLL_INTERVAL);

      slowdownTimeoutIdRef.current = setTimeout(() => {
        slowdownTimeoutIdRef.current = null;
        syncPollingMode();
      }, KEYBOARD_ANIMATION_DURATION);
    };

    const handleViewportChange = () => {
      updateMetrics();
      if (!isTouchLike || !windowActiveRef.current) {
        return;
      }
      syncPollingMode();
      if (settleTimeoutIdRef.current) {
        clearTimeout(settleTimeoutIdRef.current);
      }
      settleTimeoutIdRef.current = setTimeout(() => {
        settleTimeoutIdRef.current = null;
        updateMetrics();
        syncPollingMode();
      }, KEYBOARD_ANIMATION_DURATION);
    };

    updateMetrics();
    syncPollingMode();

    window.addEventListener('resize', handleViewportChange);

    if (viewport) {
      viewport.addEventListener('resize', handleViewportChange);
      viewport.addEventListener('scroll', handleViewportChange);
    }

    if (isTouchLike) {
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
      syncPollingMode();
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
