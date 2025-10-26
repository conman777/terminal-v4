import { useEffect, useState } from 'react';

// Track the real visible viewport height so mobile layouts can react to browser chrome and keyboards.
export function useViewportHeight() {
  const [height, setHeight] = useState(() => {
    if (typeof window === 'undefined') {
      return 0;
    }
    return Math.round(window.innerHeight);
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateHeight = () => {
      const viewport = window.visualViewport;
      const nextHeight = viewport ? viewport.height : window.innerHeight;
      setHeight(Math.round(nextHeight));
    };

    updateHeight();

    window.addEventListener('resize', updateHeight);

    let viewport;
    if (window.visualViewport) {
      viewport = window.visualViewport;
      viewport.addEventListener('resize', updateHeight);
      viewport.addEventListener('scroll', updateHeight);
    }

    return () => {
      window.removeEventListener('resize', updateHeight);
      if (viewport) {
        viewport.removeEventListener('resize', updateHeight);
        viewport.removeEventListener('scroll', updateHeight);
      }
    };
  }, []);

  return height;
}
