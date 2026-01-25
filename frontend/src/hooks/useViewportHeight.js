import { useEffect, useState, useRef } from 'react';

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateHeight = () => {
      const viewport = window.visualViewport;
      const nextHeight = Math.round(viewport ? viewport.height : window.innerHeight);
      // Only update if actually changed to avoid unnecessary rerenders
      if (nextHeight !== lastHeightRef.current) {
        lastHeightRef.current = nextHeight;
        setHeight(nextHeight);
      }
    };

    updateHeight();

    window.addEventListener('resize', updateHeight);

    const viewport = window.visualViewport;
    if (viewport) {
      // Listen for both resize and scroll - iOS fires scroll when keyboard opens
      viewport.addEventListener('resize', updateHeight);
      viewport.addEventListener('scroll', updateHeight);
    }

    const ua = navigator.userAgent || '';
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
    const uaDataMobile = navigator.userAgentData?.mobile === true;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const noHover = window.matchMedia?.('(hover: none)')?.matches ?? false;
    const touchPoints = navigator.maxTouchPoints || 0;
    const isTouchLike = uaMobile || uaDataMobile || coarsePointer || noHover || touchPoints > 1;

    // Dynamic polling for mobile - faster during keyboard animations
    const FAST_POLL_INTERVAL = 100;
    const SLOW_POLL_INTERVAL = 500;
    const KEYBOARD_ANIMATION_DURATION = 400;

    let pollIntervalId = null;
    let slowdownTimeoutId = null;

    const startFastPolling = () => {
      if (!isTouchLike) return;
      // Immediately check height on focus change
      updateHeight();
      if (slowdownTimeoutId) clearTimeout(slowdownTimeoutId);
      if (pollIntervalId) clearInterval(pollIntervalId);
      pollIntervalId = setInterval(updateHeight, FAST_POLL_INTERVAL);
      // Slow down after keyboard animation completes
      slowdownTimeoutId = setTimeout(() => {
        if (pollIntervalId) clearInterval(pollIntervalId);
        pollIntervalId = setInterval(updateHeight, SLOW_POLL_INTERVAL);
      }, KEYBOARD_ANIMATION_DURATION);
    };

    // Start with slow polling on mobile
    if (isTouchLike) {
      pollIntervalId = setInterval(updateHeight, SLOW_POLL_INTERVAL);
      // Switch to fast polling on focus changes (keyboard appearing/disappearing)
      window.addEventListener('focusin', startFastPolling);
      window.addEventListener('focusout', startFastPolling);
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (pollIntervalId) clearInterval(pollIntervalId);
      if (slowdownTimeoutId) clearTimeout(slowdownTimeoutId);
      if (isTouchLike) {
        window.removeEventListener('focusin', startFastPolling);
        window.removeEventListener('focusout', startFastPolling);
      }
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
    };
  }, []);

  return height;
}
