import { useCallback, useRef } from 'react';

/**
 * Hook to manage terminal scrolling including tmux copy-mode.
 * Provides scroll up/down, jump to live, and press-and-hold acceleration.
 */
export function useTerminalScrolling(xtermRef, sendToTerminal, usesTmuxRef) {
  const inCopyModeRef = useRef(false);
  const copyModeTimeoutRef = useRef(null);
  const isScrollingRef = useRef(false);
  const scrollCooldownRef = useRef(null);
  const scrollIntervalRef = useRef(null);
  const scrollStartTimeRef = useRef(null);
  const scrollDirectionRef = useRef(null);
  const lastScrollTimeRef = useRef(0);

  const setScrollingActive = useCallback(() => {
    isScrollingRef.current = true;
    if (scrollCooldownRef.current) {
      clearTimeout(scrollCooldownRef.current);
    }
    scrollCooldownRef.current = setTimeout(() => {
      isScrollingRef.current = false;
    }, 500);
  }, []);

  const resetCopyModeTimeout = useCallback(() => {
    if (copyModeTimeoutRef.current) {
      clearTimeout(copyModeTimeoutRef.current);
    }
    copyModeTimeoutRef.current = setTimeout(() => {
      if (!inCopyModeRef.current) return;
      sendToTerminal('q');
      inCopyModeRef.current = false;
    }, 300000);
  }, [sendToTerminal]);

  const enterCopyMode = useCallback(() => {
    if (usesTmuxRef && !usesTmuxRef.current) {
      return;
    }
    if (inCopyModeRef.current) {
      resetCopyModeTimeout();
      return;
    }
    inCopyModeRef.current = true;
    sendToTerminal('\x02[');
    resetCopyModeTimeout();
  }, [resetCopyModeTimeout, sendToTerminal]);

  const sendCopyModeKeys = useCallback((keys) => {
    if (!keys) return;
    if (usesTmuxRef && !usesTmuxRef.current) {
      return;
    }
    if (!inCopyModeRef.current) {
      inCopyModeRef.current = true;
      sendToTerminal('\x02[' + keys);
      resetCopyModeTimeout();
      return;
    }
    sendToTerminal(keys);
    resetCopyModeTimeout();
  }, [resetCopyModeTimeout, sendToTerminal, usesTmuxRef]);

  // Scroll in tmux copy-mode (shared logic for buttons and wheel)
  const scrollInTmux = useCallback((direction, lines = 5) => {
    const term = xtermRef.current;
    if (!term) return;

    setScrollingActive();

    const baseY = term.buffer?.active?.baseY || 0;

    if (baseY > 0) {
      // xterm has scrollback, use native scroll
      term.scrollLines(direction === 'up' ? -lines : lines);
    } else if (!usesTmuxRef || usesTmuxRef.current) {
      // No xterm scrollback - tmux managing it
      const key = direction === 'up' ? '\x15' : '\x04'; // Ctrl+U / Ctrl+D
      sendCopyModeKeys(key);
    }
  }, [xtermRef, sendCopyModeKeys, setScrollingActive, usesTmuxRef]);

  const scrollUp = useCallback(() => scrollInTmux('up'), [scrollInTmux]);
  const scrollDown = useCallback(() => scrollInTmux('down'), [scrollInTmux]);

  const scrollByLines = useCallback((direction, lines) => {
    const term = xtermRef.current;
    if (!term) return;

    setScrollingActive();

    const baseY = term.buffer?.active?.baseY || 0;
    const safeLines = Math.max(1, Math.min(10, Math.round(lines || 1)));

    if (baseY > 0) {
      term.scrollLines(direction === 'up' ? -safeLines : safeLines);
      return;
    }

    if (!usesTmuxRef || usesTmuxRef.current) {
      const key = direction === 'up' ? '\x1b[A' : '\x1b[B';
      sendCopyModeKeys(key.repeat(safeLines));
    }
  }, [xtermRef, sendCopyModeKeys, setScrollingActive, usesTmuxRef]);

  const scrollByWheel = useCallback((deltaY, deltaMode, rows) => {
    if (!deltaY) return;
    const term = xtermRef.current;
    if (!term) return;

    const lineHeight = 16;
    let pixels = deltaY;

    if (deltaMode === 1) {
      pixels *= lineHeight;
    } else if (deltaMode === 2) {
      pixels *= lineHeight * (rows || term.rows || 1);
    }

    const lines = Math.max(1, Math.min(10, Math.round(Math.abs(pixels) / lineHeight)));
    const direction = pixels < 0 ? 'up' : 'down';

    scrollByLines(direction, lines);
  }, [scrollByLines, xtermRef]);

  // Jump to live output - exits tmux copy-mode and scrolls xterm to bottom
  const jumpToLive = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    if (inCopyModeRef.current && (!usesTmuxRef || usesTmuxRef.current)) {
      sendToTerminal('q');
      inCopyModeRef.current = false;
      clearTimeout(copyModeTimeoutRef.current);
    }

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
    if (inCopyModeRef.current && (!usesTmuxRef || usesTmuxRef.current)) {
      sendToTerminal('q');
      inCopyModeRef.current = false;
      clearTimeout(copyModeTimeoutRef.current);
    }
  }, [sendToTerminal, usesTmuxRef]);

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
    inCopyModeRef.current = false;
  }, []);

  return {
    inCopyModeRef,
    isScrollingRef,
    scrollUp,
    scrollDown,
    scrollByWheel,
    jumpToLive,
    startScrolling,
    stopScrolling,
    exitCopyModeIfActive,
    enterCopyMode,
    cleanup
  };
}
