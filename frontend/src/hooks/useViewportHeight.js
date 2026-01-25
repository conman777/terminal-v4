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

    // iOS sometimes doesn't fire events reliably - poll as backup (mobile only)
    const pollInterval = isTouchLike ? setInterval(updateHeight, 500) : null;

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (pollInterval) clearInterval(pollInterval);
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
    };
  }, []);

  return height;
}
