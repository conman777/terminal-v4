import { useRef, useEffect, useState, useCallback } from 'react';

/**
 * ReaderView - A clean, scrollable text view for terminal output
 *
 * Displays terminal content as properly-wrapped text instead of canvas rendering.
 * Supports auto-scrolling to bottom as new content arrives.
 * Supports keyboard input - keystrokes are forwarded to the terminal.
 */
export function ReaderView({ content, lines, fontSize, lineHeight, scrollToken, onScrollDirection, onViewportStateChange, onLoadMore, onInput, isMobile }) {
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastScrollTop = useRef(0);
  const scrollThrottle = useRef(null);
  const resolvedFontFamily = isMobile
    ? '"SF Mono", "Menlo", "Monaco", "Consolas", monospace'
    : 'Consolas, "Courier New", monospace';

  // Auto-scroll to bottom when content changes (if enabled)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      onViewportStateChange?.(true);
    }
  }, [content, autoScroll, onViewportStateChange]);

  // Force scroll to bottom when switching into reader view
  useEffect(() => {
    if (!scrollToken || !containerRef.current) return;
    setAutoScroll(true);
    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
        onViewportStateChange?.(true);
      }
    });
  }, [scrollToken, onViewportStateChange]);

  // Focus on mount and when switching to reader view so keyboard works
  useEffect(() => {
    if (!isMobile) return;
    const timer = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [isMobile, scrollToken]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const sendInput = useCallback((text) => {
    if (!onInput) return;
    setAutoScroll(true);
    onInput(text);
    requestAnimationFrame(scrollToBottom);
  }, [onInput, scrollToBottom]);

  // Click handler to ensure focus is maintained
  const handleClick = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    if (inputRef.current) {
      inputRef.current.focus();
      return;
    }
    containerRef.current?.focus();
  }, []);

  // Desktop keyboard handler
  const handleKeyDown = useCallback((e) => {
    if (!onInput) return;
    const targetIsInput = e.target === inputRef.current;

    // Stop propagation to prevent xterm from also handling this event
    e.stopPropagation();

    // Allow copy with Cmd/Ctrl+C when text is selected
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return; // Let browser handle copy
      }
    }

    // Allow paste with Cmd/Ctrl+V
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      e.preventDefault();
      navigator.clipboard?.readText().then((text) => {
        if (text) sendInput(text);
      }).catch(() => {});
      return;
    }

    // Handle Ctrl+key combinations (Ctrl+C for SIGINT, etc.)
    if (e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const code = e.key.toLowerCase().charCodeAt(0) - 96; // a=1, b=2, c=3...
      if (code > 0 && code < 27) {
        sendInput(String.fromCharCode(code));
      }
      return;
    }

    // Special key mappings
    const keyMap = {
      'Enter': '\r',
      'Backspace': '\x7f',
      'Tab': '\t',
      'Escape': '\x1b',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Home': '\x1b[H',
      'End': '\x1b[F',
      'Delete': '\x1b[3~',
    };

    if (keyMap[e.key]) {
      e.preventDefault();
      sendInput(keyMap[e.key]);
    } else if (!targetIsInput && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      sendInput(e.key);
    }
  }, [onInput, sendInput]);

  // Text input handler
  const handleInput = useCallback((e) => {
    if (!onInput) return;
    const value = e.target.value;
    if (value) {
      sendInput(value);
      e.target.value = ''; // Clear after sending
    }
  }, [onInput, sendInput]);

  // Detect user scroll to manage auto-scroll behavior
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Check if user is near the bottom (within 50px tolerance)
    const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    setAutoScroll(isAtBottom);
    onViewportStateChange?.(isAtBottom);

    if (onLoadMore && el.scrollTop <= 40) {
      onLoadMore();
    }

    // Report scroll direction for header collapse (mobile)
    if (onScrollDirection && !scrollThrottle.current) {
      const direction = el.scrollTop > lastScrollTop.current ? 'down' : 'up';
      onScrollDirection(direction);
      scrollThrottle.current = setTimeout(() => {
        scrollThrottle.current = null;
      }, 100);
    }
    lastScrollTop.current = el.scrollTop;
  }, [onScrollDirection]);

  // Cleanup throttle timer
  useEffect(() => {
    return () => {
      if (scrollThrottle.current) {
        clearTimeout(scrollThrottle.current);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="reader-view"
      tabIndex={0}
      onKeyDown={!isMobile ? handleKeyDown : undefined}
      onClick={handleClick}
      onScroll={handleScroll}
      style={{ fontSize: fontSize || 14, fontFamily: resolvedFontFamily }}
    >
      <pre
        className="reader-view-content"
        style={lineHeight ? { lineHeight: `${lineHeight}px` } : undefined}
      >
        {Array.isArray(lines) && lines.length > 0
          ? lines.map((lineSegments, index) => {
            const needsNewline = index < lines.length - 1;
            if (!Array.isArray(lineSegments)) {
              return (
                <span key={index}>
                  {lineSegments}
                  {needsNewline ? '\n' : ''}
                </span>
              );
            }
            return (
              <span key={index}>
                {lineSegments.map((segment, segmentIndex) => (
                  <span
                    key={`${index}-${segmentIndex}`}
                    className={segment.isCursor ? 'reader-view-cursor' : undefined}
                    style={segment.style}
                  >
                    {segment.text}
                  </span>
                ))}
                {needsNewline ? '\n' : ''}
              </span>
            );
          })
          : content}
      </pre>

      {/* Hidden input for keyboard capture */}
      <input
        ref={inputRef}
        type="text"
        inputMode="text"
        enterKeyHint="send"
        className="reader-view-mobile-input"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck="false"
      />
    </div>
  );
}
