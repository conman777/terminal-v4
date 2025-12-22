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

    // iOS sometimes doesn't fire events reliably - poll as backup
    // This catches edge cases where events are missed
    const pollInterval = setInterval(updateHeight, 100);

    return () => {
      window.removeEventListener('resize', updateHeight);
      clearInterval(pollInterval);
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
    };
  }, []);

  return height;
}
