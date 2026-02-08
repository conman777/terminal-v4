import { useCallback, useRef } from 'react';
import { SESSION_BUSY_WINDOW_MS } from '../constants/sessionActivity';

/**
 * Hook to detect terminal idle state and play audio feedback.
 * Tracks user input and triggers callbacks when terminal goes idle.
 */
export function useIdleDetection({ onActivityChange, startFaviconFlash, stopFaviconFlash }) {
  const idleTimerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const isActiveRef = useRef(false);
  const hasUserInputRef = useRef(false);

  const playIdleTone = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 600;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {
      // Audio not supported or blocked
    }
  }, []);

  const markUserInput = useCallback(() => {
    hasUserInputRef.current = true;
  }, []);

  const resetIdleTimer = useCallback((isScrolling) => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
    }

    // Skip when scrolling or no user input yet
    if (isScrolling || !hasUserInputRef.current) {
      return;
    }

    // Only notify on state transition (not every message)
    if (!isActiveRef.current) {
      isActiveRef.current = true;
      startFaviconFlash?.();
      onActivityChange?.(true);
    }

    idleTimerRef.current = setTimeout(() => {
      playIdleTone();
      isActiveRef.current = false;
      stopFaviconFlash?.();
      onActivityChange?.(false);
    }, SESSION_BUSY_WINDOW_MS);
  }, [onActivityChange, startFaviconFlash, stopFaviconFlash, playIdleTone]);

  const resetUserInput = useCallback(() => {
    hasUserInputRef.current = false;
  }, []);

  const cleanup = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  return {
    hasUserInputRef,
    markUserInput,
    resetUserInput,
    resetIdleTimer,
    cleanup
  };
}
