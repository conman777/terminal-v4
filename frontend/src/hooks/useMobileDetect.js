import { useState, useEffect } from 'react';

export function useMobileDetect() {
  const getIsMobile = () => {
    if (typeof window === 'undefined') return false;
    const width = window.innerWidth;
    const ua = navigator.userAgent || '';
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
    const uaDataMobile = navigator.userAgentData?.mobile === true;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const noHover = window.matchMedia?.('(hover: none)')?.matches ?? false;
    const touchPoints = navigator.maxTouchPoints || 0;
    const isTouchLike = uaMobile || uaDataMobile || coarsePointer || noHover || touchPoints > 1;
    const threshold = isTouchLike ? 1024 : 768;
    return isTouchLike && width <= threshold;
  };

  // Initialize from actual window traits to prevent layout flash
  const [isMobile, setIsMobile] = useState(() => getIsMobile());

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(getIsMobile());
    };

    // Re-check on mount in case of SSR hydration mismatch
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return isMobile;
}
