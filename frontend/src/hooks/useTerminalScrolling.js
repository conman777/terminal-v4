import { useCallback, useRef } from 'react';

/**
 * Hook to manage terminal scrolling including tmux copy-mode.
 * Provides scroll up/down, jump to live, and press-and-hold acceleration.
 */
export function useTerminalScrolling(xtermRef, sendToTerminal) {
  const inCopyModeRef = useRef(false);
  const copyModeTimeoutRef = useRef(null);
  const isScrollingRef = useRef(false);
  const scrollCooldownRef = useRef(null);
  const scrollIntervalRef = useRef(null);
  const scrollStartTimeRef = useRef(null);
  const scrollDirectionRef = useRef(null);
  const lastScrollTimeRef = useRef(0);

  // Enter tmux copy-mode with automatic timeout reset
  const enterCopyMode = useCallback(() => {
    sendToTerminal('\x02'); // Ctrl+B (tmux prefix)
    setTimeout(() => {
      sendToTerminal('['); // copy-mode command
    }, 10);
    inCopyModeRef.current = true;

    // Auto-exit copy-mode after 3s of no scroll activity
    clearTimeout(copyModeTimeoutRef.current);
    copyModeTimeoutRef.current = setTimeout(() => {
      sendToTerminal('q');
      inCopyModeRef.current = false;
    }, 3000);
  }, [sendToTerminal]);

  // Scroll in tmux copy-mode (shared logic for buttons and wheel)
  const scrollInTmux = useCallback((direction) => {
    const term = xtermRef.current;
    if (!term) return;

    // Mark scrolling active to suppress idle sound
    isScrollingRef.current = true;
    if (scrollCooldownRef.current) {
      clearTimeout(scrollCooldownRef.current);
    }
    scrollCooldownRef.current = setTimeout(() => {
      isScrollingRef.current = false;
    }, 500);

    const baseY = term.buffer?.active?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(direction === 'up' ? -5 : 5);
    } else {
      // No xterm scrollback - tmux managing it
      enterCopyMode();
      setTimeout(() => {
        sendToTerminal(direction === 'up' ? '\x15' : '\x04'); // Ctrl+U / Ctrl+D
      }, 60);
    }
  }, [xtermRef, sendToTerminal, enterCopyMode]);

  const scrollUp = useCallback(() => scrollInTmux('up'), [scrollInTmux]);
  const scrollDown = useCallback(() => scrollInTmux('down'), [scrollInTmux]);

  // Jump to live output - exits tmux copy-mode and scrolls xterm to bottom
  const jumpToLive = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    sendToTerminal('\x1b'); // ESC
    sendToTerminal('q');    // quit copy-mode
    inCopyModeRef.current = false;
    clearTimeout(copyModeTimeoutRef.current);

    term.scrollToBottom();
  }, [xtermRef, sendToTerminal]);

  // Start continuous scrolling with acceleration using requestAnimationFrame
  const startScrolling = useCallback((direction) => {
    if (scrollIntervalRef.current) {
      cancelAnimationFrame(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }

    const startTime = Date.now();
    scrollStartTimeRef.current = startTime;
    scrollDirectionRef.current = direction;
    lastScrollTimeRef.current = 0;

    // Scroll immediately on press
    if (direction === 'up') {
      scrollUp();
    } else {
      scrollDown();
    }

    const INITIAL_DELAY = 400;
    const MIN_DELAY = 60;
    const ACCEL_TIME = 2000;

    const animate = () => {
      if (!scrollDirectionRef.current) return;

      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / ACCEL_TIME, 1);
      const currentDelay = INITIAL_DELAY - (INITIAL_DELAY - MIN_DELAY) * progress;

      if (elapsed - lastScrollTimeRef.current >= currentDelay) {
        lastScrollTimeRef.current = elapsed;
        if (scrollDirectionRef.current === 'up') {
          scrollUp();
        } else if (scrollDirectionRef.current === 'down') {
          scrollDown();
        }
      }

      if (scrollDirectionRef.current) {
        scrollIntervalRef.current = requestAnimationFrame(animate);
      }
    };

    scrollIntervalRef.current = requestAnimationFrame(animate);
  }, [scrollUp, scrollDown]);

  const stopScrolling = useCallback(() => {
    scrollDirectionRef.current = null;
    scrollStartTimeRef.current = null;
    if (scrollIntervalRef.current) {
      cancelAnimationFrame(scrollIntervalRef.current);
      scrollIntervalRef.current = null;
    }
  }, []);

  // Exit copy-mode before sending user input
  const exitCopyModeIfActive = useCallback(() => {
    if (inCopyModeRef.current) {
      sendToTerminal('\x1b\x1b'); // Double ESC to fully exit copy-mode
      inCopyModeRef.current = false;
      clearTimeout(copyModeTimeoutRef.current);
    }
  }, [sendToTerminal]);

  // Cleanup function for unmount
  const cleanup = useCallback(() => {
    if (scrollCooldownRef.current) {
      clearTimeout(scrollCooldownRef.current);
    }
    if (scrollIntervalRef.current) {
      cancelAnimationFrame(scrollIntervalRef.current);
    }
    if (copyModeTimeoutRef.current) {
      clearTimeout(copyModeTimeoutRef.current);
    }
  }, []);

  return {
    inCopyModeRef,
    isScrollingRef,
    scrollUp,
    scrollDown,
    jumpToLive,
    startScrolling,
    stopScrolling,
    exitCopyModeIfActive,
    enterCopyMode,
    cleanup
  };
}
