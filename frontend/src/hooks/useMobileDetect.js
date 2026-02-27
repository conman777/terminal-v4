import { useState, useEffect } from 'react';
import { isTouchLikeDevice } from '../utils/deviceDetection';

// Mobile detection thresholds
// Touch devices <= 1024px are considered mobile (phones and small tablets)
// Touch devices > 1024px are desktop (large tablets like iPad Pro 12.9")
// Non-touch devices <= 768px are considered mobile (narrow browser windows)
const MOBILE_MAX_WIDTH_TOUCH = 1024;
const MOBILE_MAX_WIDTH_NO_TOUCH = 768;
const HARD_DESKTOP_MIN_WIDTH = 1100;

export function useMobileDetect() {
  const getViewportWidth = () => {
    if (typeof window === 'undefined') return 0;
    const visualWidth = window.visualViewport?.width || 0;
    const docWidth = document.documentElement?.clientWidth || 0;
    return Math.max(window.innerWidth || 0, visualWidth, docWidth);
  };

  const getIsMobile = () => {
    if (typeof window === 'undefined') return false;
    const width = getViewportWidth();
    if (width >= HARD_DESKTOP_MIN_WIDTH) return false;
    const isTouchLike = isTouchLikeDevice();
    const threshold = isTouchLike ? MOBILE_MAX_WIDTH_TOUCH : MOBILE_MAX_WIDTH_NO_TOUCH;
    return width <= threshold;
  };

  // Initialize from actual window traits to prevent layout flash
  const [isMobile, setIsMobile] = useState(() => getIsMobile());

  useEffect(() => {
    let debounceTimer = null;

    // Debounce prevents transient pointer-type changes (e.g. touchscreen laptop
    // briefly reporting coarse pointer) and visualViewport resize events (iOS
    // keyboard open/close) from flipping the layout and remounting all terminals.
    const checkMobile = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setIsMobile(getIsMobile());
      }, 400);
    };

    // Re-check immediately on mount (no debounce needed — no terminals mounted yet).
    setIsMobile(getIsMobile());

    window.addEventListener('resize', checkMobile);
    window.addEventListener('orientationchange', checkMobile);

    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', checkMobile);
    }

    const pointerQuery = window.matchMedia?.('(pointer: coarse)');
    const hoverQuery = window.matchMedia?.('(hover: none)');
    pointerQuery?.addEventListener?.('change', checkMobile);
    hoverQuery?.addEventListener?.('change', checkMobile);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('orientationchange', checkMobile);
      if (viewport) {
        viewport.removeEventListener('resize', checkMobile);
      }
      pointerQuery?.removeEventListener?.('change', checkMobile);
      hoverQuery?.removeEventListener?.('change', checkMobile);
    };
  }, []);

  return isMobile;
}
