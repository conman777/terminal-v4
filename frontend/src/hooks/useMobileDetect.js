import { useState, useEffect } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';

// Mobile detection thresholds
// Touch devices <= 1024px are considered mobile (phones and small tablets)
// Touch devices > 1024px are desktop (large tablets like iPad Pro 12.9")
// Non-touch devices <= 768px are considered mobile (narrow browser windows)
const MOBILE_MAX_WIDTH_TOUCH = 1024;
const MOBILE_MAX_WIDTH_NO_TOUCH = 768;

export function useMobileDetect() {
  const getIsMobile = () => {
    if (typeof window === 'undefined') return false;
    const width = window.innerWidth;
    const isTouchLike = isTouchLikeDevice();
    const threshold = isTouchLike ? MOBILE_MAX_WIDTH_TOUCH : MOBILE_MAX_WIDTH_NO_TOUCH;
    return width <= threshold;
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
