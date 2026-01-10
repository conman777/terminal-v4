import { useCallback, useRef, useEffect } from 'react';

/**
 * Hook to manage favicon flashing for terminal activity indication.
 */
export function useFaviconFlash(isActiveSession) {
  const faviconIntervalRef = useRef(null);

  const startFaviconFlash = useCallback(() => {
    if (!isActiveSession || faviconIntervalRef.current) return;
    const link = document.querySelector("link[rel='icon']");
    if (!link) return;

    let showActive = true;
    faviconIntervalRef.current = setInterval(() => {
      link.href = showActive ? '/favicon-active.svg' : '/favicon-idle.svg';
      showActive = !showActive;
    }, 500);
  }, [isActiveSession]);

  const stopFaviconFlash = useCallback(() => {
    if (faviconIntervalRef.current) {
      clearInterval(faviconIntervalRef.current);
      faviconIntervalRef.current = null;
    }
    const link = document.querySelector("link[rel='icon']");
    if (link) {
      link.href = '/favicon-idle.svg';
    }
  }, []);

  // Cleanup favicon on session change or unmount
  useEffect(() => {
    if (!isActiveSession) {
      stopFaviconFlash();
    }
    return () => stopFaviconFlash();
  }, [isActiveSession, stopFaviconFlash]);

  return { startFaviconFlash, stopFaviconFlash };
}
